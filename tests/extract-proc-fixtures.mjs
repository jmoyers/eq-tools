// PROC ANALYTICS golden-window fixture extractor (docs/plans/proc-analytics.md, wave 1).
//
// Same law as tests/extract-combat-fixtures.mjs: a proc window must replay the fight VERBATIM
// — every damage / miss / resist / heal / death line is load-bearing for the proc lanes, for
// the swing denominator and for the byte-identical damage tripwire — so this slicer keeps the
// raw span and drops ONLY what the shared scrub (tests/fixture-scrub.mjs `scrubKeep`)
// classifies as third-party chat/social. NEVER hand-copy a span into fixtures/ and never
// re-implement the drop list: `tests/fixtures/*.log` is COMMITTED to a PUBLIC repo.
//
// Usage: node tests/extract-proc-fixtures.mjs "<path to eqlog_Primitive_freeport.txt>"
//
// Line numbers are against the LIVE log (1,138,838 lines as of Mon Aug 03 2026 15:55 — it has
// grown well past the 1,110,084 the plan was written against, so every span below was
// re-located fresh). The log only ever grows by APPENDING, so a span's raw range stays valid;
// the timestamps in each header are the real anchor if a number ever looks wrong.
//
// WHY THESE FOUR. Each window isolates ONE thing the proc model has to get right, and each was
// chosen because its answer is legible by eye:
//
//   w38  the weapon proc with nothing else going on  — the PPM arithmetic
//   w39  Spellblade                                   — the 100%-exclusivity measurement
//   w40  Instrument of Nife                           — the honest-limits case (no control arm)
//   w41  the rogue coats                              — the poison lane, with a heal side
//
// The plan's table also listed a `w41-slay-undead.log`. It is NOT extracted, because it would
// be redundant: w40 already carries 15 `(Slay Undead)` hits for 7,008 damage across its zone
// session (and w38 six more for 5,111), which is a denser slay sample than a dedicated undead
// pull, inside a window that has to exist anyway. The slay goldens live in the w40 test.
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { scrubKeep } from './fixture-scrub.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG = process.argv[2]
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

function slice(fromLine, toLine, out) {
  const seg = []
  for (let i = fromLine - 1; i < toLine && i < lines.length; i++) {
    const l = lines[i]
    if (!l.startsWith('[')) continue
    if (!scrubKeep(l)) continue
    seg.push(l)
  }
  writeFileSync(join(HERE, 'fixtures', out), seg.join('\n') + '\n')
  console.log(`${out}: ${seg.length} lines (from raw ${toLine - fromLine + 1})`)
}

// ---------------------------------------------------------------------------------------
// W38 PPM UNDER ONE STABLE INVOCATION (Sun Aug 02 21:43:03 → 21:47:56, raw 1051339..1053341).
//
// A five-minute Befallen ghoul grind that commits `inversion` in its third line and NEVER
// changes invocation again — so every proc in it fired under exactly one invocation and the
// PPM arithmetic has no state confound to explain away. THREE encounters, fifteen kills.
// Hand-read beats:
//   21:43:03  opens on `Auto attack is on.` — and the very first line is a WHIFF
//             (`You try to backstab a wan ghoul knight, but miss!`) landed BEFORE any damage.
//             Law 8: a miss never opens an encounter, so that one swing lives in the ZONE
//             aggregate and in no fight. It is why Σ(fight swings) is 921 against a zone 922,
//             and it is the cheapest possible proof the swing denominator is not double-counted.
//   21:43:05  `You begin reciting the inversion invocation.` — the ONLY invocation commit in
//             the window. The span opens `observed` here and is still open at the last line.
//   21:45:50  `You assume a balanced stance.` — the only stance commit, in the third fight.
//             Two kinds of state in one window, and they are independent.
// What it pins: Smiting Strike 27 procs / 2,796 damage, Condemnation of Nife 5 / 1,165 and
// Dismiss Undead 5 / 683 — all three CAST-LESS (the window's only casts are Greater Healing
// ×13, Reckless Strength and Lay on Hands VIII), so the detector must score proc=3 lanes and
// cast=0 for every one of them; activeSec 280 against durationSec 282; swings 922; and the
// three denominators computed off those numbers.
slice(1051339, 1053341, 'w38-proc-ppm.log')

