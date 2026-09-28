// Builds assets/litearm.ico from the PNGs rendered by render-icon-png.mjs.
//
// Why this exists: the repository ships `assets/icon-source.svg` (the same mark
// the console's sidebar draws) but no Windows icon, and without `--icon`
// PyInstaller embeds its own default one — which is why the released program
// showed a generic Python icon.
//
// Format: sizes up to 64px are stored as 32-bit DIBs (the classic layout, what
// the shell reads for the taskbar and list views), 128 and 256 are stored as
// PNGs (what Explorer reads for the large and extra-large views). This is the
// layout mainstream icon files use; the pure-PNG form is also legal, but the
// mixed one is what every tool round-trips without argument.
//
//   node scripts/render-icon-png.mjs && node scripts/make-icon.mjs
//
// The generated `assets/litearm.ico` is committed, so ordinary builds and the
// release workflow never run this.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = process.env.ICON_PNG_DIR || resolve(ROOT, 'assets', 'icon-png')
const OUT = resolve(ROOT, 'assets', 'litearm.ico')

/** Sizes the Windows shell asks for; 256 is the "extra large" view. */
const SIZES = [16, 24, 32, 48, 64, 128, 256]
/** Sizes stored as PNG; everything below is stored as a DIB. */
const PNG_FROM = 128

/** Minimal PNG reader, limited to the 8-bit RGBA files Chromium writes. */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  const idat = []
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos)
    const type = buffer.toString('ascii', pos + 4, pos + 8)
    const data = buffer.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const depth = data.readUInt8(8)
      const colorType = data.readUInt8(9)
      const interlace = data.readUInt8(12)
      if (depth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(`unsupported PNG (depth=${depth} color=${colorType} interlace=${interlace})`)
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))

  // Undo the per-scanline filters (PNG spec §9). Each row is 1 filter byte +
  // width*4 bytes of RGBA.
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const cur = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? cur[x - 4] : 0
      const b = prev[x]
      const c = x >= 4 ? prev[x - 4] : 0
      let value = src[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) {
        throw new Error(`unknown PNG filter ${filter}`)
      }
      cur[x] = value & 0xff
    }
  }
  return { width, height, pixels }
}

/**
 * Packs RGBA pixels into the DIB an ICO entry holds: a BITMAPINFOHEADER whose
 * height field counts the XOR image *and* the AND mask, then the bottom-up BGRA
 * rows, then the 1-bit mask (opaque everywhere — alpha does the real work, but
 * the mask must still be present and correctly sized).
 */
function encodeDib({ width, height, pixels }) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(width, 4)
  header.writeInt32LE(height * 2, 8) // XOR + AND
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // BI_RGB
  const xorSize = width * height * 4
  const maskStride = Math.ceil(width / 32) * 4
  header.writeUInt32LE(xorSize, 20)

  const xor = Buffer.alloc(xorSize)
  for (let y = 0; y < height; y++) {
    const srcRow = height - 1 - y // DIB rows run bottom-up
    for (let x = 0; x < width; x++) {
      const s = (srcRow * width + x) * 4
      const d = (y * width + x) * 4
      xor[d] = pixels[s + 2] // B
      xor[d + 1] = pixels[s + 1] // G
      xor[d + 2] = pixels[s] // R
      xor[d + 3] = pixels[s + 3] // A
    }
  }
  return Buffer.concat([header, xor, Buffer.alloc(maskStride * height)])
}

const images = SIZES.map((size) => {
  const png = readFileSync(resolve(SRC_DIR, `icon-${size}.png`))
  const decoded = decodePng(png)
  if (decoded.width !== size || decoded.height !== size) {
    throw new Error(`icon-${size}.png is ${decoded.width}x${decoded.height}, expected ${size}x${size}`)
  }
  const data = size >= PNG_FROM ? png : encodeDib(decoded)
  const format = size >= PNG_FROM ? 'png' : 'dib'
  return { size, data, format }
})

/** 256 is encoded as 0: a single byte cannot hold the value. */
const dimensionByte = (size) => (size >= 256 ? 0 : size)

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: 1 = icon
header.writeUInt16LE(images.length, 4)

let offset = 6 + images.length * 16
const entries = []
for (const { size, data } of images) {
  const entry = Buffer.alloc(16)
  entry.writeUInt8(dimensionByte(size), 0) // width
  entry.writeUInt8(dimensionByte(size), 1) // height
  entry.writeUInt8(0, 2) // palette colours (0 = none)
  entry.writeUInt8(0, 3) // reserved
  entry.writeUInt16LE(1, 4) // colour planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(data.length, 8)
  entry.writeUInt32LE(offset, 12)
  entries.push(entry)
  offset += data.length
}

const out = Buffer.concat([header, ...entries, ...images.map((i) => i.data)])
writeFileSync(OUT, out)
console.log(
  `wrote ${OUT} (${out.length} bytes) — ` +
    images.map((i) => `${i.size}:${i.format}`).join(' '),
)
