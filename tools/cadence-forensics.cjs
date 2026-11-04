// Cadence forensics: reconstruct turns/steps/notes for two real sessions and
// measure the step gaps BETWEEN advisor notes (the thing the user suspects).
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const dirs = process.argv.slice(2)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decode(dir) {
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const raw = fs.readFileSync(file)
  const starts = []
  let pos = 0
  while (true) {
    const at = raw.indexOf(MAGIC, pos)
    if (at < 0) break
    starts.push(at)
    pos = at + 1
  }
  const parts = []
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : raw.length
    try { parts.push(zlib.zstdDecompressSync(raw.subarray(from, to))) } catch {}
  }
  const lines = Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean)
  const events = []
  for (const line of lines) {
    try { const e = JSON.parse(line); if (e.type !== 'session') events.push(e) } catch {}
  }
  return events
}

for (const dir of dirs) {
  const events = decode(dir)
  console.log('\n====================', path.basename(dir))
  console.log('events:', events.length)

  // advisor notes: user/message with source.kind === 'advisor'
  const NOTES = /^\[advisor:(nit|concern|blocker)\] ([\s\S]*)$/
  const notes = []
  const stepEnds = [] // seq/time of completed steps
  const turnEnds = []
  const lastActivity = []
  for (const e of events) {
    if (e.type === 'step/end') stepEnds.push({ seq: e.seq, time: e.time })
    if (e.type === 'turn/end') turnEnds.push({ seq: e.seq, time: e.time, kind: e.data?.reason?.kind })
    if (e.type === 'user/message') {
      const src = e.data?.source?.kind
      if (src === 'advisor') {
        const text = (e.data?.content ?? []).map((c) => c.text ?? '').join('')
        const m = NOTES.exec(text.trim())
        notes.push({ seq: e.seq, time: e.time, severity: m?.[1], text: (m?.[2] ?? text).slice(0, 60).replace(/\n/g, ' ') })
      } else if (src === 'user') {
        lastActivity.push({ seq: e.seq, time: e.time, what: 'HUMAN' })
      }
    }
    if (e.type === 'assistant/message') {
      const last = lastActivity[lastActivity.length - 1]
      if (last && last.what === 'HUMAN') last.what = 'HUMAN+REPLY'
    }
  }
  console.log('steps completed:', stepEnds.length, '| turns closed:', turnEnds.length, '| advisor notes:', notes.length)

  // gaps between consecutive notes measured in step/ends and seconds
  let prev = null
  const gaps = []
  for (const n of notes) {
    if (prev) {
      const stepsBetween = stepEnds.filter((s) => s.seq > prev.seq && s.seq < n.seq).length
      const turnsBetween = turnEnds.filter((t) => t.seq > prev.seq && t.seq < n.seq).length
      const dt = (n.time - prev.time) / 1000
      gaps.push({ from: prev.text, to: n.text, stepsBetween, turnsBetween, dt })
    }
    prev = n
  }
  const zeroStep = gaps.filter((g) => g.stepsBetween === 0)
  console.log('consecutive-note pairs with 0 completed steps between:', zeroStep.length, '/', gaps.length)
  for (const g of zeroStep.slice(0, 12)) {
    console.log(`  gap[0 steps, ${g.turnsBetween} turn-ends, ${g.dt.toFixed(0)}s]: "${g.from}" -> "${g.to}"`)
  }
  const histogram = {}
  for (const g of gaps) histogram[g.stepsBetween] = (histogram[g.stepsBetween] ?? 0) + 1
  console.log('steps-between-notes histogram:', JSON.stringify(histogram))

  // last note vs last event
  const lastEv = events[events.length - 1]
  console.log('last event:', lastEv?.type, '@', lastEv?.time ? new Date(lastEv.time).toISOString() : '?')
  const lastNote = notes[notes.length - 1]
  if (lastNote) console.log('last note:', new Date(lastNote.time).toISOString(), '|', lastNote.severity, '|', lastNote.text)

  // timeline tail: last 14 interesting events
  const tail = events.filter((e) => ['turn/start', 'turn/end', 'step/end', 'user/message', 'model/request'].includes(e.type)).slice(-14)
  for (const e of tail) {
    const d = new Date(e.time).toISOString().slice(11, 19)
    if (e.type === 'user/message') {
      const text = (e.data?.content ?? []).map((c) => c.text ?? '').join('')
      console.log(`  ${d} user/message src=${e.data?.source?.kind} :: ${text.slice(0, 60).replace(/\n/g, ' ')}`)
    } else {
      console.log(`  ${d} ${e.type}${e.data?.turn !== undefined ? ` turn=${e.data.turn}` : ''}${e.data?.reason?.kind ? ` (${e.data.reason.kind})` : ''}`)
    }
  }
}
