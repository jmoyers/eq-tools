// One-off SESSION fixture extractor — the login/logout frame (sessionStart / campStart /
// campAbort and the derived offlineGap). Sibling of extract-consider-fixtures.mjs.
//
//   npx tsx tests/extract-session-fixtures.mjs "<path-to-eqlog>"
//
// (Run it under the tsx loader like its siblings: tests/fixture-scrub.mjs is now a shim over
// the TypeScript src/shared/logScrub.ts, so a bare `node` invocation depends on the runtime's
// type-stripping being enabled. Both were verified to produce byte-identical fixtures here.)
//
// SCRUB: routed through the SHARED scrub (tests/fixture-scrub.mjs), like every extractor.
// VERIFIED against the full log (2026-08-03): all 20 `Welcome to EverQuest Legends!`, all 20
// camp-initiation lines, both `You abandon your preparations to camp.` lines and all 78
// countdown ticks survive `scrubKeep` untouched — 0 dropped. No KEEP carve-out was needed and
// fixture-scrub.mjs is UNCHANGED. That is expected: these are system messages with no speaker,
// no quoted speech and no proper name, so none of the five DROP families can reach them.
// (Re-run `node tests/extract-session-fixtures.mjs <log>` if the scrub's DROP list ever grows —
// it asserts the survival counts and fails loudly rather than writing a hollowed-out fixture.)
//
// WHAT IS KEPT INSIDE A WINDOW: everything the scrub allows, verbatim and contiguous. That is
// load-bearing here in a way it is not for other families — the offline-gap rule anchors on
// THE TIMESTAMPS OF SURROUNDING EVENTS (see src/main/log/sessionDetector.ts), so filtering a
// window down to "just the session lines" would silently change the answer. The countdown
// ticks in particular are what keep `fromTs` at the end of the camp instead of at its start.
//
// Line numbers below were located in eqlog_Primitive_freeport.txt on 2026-08-03. The log only
// ever APPENDS, so historical line numbers stay valid as it grows; re-locate if it is
// truncated or rotated.
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { scrubKeep } from './fixture-scrub.mjs'

// Fixtures resolve RELATIVE to this file — never hardcode a repo path here.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const LOG = process.argv[2]
if (!LOG) throw new Error('usage: node tests/extract-session-fixtures.mjs "<path-to-eqlog>"')
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

/** A scrub-surviving, timestamped log line. */
function keep(line) {
  return line.startsWith('[') && scrubKeep(line)
}

/**
 * Write one fixture from one or more line RANGES (1-based, inclusive). Multiple ranges are
 * concatenated in order; only the buff-pause evidence fixture uses more than one, and it says
 * so in its own comment (joining distant spans of the same evening keeps it hand-readable).
 */
function slice(ranges, out) {
  const seg = []
  for (const [from, to] of ranges) {
    for (let i = from - 1; i < to && i < lines.length; i++) {
      if (keep(lines[i])) seg.push(lines[i])
    }
  }
  writeFileSync(join(FIXTURES, out), seg.join('\n') + '\n')
  console.log(`${out}: ${seg.length} lines`)
}

// S1 OVERNIGHT CAMP (Fri Jul 31 01:05–14:49, The Plane of Hate). The canonical case: a clean
// camp-out, an overnight absence, and a login. campStart 01:05:43, five countdown ticks to
// 01:06:07, then 13h43m of nothing, then the reconnect preamble (`You are not currently
// assigned to an adventure.` / `Channel …` / `Channels: …`) and the Welcome at 14:49:15,
// followed immediately by `You have entered The Plane of Hate.`
slice([[641920, 641945]], 's1-session-overnight-camp.log')

// S2 CRASH / QUIT — a Welcome with NO camp (Fri Jul 31 21:20–22:07, Nagafen's Lair). The last
// in-world line is a DoT tick at 21:20:59; the next thing the log says is the reconnect
// preamble 46 minutes later. Nothing announced the logout, which is exactly the point: the
// absence is real and `camped` must read false.
slice([[747676, 747690]], 's2-session-crash-relog.log')

// S3 ABORTED CAMPS (Sun Aug 02 01:31–01:35, Butcherblock Mountains). The only two
// `You abandon your preparations to camp.` lines in the entire log, each in the SAME second as
// its own camp-initiation line, followed 9s later by a THIRD camp that actually completes.
// Also a sub-minute relog (58s camp→Welcome), so the window pins both rules at once: three
// campStarts, two campAborts, and NO offlineGap.
slice([[969396, 969422]], 's3-session-camp-aborted.log')

// S4 FAST RELOG (Mon Aug 03 01:21–01:22, The Ruins of Old Paineel). A clean 50-second
// camp→Welcome cycle with ordinary activity interleaved through the countdown. The measured
// gap is 31s — under the one-minute floor, so this is a blip and NOT an absence.
slice([[1100765, 1100788]], 's4-session-fast-relog.log')

// S5 BUFF-TIMER PAUSE EVIDENCE (Fri Jul 31, three spans of ONE evening, joined for size).
// This is the window that PROVES EQ pauses buff timers while you are out of the world — the
// measurement world-model law 1 demands before the pause is encoded anywhere. Read in order:
//   span A (637920-637932)  00:51:59  `You feel much faster.`        — Swift Like the Wind lands
//   span B (641920-641945)  01:05:43  camp → 14:49:15 Welcome        — the 13h43m08s absence
//   span C (642624-642634)  14:50:28  `Your speed returns to normal.`— it wears off, 73s later
// The hole between A and B is ~13 minutes of ordinary combat inside ONE session; it cannot
// affect the gap, whose `fromTs` is the last countdown tick inside span B. See
// tests/sessionWindows.test.mts for the arithmetic this pins.
slice([[637920, 637932], [641920, 641945], [642624, 642634]], 's5-session-buff-pause-evidence.log')

// ── scrub survival check (fail loudly rather than write a hollowed-out fixture) ──
const SESSION_SHAPES = [
  ['Welcome to EverQuest Legends!', (l) => l.endsWith('Welcome to EverQuest Legends!')],
  ['camp initiation', (l) => l.endsWith('It will take you about 30 seconds to prepare your camp.')],
  ['camp abort', (l) => l.endsWith('You abandon your preparations to camp.')],
  ['countdown tick', (l) => / more seconds to prepare your camp\.$/.test(l)]
]
for (const [label, test] of SESSION_SHAPES) {
  const all = lines.filter(test)
  const kept = all.filter(scrubKeep)
  if (kept.length !== all.length) {
    throw new Error(`SCRUB REGRESSION: ${all.length - kept.length}/${all.length} "${label}" lines are now dropped`)
  }
  console.log(`scrub: ${label} — ${all.length}/${all.length} survive`)
}
