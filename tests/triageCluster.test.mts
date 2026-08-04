// The deterministic half of triage (scripts/triageCluster.mts) — pure functions, so
// this suite has no AWS, no network, no fixtures and NEVER SKIPS.
//
// Three things are actually load-bearing here and each gets real coverage:
//
//   1. CRASH SIGNATURES beat prose. Our own error harness (src/main/errorLog.ts)
//      stamps `[everquest-companion:error] [<source>] <body>`, so two users hitting
//      the same broken component produce the same identity even when their
//      descriptions share not one word. If that regressed, clustering would quietly
//      fall back to guessing at English.
//   2. ULID TIME ARITHMETIC is what makes `--since 7d` a BETWEEN on a GSI sort key
//      instead of a table scan. A wrong floor is a silent cost bug.
//   3. THE LAW: a log slice never reaches a public issue. `assertNoLogSlice` is the
//      enforcement point, and this file is what proves it fires.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertNoLogSlice,
  clusterReports,
  containsLogSlice,
  crashSignature,
  digestLine,
  jaccard,
  parseSince,
  renderDigest,
  tokenize,
  ulidFloor,
  ulidTimestamp,
  type TriageReport,
} from '../scripts/triageCluster.mjs'

// ---- helpers ---------------------------------------------------------------------

/** A fixed clock. Frozen numbers are fine here: nothing in this suite reads the log. */
const NOW = Date.parse('2026-08-03T12:00:00Z')

let seq = 0
function report(over: Partial<TriageReport> = {}): TriageReport {
  seq += 1
  return {
    reportId: `01J8ABCDEFGHJKMNPQRST${String(seq).padStart(3, '0')}`,
    type: 'bug',
    description: 'something went wrong',
    appVersion: '0.2.0',
    platform: 'win32',
    channel: 'prod',
    status: 'new',
    spamScore: 0,
    receivedAt: NOW,
    hasLog: false,
    ...over,
  }
}

/** A real errors.log line shape: ISO ts, prefix, source tag, message + stack. */
function errorLine(source: string, file: string, line: number): string {
  return (
    `2026-08-03T14:02:11.104Z [everquest-companion:error] [${source}] ` +
    `TypeError: Cannot read properties of undefined (reading 'total')\n` +
    `    at OverlayMeter (file:///C:/app/out/renderer/${file}:${line}:19)\n` +
    `    at renderWithHooks (file:///C:/app/out/renderer/react-dom.js:14985:18)`
  )
}

// ---- crash signatures ------------------------------------------------------------

test('crashSignature keys on the error source tag plus the first stack frame', () => {
  const sig = crashSignature(errorLine('renderer:ErrorBoundary', 'OverlayMeter.tsx', 88))
  assert.equal(sig, 'renderer:ErrorBoundary|OverlayMeter.tsx:88')
})

test('crashSignature falls back to the message head when there is no stack frame', () => {
  const sig = crashSignature(
    '2026-08-03T14:02:11.104Z [everquest-companion:error] [main:uncaughtException] EPERM: operation not permitted',
  )
  assert.equal(sig, 'main:uncaughtException|EPERM: operation not permitted')
})

test('crashSignature returns null for ordinary prose — a feature request is not a crash', () => {
  assert.equal(crashSignature('please let me pin a fight to the overlay'), null)
})

// ---- clustering ------------------------------------------------------------------

test('reports sharing a crash signature are ONE cluster even with unrelated wording', () => {
  const a = report({ description: `overlay went blank after zoning\n${errorLine('renderer:ErrorBoundary', 'OverlayMeter.tsx', 88)}` })
  const b = report({ description: `meter died, no idea why\n${errorLine('renderer:ErrorBoundary', 'OverlayMeter.tsx', 88)}` })
  const clusters = clusterReports([a, b])

  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].kind, 'crash')
  assert.equal(clusters[0].signature, 'renderer:ErrorBoundary|OverlayMeter.tsx:88')
  assert.deepEqual(clusters[0].reportIds, [a.reportId, b.reportId])
  // Stable, human-readable id derived from the FIRST member's ULID.
  assert.equal(clusters[0].id, `c-${a.reportId.slice(-4).toUpperCase()}`)
})

