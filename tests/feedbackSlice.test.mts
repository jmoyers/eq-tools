// The feedback log slicer (src/main/feedback/slice.ts).
//
// EVERY FIXTURE HERE IS SYNTHESIZED INTO A TEMP DIR. The real game log is never read, never
// opened, and never named by this suite — the app opens it read-only and a test has even less
// business near it. One test below additionally PROVES the read-only contract by hashing the
// synthetic log before and after a build.
//
// No Electron, no network, no committed fixtures, so this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { MAX_SLICE_LINES, MAX_UPLOAD_BYTES, PREVIEW_MAX_LINES } from '../src/shared/feedback'
import { anchorMs, buildSlice, lineTs, previewOf, TAIL_READ_CAP } from '../src/main/feedback/slice'

// ---- synthetic-log helpers ---------------------------------------------------------------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number): string => String(n).padStart(2, '0')

/** `[Sat Aug 01 13:00:28 2026]` — the real prefix, in LOCAL time (parseEqTimestamp's base). */
function stamp(ms: number): string {
  const d = new Date(ms)
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return `[${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${pad(d.getDate())} ${hms} ${d.getFullYear()}]`
}

const at = (ms: number, text: string): string => `${stamp(ms)} ${text}`

/** A fixed, deliberately-not-now anchor: Sat Aug 01 2026 14:32:00 local. */
const ANCHOR = new Date(2026, 7, 1, 14, 32, 0).getTime()
const MIN = 60_000

interface Fixture {
  dir: string
  path: string
}

function writeLog(lines: readonly string[]): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-feedback-slice-'))
  const path = join(dir, 'eqlog_Testchar_freeport.txt')
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  return { dir, path }
}

const cleanup = (fx: Fixture): void => {
  rmSync(fx.dir, { recursive: true, force: true })
}

// ---- pure helpers -------------------------------------------------------------------------

test('lineTs / anchorMs read the log prefix and nothing else', () => {
  assert.equal(lineTs(at(ANCHOR, 'You slash a gnoll for 120 points of damage.')), ANCHOR)
  assert.equal(lineTs('no prefix at all'), 0)
  assert.equal(lineTs('[not a timestamp] hello'), 0)
  assert.equal(lineTs(''), 0)
  // The anchor is the LAST timestamped line, ignoring trailing continuations.
  assert.equal(
    anchorMs([
      { ts: 1, line: 'a' },
      { ts: 5, line: 'b' },
      { ts: 0, line: 'c' }
    ]),
    5
  )
  assert.equal(anchorMs([{ ts: 0, line: 'x' }]), 0)
})

// ---- the window ---------------------------------------------------------------------------

test('the window is anchored on the LAST LINE, never on Date.now()', async () => {
  // The whole log is HOURS old — a wall-clock window would return nothing at all, which is
  // exactly the "I alt-tabbed out twenty minutes ago" case this rule exists for.
  const lines = [
    at(ANCHOR - 90 * MIN, 'You have entered Plane of Sky.'),
    at(ANCHOR - 45 * MIN, 'You slash a gnoll for 100 points of damage.'),
    at(ANCHOR - 20 * MIN, 'You slash a gnoll for 200 points of damage.'),
    at(ANCHOR - 1 * MIN, 'You have slain a gnoll!'),
    at(ANCHOR, 'You gain experience!')
  ]
  const fx = writeLog(lines)
  try {
    const slice = await buildSlice({ logPath: fx.path, windowMinutes: 30 })
    assert.ok(slice, 'a 30-minute window on an hours-old log must not be empty')
    // Only the three lines inside [anchor-30m, anchor].
    assert.equal(slice.lines, 3)
    assert.equal(slice.fromMs, ANCHOR - 20 * MIN)
    assert.equal(slice.toMs, ANCHOR)
    assert.equal(slice.dropped, 0)
    assert.ok(!slice.text.includes('entered Plane of Sky'))
    assert.ok(slice.text.includes('You gain experience!'))
  } finally {
    cleanup(fx)
  }
})