// ---------------------------------------------------------------------------------------
// W39 SPELLBLADE — THE 100%-EXCLUSIVITY MEASUREMENT (Fri Jul 31 16:06:46 → 16:12:45, raw
// 665925..667420).
//
// The plan's headline finding is that every cast-less `Discordant Mind` firing in the whole log
// happened under the `spellblade` invocation. This is the tightest real window that shows it
// with BOTH arms populated inside one fixture — which matters, because "it never fired without
// it" is only evidence when there were swings without it to fire on.
//   16:06:46  opens ten seconds after the previous mob died, on an ashenbone drake pull that
//             runs under `recovery` — Smiting Strike and Condemnation of Nife fire, Discordant
//             Mind does NOT. This is the inactive arm: 225 logged swings.
//   16:07:02/:32/:50  recovery → divine → inversion. Three commits in 48 seconds, each ending
//             the previous span `inferred` — the game never prints "your invocation ends".
//   16:08:56  `You begin reciting the spellblade invocation.` THE COMMIT. Swinging on both
//             sides of it, 406 swings after.
//   16:09:07  the first `You hit Avatar of Abhorrence for 394 points of magic damage by
//             Discordant Mind.` — eleven seconds after the commit, and there is NO
//             `You begin casting Discordant Mind.` anywhere in the window. Fourteen firings
//             follow (5,482 damage) plus two resists, and every one is inside the span.
//   16:11:19  `inversion` again. Discordant Mind stops dead: zero firings in the 86 seconds of
//             melee that follow, while Condemnation of Nife keeps proccing.
// What it pins: withCount 14 / withoutCount 0 / inactiveSwings 225 → the ONLY 'exclusive' link
// in any of these fixtures (225 clears MIN_INACTIVE_SWINGS = 200 by 25 swings — the margin is
// real and thin, and the test says so). Beside it, in the SAME window, Smiting Strike 13/7 and
// Lifetap Strike 9/3 are 'weak' and Condemnation of Nife 0/6 is 'weak' — so one fixture proves
// the classifier separates a genuine exclusive from a merely lopsided lane.
// It also carries the healing half of Tier A: Lifetap Strike taps 12 × 458 damage and heals
// 12 × 474 — the tap returns MORE than it deals (30 dmg → 31 heal, crit 79 → 82), which any
// "healing is a subset of damage" assumption would get wrong.
slice(665925, 667420, 'w39-spellblade-switch.log')