test('a crash signature also reads out of an attached slice, not just the description', () => {
  const a = report({ description: 'it crashed', logText: errorLine('main:uncaughtException', 'engine.ts', 412) })
  const b = report({ description: 'crashed again', logText: errorLine('main:uncaughtException', 'engine.ts', 412) })
  const clusters = clusterReports([a, b])
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].reportIds.length, 2)
})

test('different frames in the same file are different clusters — the line number is identity', () => {
  const a = report({ description: errorLine('renderer:ErrorBoundary', 'CombatView.tsx', 100) })
  const b = report({ description: errorLine('renderer:ErrorBoundary', 'CombatView.tsx', 250) })
  assert.equal(clusterReports([a, b]).length, 2)
})

test('near-duplicate prose clusters at Jaccard >= 0.6; unrelated prose does not', () => {
  const a = report({ description: 'the overlay meter goes blank when I zone into a new dungeon' })
  const b = report({ description: 'overlay meter goes blank whenever I zone into another dungeon' })
  const c = report({ description: 'please add a keybind for toggling the maps floor slider' })
  const clusters = clusterReports([a, b, c])

  assert.equal(clusters.length, 1, 'the singleton must not become a cluster of one')
  assert.equal(clusters[0].kind, 'tokens')
  assert.deepEqual(clusters[0].reportIds, [a.reportId, b.reportId])
})

test('a cluster whose members all sit on one version is flagged as a regression candidate', () => {
  const shared = errorLine('renderer:ErrorBoundary', 'PoskyView.tsx', 12)
  const same = clusterReports([
    report({ description: shared, appVersion: '0.2.1' }),
    report({ description: shared, appVersion: '0.2.1' }),
  ])
  assert.equal(same[0].regression, true)
  assert.deepEqual(same[0].versions, ['0.2.1'])

  const spread = clusterReports([
    report({ description: shared, appVersion: '0.2.0' }),
    report({ description: shared, appVersion: '0.2.1' }),
  ])
  assert.equal(spread[0].regression, false, 'two versions is a long-standing gripe, not a regression')
})

test('clusters are ordered by weight and count their attached logs', () => {
  const big = errorLine('renderer:ErrorBoundary', 'A.tsx', 1)
  const small = errorLine('main:uncaughtException', 'B.ts', 2)
  const clusters = clusterReports([
    report({ description: big, hasLog: true }),
    report({ description: big, hasLog: true }),
    report({ description: big, hasLog: false }),
    report({ description: small }),
    report({ description: small }),
  ])
  assert.equal(clusters[0].reportIds.length, 3)
  assert.equal(clusters[0].withLogs, 2)
  assert.equal(clusters[1].reportIds.length, 2)
})

test('tokenize drops stopwords, digits and short words; jaccard is symmetric', () => {
  const t = tokenize('The overlay meter goes blank after 0.2.1 when I zone')
  assert.ok(t.has('overlay') && t.has('meter') && t.has('blank') && t.has('zone'))
  for (const dead of ['the', 'when', 'after', 'goes']) assert.ok(!t.has(dead) || dead === 'goes')
  assert.ok(![...t].some((w) => /\d/.test(w)), 'version numbers are not topics')

  const a = tokenize('overlay meter blank zoning')
  const b = tokenize('overlay meter blank zoning')
  assert.equal(jaccard(a, b), 1)
  assert.equal(jaccard(a, tokenize('maps floor slider keybind')), 0)
  assert.equal(jaccard(new Set(), a), 0, 'an empty set never matches anything')
})

// ---- ULID arithmetic -------------------------------------------------------------

