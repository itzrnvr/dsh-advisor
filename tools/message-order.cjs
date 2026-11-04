// Ordered message list: every user/message, assistant/message and turn/step
// boundary in log order, with the source kind and a short excerpt. Shows
// exactly how advisor notes interleave with the conversation.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decode(dir) {
  const raw = fs.readFileSync(path.join(dir, 'session.v4.jsonl.zstd'))
  const s = []
  let p = 0
  while (true) {
    const a = raw.indexOf(MAGIC, p)
    if (a < 0) break
    s.push(a)
    p = a + 1
  }
  const parts = s.map((f, i) => {
    try { return zlib.zstdDecompressSync(raw.subarray(f, i + 1 < s.length ? s[i + 1] : raw.length)) } catch { return Buffer.alloc(0) }
  })
  const evs = []
  for (const l of Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean)) {
    try { const e = JSON.parse(l); if (e.type !== 'session') evs.push(e) } catch {}
  }
  return evs
}

const IST = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
const clip = (t, n = 72) => (t ?? '').replace(/\s+/g, ' ').slice(0, n)
const textOf = (data) => (data?.content ?? []).map((c) => c.text ?? '').join(' ')

const tail = Number(process.argv[2] ?? 40)
for (const dir of process.argv.slice(3)) {
  const evs = decode(dir)
  const rows = []
  let currentTurn = null
  for (const e of evs) {
    if (e.type === 'turn/start') { currentTurn = e.data?.turn; continue }
    if (e.type === 'turn/end') {
      rows.push({ seq: e.seq, t: e.time, tag: `turn/end ${e.data?.reason?.kind ?? '?'}`, turn: e.data?.turn, txt: '' })
      continue
    }
    if (e.type === 'step/end') { rows.push({ seq: e.seq, t: e.time, tag: 'step-end', turn: currentTurn, txt: '' }); continue }
    if (e.type === 'user/message') {
      const kind = e.data?.source?.kind ?? '?'
      const txt = textOf(e.data)
      const label = kind === 'advisor' ? 'NOTE' : kind === 'user' ? 'USER' : `msg:${kind}`
      rows.push({ seq: e.seq, t: e.time, tag: label, turn: currentTurn, txt })
      continue
    }
    if (e.type === 'assistant/message') {
      rows.push({ seq: e.seq, t: e.time, tag: 'AGENT', turn: currentTurn, txt: textOf(e.data?.message ?? e.data) })
    }
  }
  console.log('\n========================', path.basename(dir), '| messages:', rows.length, '| showing last', tail)
  for (const r of rows.slice(-tail)) {
    const stepMark = r.tag === 'step-end' ? '·' : r.tag
    console.log(
      String(r.seq).padStart(6), IST(r.t), '|',
      (r.turn ?? '-').toString().padStart(3), '|',
      stepMark.padEnd(10), '|', clip(r.txt),
    )
  }
}