test('continuation lines are kept only BETWEEN two in-window lines', async () => {
  const fx = writeLog([
    at(ANCHOR - 40 * MIN, 'You have entered Plane of Sky.'),
    'a fragment before the window, orphaned',
    at(ANCHOR - 10 * MIN, 'You slash a gnoll for 100 points of damage.'),
    'a fragment INSIDE the window',
    at(ANCHOR, 'You have slain a gnoll!'),
    'a trailing fragment with nothing after it'
  ])
  try {
    const slice = await buildSlice({ logPath: fx.path, windowMinutes: 30 })
    assert.ok(slice)
    assert.equal(slice.lines, 3)
    assert.ok(slice.text.includes('a fragment INSIDE the window'))
    assert.ok(!slice.text.includes('orphaned'))
    assert.ok(!slice.text.includes('a trailing fragment'))
  } finally {
    cleanup(fx)
  }
})

// ---- the scrub ------------------------------------------------------------------------------

test('the scrub drops third-party chat and counts every drop honestly', async () => {
  const fx = writeLog([
    at(ANCHOR - 9 * MIN, 'You have entered Plane of Sky.'),
    at(ANCHOR - 8 * MIN, "Rykkerr tells you, 'wanna group?'"),
    at(ANCHOR - 7 * MIN, "You told Rykkerr, 'sure, one sec'"),
    at(ANCHOR - 6 * MIN, "Someone shouts, 'WTS Fungi Tunic'"),
    at(ANCHOR - 5 * MIN, 'Rykkerr has joined the group.'),
    at(ANCHOR - 4 * MIN, 'Rykkerr waves at Testchar.'),
    at(ANCHOR - 3 * MIN, '[50 PAL/MNK] Stranger (Dark Elf) ZONE: freeport'),
    at(ANCHOR - 2 * MIN, "Vebarn told you, 'Attacking a gnoll Master.'"),
    at(ANCHOR - 1 * MIN, 'You slash a gnoll for 120 points of damage.'),
    at(ANCHOR, 'You have slain a gnoll!')
  ])
  try {
    const slice = await buildSlice({ logPath: fx.path, windowMinutes: 30 })
    assert.ok(slice)
    // Six chat/social lines out; the zone line, the pet-claim tell and both combat lines stay.
    assert.equal(slice.dropped, 6)
    assert.equal(slice.lines, 4)
    assert.ok(slice.text.includes('Attacking a gnoll Master.'), 'the pet-claim tell is load-bearing')
    assert.ok(!slice.text.includes('wanna group'))
    assert.ok(!slice.text.includes('WTS Fungi Tunic'))
    assert.ok(!slice.text.includes('Stranger'))
    // `lines` counts what REMAINS; `dropped` counts what the scrub removed. Both are shown.
    assert.equal(slice.text.trimEnd().split('\n').length, slice.lines)
  } finally {
    cleanup(fx)
  }
})

test("the active character's own /who row survives; a stranger's does not", async () => {
  const rows = [
    at(ANCHOR - 2 * MIN, '[50 PAL/MNK/ENC] Testchar (Dark Elf) <Guild> ZONE: freeport'),
    at(ANCHOR - 1 * MIN, '[50 WAR/CLR] Stranger (Human) ZONE: freeport'),
    at(ANCHOR, 'You have slain a gnoll!')
  ]
  const fx = writeLog(rows)
  try {
    const mine = await buildSlice({ logPath: fx.path, windowMinutes: 30, selfName: 'Testchar' })
    assert.ok(mine)
    assert.ok(mine.text.includes('Testchar (Dark Elf)'), 'own loadout row is the owner’s own identity')
    assert.ok(!mine.text.includes('Stranger'))
    assert.equal(mine.dropped, 1)
    // No selfName ⇒ no carve-out at all: every /who row goes. That is the safe default.
    const anon = await buildSlice({ logPath: fx.path, windowMinutes: 30 })
    assert.ok(anon)
    assert.equal(anon.dropped, 2)
    assert.ok(!anon.text.includes('Testchar (Dark Elf)'))
  } finally {
    cleanup(fx)
  }
})

test('a window whose only survivors are chat yields NO attachment at all', async () => {
  const fx = writeLog([
    at(ANCHOR - 50 * MIN, 'You slash a gnoll for 120 points of damage.'),
    at(ANCHOR, "Rykkerr tells you, 'hello?'")
  ])
  try {
    // An empty slice is `log: null` upstream — an empty attachment is not an attachment.
    assert.equal(await buildSlice({ logPath: fx.path, windowMinutes: 15 }), null)
  } finally {
    cleanup(fx)
  }
})

// ---- gzip + integrity -----------------------------------------------------------------------