// ---------------------------------------------------------------------------------------
// W40 INSTRUMENT OF NIFE — THE HONESTY CASE (Sun Aug 02 19:26:05 → 19:32:49, raw
// 1021992..1024215).
//
// The buff whose landing/fade messages are unique in the DB, and whose whole-log record is 99
// applies against ONE observed fade. This window is cut around the log's ONLY two applies that
// sit thirteen seconds apart, because that pair is the re-apply case the span model has to
// handle, and because it leaves a genuine — and genuinely useless — inactive arm in front.
//   19:26:05  opens three seconds after a kill, aura NOT yet observed. 36 swings happen here.
//   19:26:47  `You begin casting Instrument of Nife.`
//   19:26:48  `A brilliant blue aura surrounds your weapon.` — span opens `observed`, own-cast.
//   19:26:58  `You activate Quick Buff.`
//   19:27:01  the aura lands AGAIN, inside the Quick Buff burst (no cast line — that AA prints
//             landings only). The first span must be superseded with `endEvidence: 'inferred'`,
//             never given a fabricated expiry, and the second span stays `open` to the last line.
//   19:30:27  `Your Smite spell fizzles!` ×2, then `You begin casting Smite.`, then at 19:30:28
//             `You hit a basilisk for 95 points of magic damage by Smite.` — one second later.
//             The NEGATIVE CONTROL for the cast-less detector: a hand-cast nuke inside
//             PROC_CAST_WINDOW_MS must score proc = 0.
// What it pins: aura UP for 904 of the window's 940 swings, DOWN for 36. Condemnation of Nife
// procs 4 times, all with the aura up — and the verdict is 'inconclusive', NOT 'exclusive',
// because 36 inactive swings is not a control group. That asymmetry is the RESULT, not a defect.
// Smiting Strike fires 27 up / 1 down, which is the same verdict for the same reason and also
// proves Smiting Strike is not aura-granted.
// It doubles as the SLAY window: 15 `(Slay Undead)` hits for 7,008 damage against a 468-hit /
// 28,554 melee body, so `marginalDamage = 7008 − 15 × (28554/468)` is computable and its
// assumption is visible. Seven encounters, and the first two are the sample-floor cases: e1 is
// 5 active seconds (rates ABSENT) with 25 swings (per-100 still present), e2 is 13 seconds.
slice(1021992, 1024215, 'w40-nife-buff.log')

// ---------------------------------------------------------------------------------------
// W41 THE ROGUE COAT + ASP VENOM (Mon Aug 03 15:21:45 → 15:26:18, raw 1126794..1128400).
//
// Cut from the NEWEST poison session in the log (Mon Aug 03 14:11 → 15:55, entirely after the
// Task #64 windows were taken), because it is the only place where a coat is REPLACED twice
// while fights are running, with poison damage lanes on both sides of each swap.
// REPLAYED WITH w35-poison-coats.log AS A PRIME — the shipped W35→W36 pattern: the utility coat
// in force at the first swing was applied at 14:59:44, 22 minutes before this window opens, and
// a combat-only window cannot establish it. w35 leaves exactly that state (utility Neurotoxic +
// the three stacked combat venoms), so the prime is faithful, and the zone aggregate is
// byte-identical primed or not (dur 253 / act 250 / out 36,323) because w35's own zone
// finalizes first.
//   15:21:45  opens on `Auto attack is on.` for the Stonesoul the Unmoving pull.
//   15:23:32  `The poison dries from the blade.` AND `You coat your blades in mage bane poison.`
//             in the SAME SECOND — the utility slot being replaced mid-fight. The combat venoms
//             are untouched and keep proccing, which is the two-slot model's whole point.
//   15:25:33  dry + `… in a neurotoxic poison.` — swapped back, again mid-fight.
//   15:26:08/:14  `You hit an elemental crusader for 53 points of poison damage by Asp Venom
//             Strike.` ×2 — a COMBAT venom coated hours earlier still firing, under a utility
//             coat that has now been swapped twice.
// What it pins: the coat spans (`observed` starts, `inferred` ends when a coat replaces one),
// coatAtEngage per fight (Neurotoxic for Stonesoul → slowExpected TRUE with 4 slow landings;
// Mage Bane for the next two → slowExpected FALSE, and the mid-fight re-coat does NOT
// retroactively relabel the engage state); Asp Venom Strike 2 × 106 as a poison DAMAGE lane;
// and Blood Siphon Strike as the awkward one — 14 damage ticks for 658 that parse as `dot`
// (`<mob> has taken 47 damage from your Blood Siphon Strike.`), 13 heal lines for 611, and only
// 4 emotes in the shipped strike ledger. Three different counts of "the same" proc, all correct
// for their own question. The plan's detector is gated OFF `dot` on purpose, so this lane can
// only ever be a 'poison'-origin lane, never a 'spell' one.
slice(1126794, 1128400, 'w41-poison-asp-venom.log')

