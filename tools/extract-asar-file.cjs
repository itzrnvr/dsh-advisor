// Extract one file from the DSH app.asar by in-archive path.
// Usage: node tools/extract-asar-file.cjs <asar/path/inside> <out-file>
const fs = require('fs')

const asar = 'C:/Users/babys/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const target = process.argv[2]
const outFile = process.argv[3]

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
if (node.files) {
  console.log(Object.keys(node.files).join('\n'))
  fs.closeSync(fd)
  return
}
const buf = Buffer.alloc(node.size)
fs.readSync(fd, buf, 0, node.size, dataStart + Number(node.offset))
fs.writeFileSync(outFile, buf)
fs.closeSync(fd)
console.log('extracted', outFile, buf.length)
