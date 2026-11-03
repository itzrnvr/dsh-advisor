// Minimal Chrome DevTools Protocol driver (no dependencies).
// Usage:
//   node tools/cdp.mjs list
//   node tools/cdp.mjs shot <out.png> [--url <substring>] [--full]
//   node tools/cdp.mjs eval <expression> [--url <substring>]
//   node tools/cdp.mjs click <x> <y> [--url <substring>]
//   node tools/cdp.mjs scroll <x> <y> <dy> [--url <substring>]
//   node tools/cdp.mjs reload [--url <substring>]
const PORT = process.env.CDP_PORT || '9335'

// The host's inner browser Chrome comes and goes (it is launched on demand
// and closes when idle), so the target list is fetched with a retry.
async function fetchTargets(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (response.ok) return await response.json()
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
  throw new Error(`no CDP target on ${PORT} after ${timeoutMs}ms: ${lastError?.message ?? 'unknown'}`)
}

const list = await fetchTargets()
const pages = list.filter((t) => t.type === 'page' && !t.url.startsWith('chrome://'))
if (process.argv[2] === 'list') {
  for (const p of pages) console.log(`${p.id}\t${p.title}\t${p.url}`)
  process.exit(0)
}
const pick = (urlSub) => {
  const hits = pages.filter((p) => !urlSub || p.url.includes(urlSub))
  if (hits.length === 0) {
    console.error('no page matches', urlSub)
    process.exit(2)
  }
  return hits[0]
}
const flag = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}

const target = pick(flag('--url', '127.0.0.1'))
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const messageId = ++id
  pending.set(messageId, { resolve, reject })
  ws.send(JSON.stringify({ id: messageId, method, params }))
})
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
}
await new Promise((resolve) => { ws.onopen = resolve })

const command = process.argv[2]
if (command === 'shot') {
  const out = process.argv[3]
  const full = process.argv.includes('--full')
  const params = { format: 'png' }
  if (full) params.captureBeyondViewport = true
  const { data } = await send('Page.captureScreenshot', params)
  const fs = await import('node:fs')
  fs.writeFileSync(out, Buffer.from(data, 'base64'))
  console.log('saved', out)
} else if (command === 'eval') {
  const expression = process.argv[3]
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  console.log(JSON.stringify(result.result?.value ?? result.exceptionDetails ?? result, null, 2))
} else if (command === 'click') {
  const x = Number(process.argv[3])
  const y = Number(process.argv[4])
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  console.log('clicked', x, y)
} else if (command === 'scroll') {
  const x = Number(process.argv[3])
  const y = Number(process.argv[4])
  const dy = Number(process.argv[5])
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy })
  console.log('scrolled', dy)
} else if (command === 'reload') {
  // GUARD: this page is the user's real surface. A reload can wipe an
  // in-progress draft, so refuse when the composer holds text.
  const draft = await send('Runtime.evaluate', {
    expression: `(() => { const el = document.querySelector('textarea,[contenteditable="true"]'); return el ? (el.value ?? el.textContent ?? '') : '' })()`,
    returnByValue: true,
  })
  const text = String(draft.result?.value ?? '').trim()
  if (text.length > 0) {
    console.error(`reload refused: the composer holds ${text.length} characters of draft`)
    process.exit(3)
  }
  await send('Page.reload', { ignoreCache: false })
  console.log('reloaded')
} else if (command === 'clickText') {
  // DOM-targeted click: find the element by its text and click it in the page.
  // Raw coordinates have missed before (the Stats tab at 558,139).
  const needle = process.argv[3]
  const result = await send('Runtime.evaluate', {
    expression: `(() => {
      const needle = ${JSON.stringify(needle)};
      const nodes = [...document.querySelectorAll('button,[role="tab"],a,span,div')];
      const hit = nodes.reverse().find((el) => (el.textContent || '').trim() === needle && el.getBoundingClientRect().width > 0);
      if (!hit) return 'not found: ' + needle;
      hit.scrollIntoView({ block: 'center' });
      hit.click();
      return 'clicked: ' + needle;
    })()`,
    returnByValue: true,
  })
  const value = String(result.result?.value ?? '')
  console.log(value)
  if (value.startsWith('not found')) {
    // FAIL FAST: a missed click must stop a &&-chained caller instead of
    // producing an empty pane that reads like a real result.
    console.error('clickText: ' + value)
    ws.close()
    process.exit(4)
  }
} else if (command === 'waitText') {
  // Poll until the text appears (or the timeout passes) — the conversation
  // view restores asynchronously, so a fixed sleep is racy.
  const needle = process.argv[3]
  const timeoutMs = Number(process.argv[4] ?? 20000)
  const deadline = Date.now() + timeoutMs
  let found = false
  while (Date.now() < deadline) {
    const result = await send('Runtime.evaluate', {
      expression: `(() => { const n = ${JSON.stringify(needle)}; return [...document.querySelectorAll('button,[role="tab"],a,span,div')].some((el) => (el.textContent || '').trim() === n && el.getBoundingClientRect().width > 0) })()`,
      returnByValue: true,
    })
    if (result.result?.value === true) { found = true; break }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  console.log(found ? `found: ${needle}` : `timeout: ${needle}`)
  if (!found) {
    console.error('waitText: timed out waiting for ' + needle)
    ws.close()
    process.exit(5)
  }
} else {
  console.error('unknown command', command)
  process.exit(1)
}
ws.close()
