// Class-combo fixture extractor (docs/plans/class-combo-inference.md § 11).
//
// Slices real spans out of the live log and keeps ONLY the lines that carry class evidence:
// the character's own `/who` rows (the single Tier-A observation — the only line in the game
// that states the loadout), level dings (the structural swap signal, since a displayed level
// is the MINIMUM of the loadout's class levels), casts, stances, invocations, rogue poison
// coats, and skill-ups (the only window into BER / MNK / WAR / ROG, which have 0/0/0/9 spells
// between them).
//
// Routed through the SHARED scrub (tests/fixture-scrub.mjs `scrubKeep`) like every other
// extractor: ONE definition of "third-party chat" for the whole tree, and never a hand-copied
// raw span. That is what drops all 410 strangers' `/who` rows while keeping Primitive's own
// 11 — and it is why the design document's quoted chat lines never reach a fixture.
//
// Usage: node tests/extract-combo-fixtures.mjs "<path to eqlog_Primitive_freeport.txt>"
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { scrubKeep } from './fixture-scrub.mjs'

// Fixtures resolve RELATIVE to this file — the repo moved once and these extractors kept
// writing into the old absolute path. Never hardcode a repo path here again.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const LOG = process.argv[2]
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

const KEEP = [
  // Tier A — the ONLY authoritative statement of the loadout. Survives via the scrub's
  // self-name carve-out; every stranger's row in the same grammar is dropped.
  /\] *(?:\* RIP \*\s*)?(?:AFK\s+)?\[\d+ [A-Z]{3}(?:\/[A-Z]{3})*\] Primitive\b/,
  // Tier D — the structural swap signal (a NON-INCREASING ding means the loadout changed).
  /\] You have gained a level! Welcome to level \d+!$/,
  // Tier C — casts (weakest evidence, highest volume; both the cast and the bard-song shape).
  /\] You begin (?:casting|singing) /,
  // Tier B — the class-GATED signals.
  /\] You assume an? .+ stance\.$/,
  /\] You begin reciting the .+ invocation\.$/,
  /\] You coat your blades /,
  /\] You have become better at .+!/
]
const keep = (l) => l.startsWith('[') && scrubKeep(l) && KEEP.some((re) => re.test(l))

function slice(fromLine, toLine, out) {
  const seg = []
  for (let i = fromLine - 1; i < toLine && i < lines.length; i++) if (keep(lines[i])) seg.push(lines[i])
  writeFileSync(join(FIXTURES, out), seg.join('\n') + '\n')
  console.log(`${out}: ${seg.length} lines (from raw ${toLine - fromLine + 1})`)
}

// ─────────────────────────────────────────────────────────────────────────────
// LINE RANGES. Located in eqlog_Primitive_freeport.txt on 2026-08-03. The log GROWS by
// append, so these stay valid; re-locate only if it is ever truncated/rotated.
// EPOCH: every span starts at/after the official launch anchor (2026-07-28 00:00 local,
// epochDetector.ts LAUNCH_MS), so the epoch reset never fires mid-fixture and no pre-launch
// beta-character evidence (the Jul 19–20 Bard window) can leak in.
// ─────────────────────────────────────────────────────────────────────────────

// CW1 WHO-ANCHORED — Tue Jul 28 14:00:00 → 20:45:00. The densest `/who` day in the log:
// SEVEN self rows, covering all four DISTINCT anchor combos the design names — [7 CLR/BER]
// (14:11:26), [7 PAL/ENC] (14:14:48), [10 PAL/ROG/ENC] (17:25:15), [17 PAL/MNK/ENC]
// (20:16:48, plus repeats at 20:30/20:31 and [18 …] at 20:42). That is the 2→3 slot
// transition — the tertiary slot unlocks at level 10 — stated by the game itself, and it
// carries the Jul 28 Backstab + Frenzy skill-ups that place ROG and BER in the same day.
slice(178804, 250545, 'cw1-who-anchored.log')

// CW2 THE UNLOGGED SWAP — Fri Jul 31 16:00:00 → the log's end at extraction (Mon Aug 03
// 15:17). Spans the ONE loadout swap in the post-launch log and, critically, the
// EVIDENCE-SHIFT WINDOW inside it: the last MNK evidence is `Feign Death! (108)` at
// Sun Aug 02 00:57:55 and the first ROG evidence is `Backstab! (2)` at 01:57:42 — one hour
// apart, with no line between them announcing anything. The wide structural bracket is here
// too: `Welcome to level 50!` at Jul 31 16:19:04 and the drop to `level 11!` at Aug 02
// 02:13:34, the honest 33.9 h boundary. Both sides need to be long enough to establish
// SUSTAIN (evidence in ≥2 hourly buckets), which is what a one-hour slice around the shift
// could not show, so the span is deliberately the full three days.
// It is the largest fixture this wave adds (~440 KB, vs the accepted 289 KB precedent of
// wl44-swap-boundary.log). It cannot be trimmed by dropping evidence-free stretches: after
// the KEEP filter EVERY retained line is evidence, and thinning it would manufacture a
// sustain gap the real session never had.
slice(663705, 1124605, 'cw2-loadout-swap-aug2.log')

// CW3 CLR/PAL AMBIGUITY — Tue Jul 28 13:41:00 → 14:41:00 (the design's "14:11 ±30 min").
// The `[7 CLR/BER]` anchor and the window around it, where every cast the character makes is
// a {CLR,PAL} shared spell (Reckless Strength, Wrath, Smite, Furor, Center, Courage, Daring,
// Stun, Holy Armor). CLR is NEVER exclusively evidenced anywhere in this log, so cast
// evidence alone can only ever report the SET {CLR,PAL} — never a guess of PAL.
// NOTE for the module wave: this span contains TWO self `/who` rows ([7 CLR/BER] at 14:11:26
// and [7 PAL/ENC] at 14:14:48). They are the ground truth the ambiguity is measured against,
// but they will also ANCHOR the interval at provenance 'who' — so the "stays ambiguous"
// assertion belongs on the scorer's own output (observations → slots), not on a /who-anchored
// interval.
slice(177648, 185280, 'cw3-ambiguous-clr-pal.log')

// CW4 THE STRAY CAST — Sun Aug 02 18:00:00 → 21:00:00, deep inside the post-swap PAL/ROG/BER
// period. Exactly ONE cast in the whole window names a class the loadout does not have:
// `You begin casting Rampage I.` at 20:52:33, which spells.json maps to {ENC}. One cast in
// one hourly bucket must NOT admit ENC (the sustain ≥ 2 rule).
// THE DESIGN NAMES THE WRONG LINE: § 2/C1 and § 10 call this "the lone Chaos Flux". There is
// no player Chaos Flux cast on Aug 2 at all — the only Aug 2 occurrences are a MOB's
// (`A ghoul scribe begins casting Chaos Flux.` 19:37:27 and its interrupt), which the parser
// never turns into a castBegin. Rampage I is the real instance of the case the design
// describes, and it is inside the span the design already chose.
slice(1019360, 1040292, 'cw4-stray-cast.log')
