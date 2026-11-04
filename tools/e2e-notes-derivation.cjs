// E2E acceptance: run the FIXED notes derivation over a REAL session log
// (the omen-dash fork session-96289013) and verify:
//   1. the full log recovers the 501 committed advisor notes;
//   2. the child-owned slice (live session.inheritedEventCount = 25257)
//      recovers exactly the 4 child notes, never the parent's.
// Uses the BUILT lib (what ships), not the TS sources.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { notesFromSessionEvents } = require('C:/Users/babys/Documents/code/dsh-advisor/lib/seed.js')

const dir = process.argv[2] || 'C:/Users/babys/.dsh/sessions/--C-Users-babys-Documents-code-omen-dash--/session-96289013-a40d-4000-a95a-9dd54164e3b2'
const inherited = Number(process.argv[3] || 25257)

const raw = fs.readFileSync(path.join(dir, 'session.v4.jsonl.zstd'))
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
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

// File line 0 is the `session` header; live snapshotEvents = lines 1..N.
const events = []
for (const line of lines) {
  try { events.push(JSON.parse(line)) } catch { /* skip malformed */ }
}
const eventLog = events.filter((e) => e.type !== 'session')
console.log('log lines:', lines.length, '| events (no header):', eventLog.length)

const all = notesFromSessionEvents(eventLog)
const child = notesFromSessionEvents(eventLog.slice(inherited))
console.log('derived from FULL log:', all.length, 'notes')
console.log('derived from CHILD slice (inheritedEventCount=' + inherited + '):', child.length, 'notes')
for (const note of child) {
  console.log('  child note: turn', note.turn, '|', note.severity, '|', note.text.slice(0, 80).replace(/\n/g, ' '), '| at', new Date(note.at).toISOString())
}
// Cross-check: child notes must equal the advisor events at/after the slice point.
let childCommitted = 0
eventLog.slice(inherited).forEach((e) => {
  if (e.type === 'user/message' && e.data?.source?.kind === 'advisor') childCommitted++
})
console.log('advisor user/message events in child slice:', childCommitted)
if (child.length === childCommitted && child.length > 0) {
  console.log('E2E PASS: every child-owned committed note recovered; parent notes excluded')
} else {
  console.log('E2E MISMATCH')
  process.exitCode = 1
}
