// One-off CONSIDER fixture extractor (Task #63) — sibling of extract-loot-fixtures.mjs.
// Slices line ranges from the real log keeping only the lines the consider family cares
// about (consider + zone), so fixtures stay small and reviewable but replay through the
// real parser + ConsiderModule is faithful.
//
//   node tests/extract-consider-fixtures.mjs "<path-to-eqlog>"
//
// SCRUB: routed through the SHARED scrub (tests/fixture-scrub.mjs), like every other
// extractor. VERIFIED 2026-08-03 against the full 1.02M-line log: all 357 consider lines
// survive `scrubKeep` untouched (0 dropped), so NO carve-out or KEEP-rule extension was
// needed. That is expected — a consider line carries no quoted speech (`, '`): its only
// comma is inside the faction phrase "scowls at you, ready to attack", and its subject is
// a mob, never a player. Re-run the check if the scrub's DROP list ever grows.
//
// Line numbers below were located in eqlog_Primitive_freeport.txt on 2026-08-03;
// re-locate if the log is truncated/rotated.
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { scrubKeep } from './fixture-scrub.mjs'

// Fixtures resolve RELATIVE to this file — never hardcode a repo path here.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const LOG = process.argv[2]
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

// `(Lvl: N)` is the consider family's anchor. A full-log sweep (2026-08-03) found 357 lines
// carrying it and every one of them is a consider; the only OTHER lines containing ` -- `
// are 9 player chat lines, which the scrub drops anyway. Zone lines come along so a replay
// through the module has the same world context the live app does.
const KEEP = [/\(Lvl: \d+\)$/, /\] You have entered /]
function keep(line) {
  if (!line.startsWith('[')) return false
  if (!scrubKeep(line)) return false
  return KEEP.some((re) => re.test(line))
}

function slice(fromLine, toLine, out) {
  const seg = []
  for (let i = fromLine - 1; i < toLine && i < lines.length; i++) {
    if (keep(lines[i])) seg.push(lines[i])
  }
  writeFileSync(join(FIXTURES, out), seg.join('\n') + '\n')
  console.log(`${out}: ${seg.length} lines (from raw ${toLine - fromLine + 1})`)
}

// W22 GUARDS (Jul 19 18:56–18:59, Neriak): BACKTICK names (Guard V`Lex) and the
// `glares at you threateningly` faction rung, plus the same mob conned three times in
// 8 seconds (18:56:38 / :44 / :45) — the double-con the feed must not spam.
slice(84900, 85140, 'w22-consider-guards.log')

// W23 RARE (Jul 19 22:43, Blackburrow-side gnolls): the ` - a rare creature - ` infix on
// "A Tesch Val Brute", conned in the same 11 seconds as five ordinary gnolls, one of which
// (A Nisch Val Gnoll) is itself conned three times (:16 / :23 / :25).
slice(135300, 135330, 'w23-consider-rare.log')

// W24 FACTION LADDER (Aug 01 01:44–02:42, Freeport): the widest faction spread in the log —
// `looks upon you warmly`, `judges you amiably`, `glowers at you dubiously`, `looks your way
// apprehensively`, `regards you indifferently` and `scowls at you, ready to attack` all in
// one window, plus the GENDERED difficulty variant ("looks like HE would wipe the floor with
// you!") and Karam Dragonforge conned four times across three DIFFERENT faction rungs.
slice(814640, 815100, 'w24-consider-factions.log')