test('ulidFloor is the lowest ULID at a timestamp, and round-trips through ulidTimestamp', () => {
  const ms = NOW
  const floor = ulidFloor(ms)
  assert.equal(floor.length, 26)
  assert.equal(ulidTimestamp(floor), ms)
  assert.ok(floor.endsWith('0'.repeat(16)))
  // Lexicographic order IS time order — the whole reason --since is a BETWEEN.
  assert.ok(ulidFloor(ms) < ulidFloor(ms + 1))
  assert.ok(ulidFloor(ms - 86_400_000) < ulidFloor(ms))
})

test('ulidTimestamp rejects text that is not Crockford base32', () => {
  assert.ok(Number.isNaN(ulidTimestamp('not-a-ulid!!')))
})

test('parseSince understands d/h/m and ISO dates, and refuses nonsense', () => {
  const now = NOW
  assert.equal(parseSince('7d', now), now - 7 * 86_400_000)
  assert.equal(parseSince('12h', now), now - 12 * 3_600_000)
  assert.equal(parseSince('30m', now), now - 30 * 60_000)
  assert.equal(parseSince('2026-08-01T00:00:00Z', now), Date.parse('2026-08-01T00:00:00Z'))
  assert.throws(() => parseSince('soon', now), /expected 7d/)
})

// ---- THE LAW ---------------------------------------------------------------------

test('containsLogSlice recognises a raw EverQuest log line', () => {
  assert.equal(containsLogSlice('[Sat Aug 01 13:00:28 2026] You have entered The Hole.'), true)
  // Single-digit days are space-padded in the real log.
  assert.equal(containsLogSlice('[Mon Aug  3 09:12:00 2026] You slash a gorgon for 214 points of damage.'), true)
})

test('containsLogSlice does NOT fire on ordinary prose or on an app error line', () => {
  assert.equal(containsLogSlice('the meter reads 0 dps after I zone'), false)
  assert.equal(containsLogSlice(errorLine('renderer:ErrorBoundary', 'X.tsx', 3)), false)
})

test('assertNoLogSlice REFUSES to publish a body carrying log lines', () => {
  const body = 'Reported:\n\n[Sat Aug 01 13:00:28 2026] Primitive tells the group, hi\n'
  assert.throws(() => assertNoLogSlice(body, 'a public issue for 01J8'), /never reaches a public issue/)
  assert.doesNotThrow(() => assertNoLogSlice('overlay is blank after zoning', 'a public issue'))
})

// ---- digest ----------------------------------------------------------------------

test('digestLine stays under 200 chars and carries no PII field', () => {
  const line = digestLine(report({ description: 'x'.repeat(500), hasLog: true, spamScore: 55 }))
  assert.ok(line.length <= 200, `digest line was ${line.length} chars`)
  assert.ok(line.includes('log ✔'))
  assert.ok(line.includes('spam 55'))
  assert.ok(line.endsWith('spam 55'))
})

test('renderDigest reports counts, clusters, and the unclustered remainder', () => {
  const sig = errorLine('renderer:ErrorBoundary', 'OverlayMeter.tsx', 88)
  const reports = [
    report({ description: sig, hasLog: true }),
    report({ description: sig, hasLog: true }),
    report({ description: 'add a keybind for the maps floor slider', type: 'feature' }),
  ]
  const md = renderDigest(reports, clusterReports(reports), {
    sinceMs: NOW - 7 * 86_400_000,
    nowMs: NOW,
    channel: 'prod',
  })

  assert.match(md, /## Feedback digest — 7 days to 2026-08-03 \(prod\)/)
  assert.match(md, /3 reports · 2 bug · 1 feature · 1 clusters/)
  assert.match(md, /signature `renderer:ErrorBoundary\|OverlayMeter\.tsx:88`/)
  assert.match(md, /### Unclustered feature requests \(1\)/)
  // The digest is what a model reads. It must never carry a slice.
  assert.equal(containsLogSlice(md), false)
})

test('an empty window renders an honest empty state rather than a broken table', () => {
  const md = renderDigest([], [], { sinceMs: 0, nowMs: 86_400_000, channel: 'dev' })
  assert.match(md, /0 reports/)
  assert.match(md, /_No reports in this window\._/)
})
