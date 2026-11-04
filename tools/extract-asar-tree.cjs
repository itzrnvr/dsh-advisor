// Extract a whole subtree from the DSH app.asar into a destination folder.
// Usage: node tools/extract-asar-tree.cjs <asar/path/inside> <dest-dir>
const fs = require('fs')
const path = require('path')

const asar = 'C:/Users/babys/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const target = process.argv[2]
const dest = process.argv[3]

const fd = fs.openSync(asar, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(headerSize)
fs.readSync(fd, headerBuf, 0, headerSize, 16)
const header = JSON.parse(headerBuf.toString('utf8'))
const dataStart = 16 + headerSize

let node = header
for (const part of target.split('/').filter(Boolean)) {
  node = node.files?.[part]
  if (node === undefined) throw new Error('not found: ' + part)
}

let files = 0
let bytes = 0
function walk(current, prefix, out) {
  for (const [name, entry] of Object.entries(current.files ?? {})) {
    const rel = prefix ? prefix + '/' + name : name
    if (entry.files) walk(entry, rel, out)
    else if (entry.size !== undefined && entry.offset !== undefined) out.push({ rel, entry })
  }
}
const list = []
walk(node, '', list)
for (const { rel, entry } of list) {
  const outPath = path.join(dest, rel)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const buf = Buffer.alloc(entry.size)
  fs.readSync(fd, buf, 0, entry.size, dataStart + Number(entry.offset))
  fs.writeFileSync(outPath, buf)
  files += 1
  bytes += entry.size
}
fs.closeSync(fd)
console.log(`extracted ${files} files, ${(bytes / 1048576).toFixed(1)} MB -> ${dest}`)