test('the gz is level 9, round-trips exactly, and the sha256 is of the GZ BYTES', async () => {
  const fx = writeLog([
    at(ANCHOR - 2 * MIN, 'You slash a gnoll for 120 points of damage.'),
    at(ANCHOR - 1 * MIN, 'You slash a gnoll for 121 points of damage.'),
    at(ANCHOR, 'You have slain a gnoll!')
  ])
  try {
    const slice = await buildSlice({ logPath: fx.path, windowMinutes: 30 })
    assert.ok(slice)
    assert.equal(gunzipSync(slice.gz).toString('utf8'), slice.text)
    // LEVEL 9, pinned: the default level 6 produces different bytes for repetitive log text.
    assert.deepEqual(slice.gz, gzipSync(Buffer.from(slice.text, 'utf8'), { level: 9 }))
    assert.equal(slice.bytes, slice.gz.length)
    assert.equal(slice.sha256, createHash('sha256').update(slice.gz).digest('hex'))
    assert.match(slice.sha256, /^[0-9a-f]{64}$/)
    assert.ok(slice.text.endsWith('\n'))
  } finally {
    cleanup(fx)
  }
})

// ---- the caps ---------------------------------------------------------------------------------

test('a busy hour is capped at 50k lines, keeping the LAST ones', async () => {
  // ~70k lines across 60 minutes: denser than the real log's busiest hour (~30-60k), on purpose.
  const total = 70_000
  const lines: string[] = []
  for (let i = 0; i < total; i++) {
    lines.push(at(ANCHOR - 59 * MIN + Math.floor((i * 59 * MIN) / total), `You slash a gnoll for ${i % 300} points of damage.`))
  }
  const fx = writeLog(lines)
  try {
    const slice = await buildSlice({ logPath: fx.path, windowMinutes: 60 })
    assert.ok(slice)
    assert.equal(slice.lines, MAX_SLICE_LINES)
    // The LAST 50k: the lines nearest the problem. The final log line is always present.
    assert.ok(slice.text.endsWith(`${lines[total - 1]}\n`))
    assert.ok(!slice.text.includes(`${lines[0]}\n`))
    assert.ok(slice.bytes < MAX_UPLOAD_BYTES, 'a real busy hour is nowhere near the 2 MB cap')
  } finally {
    cleanup(fx)
  }
})

test('the 16 MB tail cap bounds the read — the head of a huge log is never seen', async () => {
  // A marker at the very TOP of an over-cap file, inside the time window. If it appears in the
  // slice, we read the whole file — which is the memory failure this cap exists to prevent.
  const marker = 'MARKER-THE-TAIL-CAP-MUST-EXCLUDE-THIS'
  const filler = 'You slash a gnoll for 137 points of damage. Fillerfillerfiller.'
  const lines = [at(ANCHOR - 59 * MIN, marker)]
  const per = at(ANCHOR, filler).length + 1
  for (let i = 0; i < Math.ceil((TAIL_READ_CAP * 1.1) / per); i++) {
    lines.push(at(ANCHOR - 58 * MIN + Math.floor((i * 58 * MIN) / 200_000), filler))
  }
  const fx = writeLog(lines)
  try {
    assert.ok(statSync(fx.path).size > TAIL_READ_CAP, 'the fixture must exceed the cap to test it')
    const slice = await buildSlice({ logPath: fx.path, windowMinutes: 60 })
    assert.ok(slice)
    assert.ok(!slice.text.includes(marker), 'the tail cap must bound what is read')
    // The leading FRAGMENT of a truncated read is discarded: every kept line is a real line.
    for (const line of slice.text.trimEnd().split('\n')) assert.ok(line.startsWith('['), line.slice(0, 40))
  } finally {
    cleanup(fx)
  }
})

