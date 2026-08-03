// gen-icon.mts — synthesize the app icon with ZERO dependencies: a 256x256 RGBA
// bitmap (dark background + a gold "EQ" glyph) encoded to PNG by hand (zlib is in
// Node core), then wrapped into a multi-size .ico. Run:
//
//   export PATH="/c/Program Files/nodejs:$PATH"   # this machine
//   npx tsx scripts/gen-icon.mts
//
// Outputs build/icon.png (256x256, for reference/Linux) and build/icon.ico (the
// Windows app + installer icon electron-builder consumes). The .ico embeds PNG-
// compressed frames at 256/128/64/48/32/16 px — Windows Vista+ and NSIS both read
// PNG-in-ICO frames, so we avoid hand-rolling legacy BMP frames.
//
// Committed + permanent: build/icon.ico is the shipped brand mark. Re-run to
// regenerate after editing the glyph. We deliberately draw an ORIGINAL mark (no
// game art): a dark rounded panel with a gold serif-ish "EQ".

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type RGBA = [number, number, number, number]

const BG: RGBA = [15, 17, 21, 255] // #0f1115 — matches the app window background
const PANEL: RGBA = [26, 30, 38, 255] // slightly lighter inner panel
const GOLD: RGBA = [214, 175, 92, 255] // #d6af5c — the EQ gold glyph
const GOLD_HI: RGBA = [240, 208, 130, 255]

/** A simple RGBA canvas with a handful of primitive fills. */
class Canvas {
  readonly w: number
  readonly h: number
  private px: Uint8Array
  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    this.px = new Uint8Array(w * h * 4)
  }
  set(x: number, y: number, c: RGBA): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 4
    // Source-over alpha blend so anti-aliased edges look right on the panel.
    const a = c[3] / 255
    const ia = 1 - a
    this.px[i] = Math.round(c[0] * a + this.px[i] * ia)
    this.px[i + 1] = Math.round(c[1] * a + this.px[i + 1] * ia)
    this.px[i + 2] = Math.round(c[2] * a + this.px[i + 2] * ia)
    this.px[i + 3] = 255
  }
  fill(c: RGBA): void {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.set(x, y, c)
  }
  /** Filled rounded rectangle. */
  roundRect(x0: number, y0: number, x1: number, y1: number, r: number, c: RGBA): void {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        // Distance into a corner: only clip if inside the corner arc region.
        const dx = x < x0 + r ? x0 + r - x : x > x1 - 1 - r ? x - (x1 - 1 - r) : 0
        const dy = y < y0 + r ? y0 + r - y : y > y1 - 1 - r ? y - (y1 - 1 - r) : 0
        if (dx * dx + dy * dy <= r * r) this.set(x, y, c)
      }
    }
  }
  /** Stroke a ring (for the "Q" and "E" strokes) via two filled discs' difference. */
  disc(cx: number, cy: number, rOuter: number, rInner: number, c: RGBA): void {
    const r2o = rOuter * rOuter
    const r2i = rInner * rInner
    for (let y = Math.floor(cy - rOuter); y <= Math.ceil(cy + rOuter); y++) {
      for (let x = Math.floor(cx - rOuter); x <= Math.ceil(cx + rOuter); x++) {
        const d = (x - cx) * (x - cx) + (y - cy) * (y - cy)
        if (d <= r2o && d >= r2i) this.set(x, y, c)
      }
    }
  }
  rect(x0: number, y0: number, x1: number, y1: number, c: RGBA): void {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.set(x, y, c)
  }
  /** Nearest-neighbour downscale to a new Canvas (for the small ICO frames). */
  scaleTo(nw: number, nh: number): Canvas {
    const out = new Canvas(nw, nh)
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const sx = Math.min(this.w - 1, Math.floor((x / nw) * this.w))
        const sy = Math.min(this.h - 1, Math.floor((y / nh) * this.h))
        const i = (sy * this.w + sx) * 4
        const j = (y * nw + x) * 4
        out.px[j] = this.px[i]
        out.px[j + 1] = this.px[i + 1]
        out.px[j + 2] = this.px[i + 2]
        out.px[j + 3] = this.px[i + 3]
      }
    }
    return out
  }
  raw(): Uint8Array {
    return this.px
  }
}

