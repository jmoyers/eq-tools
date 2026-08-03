// Progression / leveling-analytics fixture extractor (docs/plans/leveling-analytics.md §7).
//
// Slices real spans out of the live log and keeps every line the ProgressionModule folds:
// experience, level-ups, AA gains/purchases, zone transitions, both kill-credit shapes, the
// pet-binding lines those depend on, loot (the idle heuristic's activity signal), and the self
// `/who` row (the only line that ever states a class loadout — the ComboSource seam's evidence).
//
// Routed through the SHARED scrub (tests/fixture-scrub.mjs `scrubKeep`) like every other
// extractor: ONE definition of "third-party chat" for the whole tree, and never a hand-copied
// raw span. The scrub's pet-claim carve-out is what keeps `<Name> told you, '… Master.'` — the
// only binding signal for a summoned pet — and its self-`/who` exemption keeps Primitive's own
// row while dropping every stranger's.
//
// TWO DELIBERATE WIDENINGS over the plan's KEEP list, both to stop the fixture from lying:
//   • `gained (?:an|\d+) ability point` — the plan's `\d+` form misses `You have gained AN
//     ability point!`, which the parser's AA_RE accepts (`(an|\d+)`). Dropping those would
//     silently under-count aaGained in a window that exists to prove AA lands at the cap.
//   • `You looted …` (the auto-disposition family: currency / sold / hoard / depot / combine)
//     alongside the dashed `--You have looted …--`. Both are `loot` events, and the idle
//     heuristic counts loot as ACTIVITY — keeping only half the family would manufacture idle
//     gaps the real session never had.
//
// Usage: node tests/extract-progression-fixtures.mjs "<path to eqlog_Primitive_freeport.txt>"
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
  /You gain (party )?experience!/, // the new expGain event
  /You have gained a level! Welcome to level \d+!$/,
  /gained (?:an|\d+) ability point/,
  /You have gained the ability "/,
  /You have improved .+ \d+ at a cost of/,
  // zone intervals. PSEUDO-ZONES ("You have entered an area where levitation effects do not
  // function") are kept on purpose: the parser rejects them and the fixture must prove it does.
  /\] You have entered /,
  /You have slain .+!$/, // self kill credit
  / has been slain by .+!$/, // bound-pet + third-party credit
  /told you, '.*Master\.'$/, // pet binding — survives via the scrub's carve-out
  / has been charmed\.$/,
  /\] --You have looted /, // idle-heuristic activity signal
  /\] You looted /, //   … and its looted-and-routed twin (see the header)
  /\] \[\d+ [A-Z]{3}(?:\/[A-Z]{3})*\] Primitive / // self /who — combo-seam evidence
]
const keep = (l) => l.startsWith('[') && scrubKeep(l) && KEEP.some((re) => re.test(l))

function slice(fromLine, toLine, out) {
  const seg = []
  for (let i = fromLine - 1; i < toLine && i < lines.length; i++) if (keep(lines[i])) seg.push(lines[i])
  writeFileSync(join(FIXTURES, out), seg.join('\n') + '\n')
  console.log(`${out}: ${seg.length} lines (from raw ${toLine - fromLine + 1})`)
}

// ─────────────────────────────────────────────────────────────────────────────
// LINE RANGES. Located in eqlog_Primitive_freeport.txt on 2026-08-03 (1,113,679 lines). The
// log GROWS by append, so these stay valid; re-locate only if it is ever truncated/rotated.
// wl40/wl43 are the plan's own anchors; wl41/wl42/wl45 were picked here with fresh greps, and
// wl44's anchor in the plan was WRONG (see its note).
// ─────────────────────────────────────────────────────────────────────────────

// WL40 THE FARM RUN — Sun Aug 02 15:12:00 ("Welcome to level 18!") → 17:33:26 ("… level 28!").
// The core case: TEN dings in 2h21m of dense solo farming, every exp line carrying a
// percentage, plus 5 zone lines (Innothule Swamp → The City of Guk → The Ruins of Old Guk ×3),
// one ~14-minute travel gap, and 3 third-party kills to be excluded from the rates.
slice(987818, 1017315, 'wl40-farm-run.log')

// WL41 MULTI-ZONE — Sat Aug 01 13:38:00 → 14:10:50, three DISTINCT zones with credited kills
// in each (The Plane of Hate - Solo 1 (Awakened) → The Oasis of Marr → The Plane of Hate -
// Solo 2 (Adaptive)), pet kills included. Pins the per-zone rows, the zone attribution of
// kills, and the `Σ zones[].spanMs == durationMs` identity across a real travel hop.
slice(822348, 834348, 'wl41-multizone.log')

// WL42 IDLE GAPS — Mon Aug 03 00:54:58 → 14:31:26. Contains BOTH shapes the idle classifier
// must tell apart: a ~14-minute break (over the 5-minute threshold, well under an hour) and a
// ~12.6-HOUR overnight silence, across a travel run + a long Ruins of Old Paineel session. The
// long gap is also the case that proves idle is attributed to the zone you were standing in.
slice(1100597, 1110597, 'wl42-idle-gap.log')

// WL43 AT THE CAP, NO PERCENTAGE — Fri Jul 31 17:51:24 (the FIRST percent-less exp line in the
// log) → 18:56. The character hit level 50 at 16:19 and does not ding again for 34 h, so the
// game prints no percentage at all: every exp line in this window is percent-less, and an AA
// gain lands inside it. THE REGRESSION THAT MATTERS — nothing may render 0.0% or a fake rate
// here (`expUnstated > 0`, `levelEquiv == 0`, every levels rate `null`).
slice(693485, 707000, 'wl43-capped-no-pct.log')

// WL44 THE LOADOUT SWAP — Fri Jul 31 16:19:04 ("Welcome to level 50!") → Sun Aug 02 02:26:50
// ("… level 13!"). The plan's suggested anchor (raw 1020000–1024500) is WRONG: that span is
// Sun Aug 02 19:19–19:33 and contains dings 29→30, i.e. NO level regression at all, so it
// cannot pin a run split. The 50 → 11 drop is the ONLY loadout swap in the post-epoch log and
// its two ends are 303k raw lines apart, so the window has to span them; there is no smaller
// span that contains a regression. It is the largest fixture in the tree by design, and it
// doubles as an independent second read of the at-cap window WL43 isolates.
slice(669590, 975780, 'wl44-swap-boundary.log')

// WL45 KILL CREDIT — Thu Jul 30 16:28:12 → 16:56:38 in Nagafen's Lair - Solo, the smallest
// span found that carries all THREE credit shapes with the pet bound INSIDE the window: your
// own killing blows, a bound pet's, and other players'/mobs' kills that must be witnessed-only.
slice(492616, 500616, 'wl45-kill-credit.log')