test('an oversize slice halves its window until the 2 MB gz cap fits', async () => {
  // Incompressible payloads (a base64-ish alphabet from a seeded PRNG), so gzip cannot save us
  // and the FIT path is the only way under the cap. A real log never looks like this.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let seed = 0x2f6e2b1
  const noise = (n: number): string => {
    let s = ''
    for (let i = 0; i < n; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      s += alphabet[(seed >>> 16) & 63]
    }
    return s
  }
  const lines: string[] = []
  for (let i = 0; i < 24_000; i++) {
    lines.push(at(ANCHOR - 60 * MIN + i * 150, `You slash a gnoll. ${noise(120)}`))
  }
  const fx = writeLog(lines)
  try {
    const slice = await buildSlice({ logPath: fx.path, windowMinutes: 60 })
    assert.ok(slice)
    assert.ok(slice.bytes <= MAX_UPLOAD_BYTES, `gz ${slice.bytes} must fit the 2 MB cap`)
    // The window actually used is REPORTED, not the one that was asked for — and the span
    // matches it, so the preview header can never claim an hour it did not send.
    assert.ok(slice.windowMinutes < 60, `window should have halved, got ${slice.windowMinutes}`)
    assert.ok(slice.windowMinutes >= 60 / 2 ** 3)
    assert.ok(slice.fromMs > ANCHOR - 60 * MIN)
    assert.equal(slice.toMs, lineTs(lines[lines.length - 1]))
  } finally {
    cleanup(fx)
  }
})

// ---- the preview ------------------------------------------------------------------------------

test('previewOf caps at PREVIEW_MAX_LINES with an explicit omission marker', () => {
  const short = Array.from({ length: 10 }, (_, i) => `line ${i}`)
  assert.deepEqual(previewOf(short), { previewLines: short, truncatedPreview: false })

  const long = Array.from({ length: PREVIEW_MAX_LINES + 1234 }, (_, i) => `line ${i}`)
  const { previewLines, truncatedPreview } = previewOf(long)
  assert.equal(truncatedPreview, true)
  assert.equal(previewLines.length, PREVIEW_MAX_LINES + 1) // 500 head + marker + 4,500 tail
  assert.equal(previewLines[0], 'line 0')
  assert.equal(previewLines[499], 'line 499')
  assert.match(previewLines[500], /lines omitted from this preview/)
  assert.equal(previewLines[previewLines.length - 1], `line ${long.length - 1}`)
})

test('a long slice previews the head and tail, and the FULL text is still available', async () => {
  const total = PREVIEW_MAX_LINES + 2_000
  const lines = Array.from({ length: total }, (_, i) =>
    at(ANCHOR - 29 * MIN + i * 100, `You slash a gnoll for ${i} points of damage.`)
  )
  const fx = writeLog(lines)
  try {
    const slice = await buildSlice({ logPath: fx.path, windowMinutes: 30 })
    assert.ok(slice)
    assert.equal(slice.truncatedPreview, true)
    assert.equal(slice.previewLines.length, PREVIEW_MAX_LINES + 1)
    // "Save a copy…" writes THIS — every line, so "you can see exactly what is sent" is literal.
    assert.equal(slice.text.trimEnd().split('\n').length, total)
    assert.equal(slice.lines, total)
  } finally {
    cleanup(fx)
  }
})

// ---- degenerate inputs --------------------------------------------------------------------------

test('missing, empty and timestamp-free logs yield null, never a throw', async () => {
  const fx = writeLog(['[Sat Aug 01 14:32:00 2026] anything'])
  try {
    assert.equal(await buildSlice({ logPath: join(fx.dir, 'nope.txt'), windowMinutes: 30 }), null)
    const empty = join(fx.dir, 'empty.txt')
    writeFileSync(empty, '', 'utf8')
    assert.equal(await buildSlice({ logPath: empty, windowMinutes: 30 }), null)
    const noStamps = join(fx.dir, 'nostamps.txt')
    writeFileSync(noStamps, 'hello\nworld\n', 'utf8')
    assert.equal(await buildSlice({ logPath: noStamps, windowMinutes: 30 }), null)
  } finally {
    cleanup(fx)
  }
})

// ---- THE ONE RULE ---------------------------------------------------------------------------------

test('THE GAME LOG IS OPENED READ-ONLY AND IS NEVER WRITTEN TO', async () => {
  const fx = writeLog([
    at(ANCHOR - 5 * MIN, 'You have entered Plane of Sky.'),
    at(ANCHOR, 'You have slain a gnoll!')
  ])
  try {
    const before = readFileSync(fx.path)
    const beforeStat = statSync(fx.path)
    for (const windowMinutes of [15, 30, 60]) {
      assert.ok(await buildSlice({ logPath: fx.path, windowMinutes, selfName: 'Testchar' }))
    }
    const after = readFileSync(fx.path)
    const afterStat = statSync(fx.path)
    assert.ok(before.equals(after), 'the log bytes must be untouched')
    assert.equal(afterStat.size, beforeStat.size)
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, 'a write would move mtime')
  } finally {
    cleanup(fx)
  }
})