// ---------------------------------------------------------------------------------------
// THE ACCURACY WAVE (owner report, 2026-08-04). Two more windows, each cut around ONE of the
// two defects the report named, and each chosen so the answer is legible by eye.
//
// (The third case the report needed — a Quick Buff burst delivering buffs with no cast line —
// is ALREADY a committed fixture: `w7-quick-buff.log` ends on `You activate Quick Buff.` at
// 20:29:44 followed by `You healed Primitive for 216 hit points by Valor.` and
// `… 331 hit points by Symbol of Pinzarn.` at 20:29:46. Cutting a second window for it would
// duplicate a shipped one.)

// ---------------------------------------------------------------------------------------
// W42 THE EFFECT PROC: LANDS AND RESISTS, ON THE SAME LANE (Mon Aug 03 23:00:40 → 23:05:15,
// raw 1210281..1212412).
//
// DEFECT 1's window. A Lord of Ire pull followed by four more, run with the rogue's utility
// coat on, where the same Strikes both LAND and get RESISTED — which is the pairing the drill
// could not see, because a landing prints an emote that names no spell and a resist prints the
// spell name and no emote.
//   23:00:48 / 23:01:08 / 23:01:11 / 23:01:23  `Lord of Ire resisted your Weakening Strike!` ×4
//   23:02:23                                    `Lord of Ire's limbs move slower!` — the SAME
//             lane landing on the SAME mob, 60 seconds later. Four resists and a landing, and
//             before this wave the drill row for it read `0 landed · 4 resisted`.
//   23:00:56 / 23:01:45 / 23:01:54              `… resisted your Clumsiness Strike!` ×3, with
//             `Cleric of Innoruuk's fingers slow down.` landings on either side of the pull.
//   23:05:01  `You begin casting Divine Stun I.` AND `A forsaken revenant resisted your Divine
//             Stun I!` in the same second — the OTHER shape, and the one that must stay
//             withheld: Divine Stun deals no damage and prints NOTHING when it lands, so its
//             resist rate has no denominator and the row may not claim one.
//   23:01:20 / 23:02:02  `You begin casting Ethereal Cleansing.`, whose ticks then run to
//             23:02:43 — 41 seconds past the second cast, well outside PROC_CAST_WINDOW_MS.
//             DEFECT 2's HoT case, in the same window: every one of those ticks says
//             `healed Primitive over time for 102`, and the gate refuses them on the wording
//             rather than on the clock.
slice(1210281, 1212412, 'w42-effect-proc-resist.log')

// ---------------------------------------------------------------------------------------
// W43 EARTHQUAKE — THE TRUE PROC THAT MUST STAY TAGGED (Mon Aug 03 21:05:16 → 21:07:38, raw
// 1182112..1183531).
//
// The owner's report listed `Earthquake` among the spells they believed they were casting. The
// log says otherwise, and this window is the evidence: `You begin casting Earthquake.` appears
// ZERO times in the entire 1.24M-line log, while `You hit <mob> for 246 points of magic damage
// by Earthquake.` appears 87 times, always in AoE bursts of 2–4 targets in ONE second, each
// followed by `<mob> is smashed by the heaving ground.` It is the proc on the Boon of the Garou
// illusion (an enchanter in General chat says so in the same log), and no cast-pairing rule of
// any width can demote it, because there is no cast to pair with.
//   21:05:31  a single-target firing on an elemental channeler for 74 — mid-melee, no cast.
//   21:06:04  FOUR targets in one second for 246 each — the AoE shape.
//   21:06:16 / 21:06:53…21:07:07  `Lay on Hands IX` and four `Greater Healing` casts, so the
//             window also proves the detector is not simply calling everything a proc.
// What it pins: Earthquake stays `origin: 'spell'` with its firings intact, and its rate is
// `sourceAmbiguous` — the illusion that grants it opens no span this model tracks, so the ppm
// assumes it was up all along and SAYS so, rather than quietly pretending to know.
slice(1182112, 1183531, 'w43-earthquake-proc.log')