// --- minimal PNG encoder (RGBA, no filtering) ---
function crc32(buf: Uint8Array): number {
  let c = ~0
  for (let n = 0; n < buf.length; n++) {
    c ^= buf[n]
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([typeBytes, Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
function encodePng(cv: Canvas): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(cv.w, 0)
  ihdr.writeUInt32BE(cv.h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  const px = cv.raw()
  // Prepend a 0 filter byte to each scanline.
  const stride = cv.w * 4
  const raw = Buffer.alloc((stride + 1) * cv.h)
  for (let y = 0; y < cv.h; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(px.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Draw the 256x256 master icon. */
function drawMaster(): Canvas {
  const S = 256
  const cv = new Canvas(S, S)
  cv.fill(BG)
  // Rounded inner panel with a subtle border.
  cv.roundRect(16, 16, S - 16, S - 16, 40, [58, 48, 26, 255]) // gold-ish border
  cv.roundRect(20, 20, S - 20, S - 20, 36, PANEL)

  // "EQC" glyph (was "EQ" — the two-letter mark read as plain "EverQuest", which is
  // exactly the confusion the app must not invite; EQC is the app's own identity).
  // Three narrower letterforms sharing the E/Q language: gold with highlight accents.
  const strokeW = 12
  // One shared cap height (72px) for all three letters — the first draft kept the old
  // 100px E beside 64px rings and read as "Eqc".
  const top = 88
  const bot = 168
  const midY = (top + bot) / 2 // 128

  // --- E ---
  const eX = 28
  const eW = 44
  cv.rect(eX, top, eX + strokeW, bot, GOLD) // vertical spine
  cv.rect(eX, top, eX + eW, top + strokeW, GOLD) // top bar
  cv.rect(eX, midY - strokeW / 2, eX + eW - 7, midY + strokeW / 2, GOLD) // mid bar
  cv.rect(eX, bot - strokeW, eX + eW, bot, GOLD) // bottom bar
  cv.rect(eX, top, eX + 4, bot, GOLD_HI) // highlight along the spine

  // --- Q ---
  const qcx = 120
  const qR = 40
  cv.disc(qcx, midY, qR, qR - strokeW, GOLD) // ring
  cv.disc(qcx, midY, qR, qR - 4, GOLD_HI) // thin bright outer edge
  cv.disc(qcx, midY, qR - strokeW + 4, qR - strokeW, [58, 48, 26, 255]) // inner shadow edge
  // Q tail (short diagonal, sized to stop before the C's ring)
  for (let t = 0; t < 14; t++) {
    cv.rect(qcx + 14 + t, midY + 14 + t, qcx + 14 + t + strokeW, midY + 14 + t + strokeW, GOLD)
  }

  // --- C --- (the Q's ring with its right side opened — erased back to panel color)
  const ccx = 200
  const cR = 40
  cv.disc(ccx, midY, cR, cR - strokeW, GOLD)
  cv.disc(ccx, midY, cR, cR - 4, GOLD_HI)
  cv.disc(ccx, midY, cR - strokeW + 4, cR - strokeW, [58, 48, 26, 255])
  cv.rect(ccx + 12, midY - 14, ccx + cR + 2, midY + 14, PANEL) // the C's opening
  return cv
}

// --- ICO container: PNG-in-ICO frames ---
function buildIco(frames: { size: number; png: Buffer }[]): Buffer {
  const count = frames.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type 1 = icon
  header.writeUInt16LE(count, 4)
  const dirEntries: Buffer[] = []
  const images: Buffer[] = []
  let offset = 6 + count * 16
  for (const f of frames) {
    const e = Buffer.alloc(16)
    e[0] = f.size >= 256 ? 0 : f.size // width (0 = 256)
    e[1] = f.size >= 256 ? 0 : f.size // height
    e[2] = 0 // palette
    e[3] = 0 // reserved
    e.writeUInt16LE(1, 4) // color planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(f.png.length, 8) // size of image data
    e.writeUInt32LE(offset, 12) // offset
    offset += f.png.length
    dirEntries.push(e)
    images.push(f.png)
  }
  return Buffer.concat([header, ...dirEntries, ...images])
}

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'build')
mkdirSync(outDir, { recursive: true })

const master = drawMaster()
const masterPng = encodePng(master)
writeFileSync(join(outDir, 'icon.png'), masterPng)

const sizes = [256, 128, 64, 48, 32, 16]
const frames = sizes.map((size) => ({
  size,
  png: encodePng(size === 256 ? master : master.scaleTo(size, size))
}))
const ico = buildIco(frames)
writeFileSync(join(outDir, 'icon.ico'), ico)

console.log(`wrote build/icon.png (${masterPng.length} bytes, 256x256)`)
console.log(`wrote build/icon.ico (${ico.length} bytes, frames: ${sizes.join('/')})`)
