// Seed a throwaway session log for GUI verification: one CLOSED turn with a
// committed advisor note (must render in that turn's tail) and one OPEN turn
// with a mid-turn note (must render in the dock strip). Event shapes are the
// host-verified real ones (user/message data IS the message; assistant wraps).
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const home = process.argv[2]
const cwd = process.argv[3] || path.join(home, 'work')
fs.mkdirSync(cwd, { recursive: true })
const winSlug = '--' + cwd.replace(/[\\/:]+/g, '-') + '--'
const sessionId = 'session-guitest1'
const dir = path.join(home, 'sessions', winSlug, sessionId)
fs.mkdirSync(dir, { recursive: true })

let seq = 0
let time = Date.now() - 600_000
const ev = (type, data, surfaceOp) => {
  const e = { type, seq: seq++, time: (time += 1000), data }
  if (surfaceOp !== undefined) e.surfaceOp = surfaceOp
  return e
}
const header = {
  type: 'session', version: 4, id: sessionId, createdAt: time, cwd,
  isSeeded: false, delegationDepth: 0,
}
const human = (text) => ev('user/message', {
  id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' },
}, 'append')
const advisor = (text, severity) => ev('user/message', {
  id: `n-${text}`, role: 'user', content: [{ type: 'text', text: `[advisor:${severity}] ${text}` }],
  source: { kind: 'advisor', form: 'notice', summary: `[${severity}] ${text}` },
}, 'append')
const assistant = (text, turn, step) => ev('assistant/message', {
  turn, step,
  message: { id: `a-${text}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
}, 'append')

const events = [
  header,
  ev('turn/start', { turn: 1 }),
  human('fix the bug'),
  ev('step/start', { turn: 1, step: 1 }),
  assistant('done, tests pass', 1, 1),
  ev('step/end', { turn: 1, step: 1 }),
  ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  advisor('check the edge case in parse()', 'concern'),   // closed turn 1 -> turn tail
  ev('turn/start', { turn: 2 }),
  human('now the second thing'),
  ev('step/start', { turn: 2, step: 1 }),
  assistant('working on it', 2, 1),
  advisor('open-turn note: cache the lookup', 'nit'),      // open turn 2 -> dock strip
]

const jsonl = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(jsonl, 'utf8')))
console.log('seeded', path.join(dir, 'session.v4.jsonl.zstd'), '| slug', winSlug, '| events', events.length)
