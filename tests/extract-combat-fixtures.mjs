// Combat golden-window fixture extractor (Task #55 — multi-mob pull segmentation).
//
// Unlike extract-fixtures.mjs (buffs/entity windows, which prune aggressively to the
// lifecycle lines), COMBAT windows must replay the fight VERBATIM: every damage / miss /
// resist / heal / death line is load-bearing for segmentation and for the byte-identical
// damage tripwire. So this slicer keeps the raw span and drops ONLY what the shared scrub
// (tests/fixture-scrub.mjs) classifies as third-party chat/social — which can never affect
// the combat model but bloats the fixture and would leak other players into a PUBLIC repo.
//
// Usage: node tests/extract-combat-fixtures.mjs "<path to eqlog_Primitive_freeport.txt>"
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

// W24 MULTI-MOB PULL MUST BE ONE ENCOUNTER (Sun Aug 02 15:30:23 → 15:32:17, raw
// 991860..992222). Three things had to be inside the span:
//   1. A CLEAN start: the PREVIOUS fight (a Teir`Dal rogue) is already in progress and is
//      slain at 15:30:27, then 12s of silence — so the V`Zher pull provably opens its own
//      encounter and the window contains exactly TWO fights, not one merged blob.
//   2. The whole two-mob pull: Soldier of V`Zher + Baron Telyx V`Zher both land damage on
//      YOU from 15:30:39; the Baron even HEALS the Soldier at 15:31:01 (hostile-on-hostile
//      heal = presence evidence for both); the Soldier dies 15:31:09 and the Baron fight
//      continues unbroken to his death at 15:32:00.
//   3. Trailing quiet (to 15:32:17) so the encounter's death-linger closure is observable.
slice(991860, 992222, 'w24-multi-mob-no-split.log')

// W25 PER-MOB GHOST ROWS (Task #58) — the "Damage by mob" panel showed FOUR rows for a
// two-mob widow fight: the two real instances plus two 0-damage phantoms. This is the
// user's actual widow session in Steamfont (Sun Aug 02 16:50:57 → 16:53:23, raw
// 1006240..1007109), which reproduces BOTH phantoms verbatim:
//   1. a bare "a deadly black widow" row — miss ticks carried the RAW log name while
//      damage ticks carried the world-model INSTANCE label ("… (7)" / "… (8)").
//   2. an "on a deadly black widow" row — the frenzy miss family ("You try to frenzy ON
//      X, but miss!") leaked the preposition into the target capture; the LANDED form
//      ("You frenzy on X for N points…") always parsed clean.
// Three fights are inside the span, and all three are load-bearing:
//   16:50:57–16:52:09  a six-widow blob (gens 1–6) — proves the per-instance split of a
//                      long chain of misses, and that the bare gen-1 row is REAL here.
//   16:52:14–16:52:32  a vampire-bat fight containing ONE stray whiff at a widow that is
//                      not engaged in it — the case that must NOT spawn a world instance
//                      (if it did, the widows below would renumber to (8)/(9)).
//   16:52:38–16:53:22  THE REPORTED FIGHT: exactly two widow instances, gens 7 and 8,
//                      with 56 outgoing misses (4 of them frenzy) to distribute.
slice(1006240, 1007109, 'w25-per-mob-miss-ghosts.log')

// ---------------------------------------------------------------------------
// HEALING + ABSORPTION windows (Task #59). Three compact real spans, each cut to isolate one
// family the healing meter has to get right. All three are Befallen (Sun Aug 02) and Freeport
// (Sun Aug 02) fights from the user's own session.
// ---------------------------------------------------------------------------

// W26 CRITICAL HEALS (Sun Aug 02 17:10:51 → 17:11:39, raw 1011100..1011400). A ghoul-knight
// grind with four self-heals, ONE of which carries the trailing `(Critical)` modifier that the
// old `\.$`-anchored HEAL_RE rejected outright — 233 real heals were silently dropped log-wide.
// Two rune grants ride along, so the same window also proves absorption stays OUT of healing.
slice(1011100, 1011400, 'w26-healing-crit.log')

// W27 OVERHEAL + ABSORBED SWING (Sun Aug 02 17:13:50 → 17:14:49, raw 1011923..1012345). The
// overheal form is here verbatim — `You healed Primitive for 1351 (5968) hit points by Lay on
// Hands VI.` — alongside four plain heals (raw == effective ⇒ zero waste), eleven rune grants,
// and the one line in the span where YOUR rune eats a swing outright
// (`… but YOUR magical skin absorbs the blow! (Riposte)`), which carries NO amount.
slice(1011923, 1012345, 'w27-healing-overheal-absorb.log')

// W28 ENEMY COUNTER-HEALING + ABSORBED DAMAGE SHIELDS (Sun Aug 02 15:55:20 → 15:55:42, raw
// 997999..998129). A Teir`Dal ranger fight where the mob SELF-HEALS mid-fight
// (`a Teir`Dal ranger healed herself for 64 hit points by Skin like Rock.`) — counter-healing
// that undid our damage and must rank on its own ledger, never in "who kept me alive". The
// ranger also runs a thorns damage shield, so the span carries the third absorption family:
// `YOUR magical skin absorbs the damage of a Teir`Dal ranger's thorns.` (count-only).
slice(997999, 998129, 'w28-healing-enemy-thorns.log')

// ---------------------------------------------------------------------------
// W29 BOTH ABSORB SHAPES IN ONE WINDOW — the MISS_RE self-absorb fix.
// ---------------------------------------------------------------------------
//
// MISS_RE's absorb alternative used to require a POSSESSIVE `<name>'s magical skin`, so the SELF
// form (`<mob> tries to <verb> YOU, but YOUR magical skin absorbs the blow!`) never matched and
// fell through to 'unknown'. Full-log sweep: 385 self-form lines dropped vs 1,428 possessive
// lines parsed. Every dropped line is an INCOMING avoided swing, so the loss was a silent
// undercount in the incoming miss aggregates (addIncMiss) and in defensive hit%.
//
// This span (Sun Aug 02 15:25:34 → 15:26:04, raw 990649..990795) is the tightest real window that
// carries BOTH shapes back to back, so one replay proves the fix AND proves the possessive path
// is untouched. It opens on `Auto attack is on.` five seconds after the previous fight's mob died
// (raw 990644), so the first encounter here provably starts clean. It holds two back-to-back
// PULLS, which the engine correctly keeps as ONE encounter (the second mob lands damage 4s after
// the first dies — inside the death-linger, law 7):
//   15:25:34–15:25:43  Kahaptra Z`Taj — a named mob running BOTH a rune and a thorns shield.
//                      THREE possessive absorbs (`You try to slash Kahaptra Z`Taj, but Kahaptra
//                      Z`Taj's magical skin absorbs the blow!`) = the mob's own rune eating OUR
//                      swings, which must stay OUTGOING misses and must never be credited to our
//                      mitigation. Four `YOUR magical skin absorbs the damage of …'s thorns.`
//                      ticks ride along (the third absorption family, count-only).
//   15:25:47–15:26:03  a Teir`Dal priest — TWO self absorbs (`A Teir`Dal priest tries to bash/
//                      crush YOU, but YOUR magical skin absorbs the blow!` @15:25:57 and
//                      @15:26:01), the previously-dropped lines, alongside three plain incoming
//                      misses so the aggregate they belong in is populated either way.
// The window ends on the loot line after the priest dies, one second before the next pull opens.
slice(990649, 990795, 'w29-absorb-both-shapes.log')

// ---------------------------------------------------------------------------
// W34 SENTENCE-CASE SPLITS ONE MOB IN TWO — the world-model display-casing fix.
// ---------------------------------------------------------------------------
//
// The "Damage by mob" panel showed BOTH `a zol ghoul knight (230)` and
// `A zol ghoul knight (230)` — one instance, two rows, the capitalized one carrying only a
// resist. EQ capitalizes a lowercase-article mob name at the START of a sentence, so the
// SAME spawn is printed two ways: mid-sentence (`You slash a zol ghoul knight for 19…`) it
// carries its true name, sentence-initial (`A zol ghoul knight resisted your Condemnation of
// Nife!`, `A zol ghoul knight hits YOU for 17…`) it is capitalized. WorldModel.resolve()
// adopted the LATEST sighting's casing, so the instance display flip-flopped and whichever
// timeline instant was written while it was sentence-cased froze the wrong string. Aggregate
// rows key by instanceId so they merely relabel; the timeline's per-mob grouping keys by the
// RAW target string, so it split.
//
// THE WINDOW (Sun Aug 02 19:28:01 → 19:29:15, raw 1022491..1023067) is the user's actual
// reported fight in Befallen, and it is self-contained:
//   19:28:01  opens on `Auto attack is on.` six seconds after the PREVIOUS zol knight was
//             slain (raw 1022489) — so the first damage here provably opens a fresh encounter.
//   19:28:01→ a continuous zol-ghoul-knight grind (three knights + an urd ghoul wizard, all
//             slain inside the span) whose outgoing damage lines are all LOWERCASE and whose
//             incoming melee lines are all sentence-CAPITALIZED — the flip-flop driver.
//   19:28:52  `A zol ghoul knight resisted your Condemnation of Nife!` — THE reported tick,
//             sentence-initial, on a knight that took `You backstab a zol ghoul knight for
//             177…` one second later and damage before it.
//   19:29:15  the last knight is slain + its loot lines; the span ends on the buff-fade line
//             that follows, so the encounter closes on evidence rather than mid-swing.
slice(1022491, 1023067, 'w34-resist-case-merge.log')

// ---------------------------------------------------------------------------
// ROGUE POISONS (Task #64) — the two windows behind the poison/proc model.
//
// The user's log holds exactly ONE rogue-poison session (Mon Aug 03 01:05–01:33, the tail of
// the file): 6 coat lines, 2 dry lines, 25 slow landings log-wide of which 16 fall inside
// this session, and every Strike-proc emote family the model recognizes. Both windows are
// cut from it, and W35 is designed to be replayed as a PRIME for W36 — the coat that makes
// the whole fight sequence slow-capable is applied 7 minutes before the first swing, so a
// combat-only window cannot establish it.
// ---------------------------------------------------------------------------

// W35 THE COAT SEQUENCE (Mon Aug 03 01:05:08 → 01:23:00, raw 1100627..1100792). Small and
// dense: every coat the user has ever applied, in order, with the two replacement `dries`
// lines and both third-person forms. Hand-read, load-bearing beats:
//   01:05:08/10  activate + `You coat your blades in asp venom.`         → COMBAT (Asp Venom)
//   01:05:11/13  `… in a siphoning poison.`                              → COMBAT (Blood Siphon)
//   01:05:33/36  `… with a stunning agent.`                              → COMBAT (Stunning)
//   01:06:14/16  `… in a neurotoxic poison.`                             → UTILITY (Neurotoxic)
//   01:06:44/47  `The poison dries from the blade.` THEN `… in mage bane poison.` — the
//                utility slot being REPLACED, both lines in the same second. This pair is
//                why a utility coat must be a single slot and a dry must not clear the
//                combat venoms: all three of those stay up through the fights in W36.
//   01:16:26/29  dry + `… in a neurotoxic poison.` again — Mage Bane is swapped back out, so
//                the coat active for every fight in W36 is Neurotoxic (slow-capable).
//   01:19:30     `Skandercoats their blades in poison.` — ANOTHER PLAYER's coat, verbatim
//                with the game's missing space. It must parse (who != you) and must NOT
//                touch your own slots.
// The span ends one line before the zone entry W36 opens on.
slice(1100627, 1100792, 'w35-poison-coats.log')

// W36 SLOW TIME-TO-LAND (Mon Aug 03 01:23:01 → 01:26:47, raw 1100793..1102500). The first
// ~4 minutes of the Ruins of Old Paineel grind that follows the W35 coats, chosen because it
// is the shortest span holding SEVERAL pulls with a mix of slow-landed and slow-never-landed
// fights — the two halves of the honest denominator. Hand-read beats:
//   01:23:01  `You have entered The Ruins of Old Paineel.` — a clean zone boundary, so the
//             window opens with an empty zone aggregate.
//   01:23:13  first outgoing damage (an elemental warrior) — the first pull's engage instant,
//             which is the t0 every time-to-slow below is measured from.
//   01:23:15  `You hit … by Asp Venom Strike.` + `screams as poison burns their veins!` — a
//             COMBAT venom proccing while the UTILITY coat is Neurotoxic. Impossible under a
//             one-poison model; this is the line that proves the two-slot design.
//   01:23:33  `stumbles, clutching their head!` (Befuddling Strike — Neurotoxic's other proc)
//   01:24:29  `an elemental warrior's limbs move slower!` — THE slow landing.
//   01:26:03  and 01:26:19 two more slow landings on a rock golem.
//   01:26:0x  `begins to sway!` (Stunning Strike) and `begins to bleed profusely!` (Blood
//             Siphon Strike) — the remaining two combat venoms' procs, so all four active
//             poisons are represented.
// The window ends mid-grind rather than on a death: the last encounter is still open, which
// is exactly the LIVE case the meter's "slow: not landed" chip has to render honestly.
slice(1100793, 1102500, 'w36-poison-slow-timing.log')

// W37 DISPEL VARIANTS ARE NOT A ROGUE PROC (Mon Aug 03 00:38:18 → 00:40:02, raw
// 1095620..1096030) — the Efreeti Lord Djarn kill, cut because it is the densest dispel
// window in the log and because it sits BEFORE the poison session (the first coat is at
// 01:05), which makes it the negative case for every poison assertion at the same time.
// Hand-read beats:
//   00:38:18→ the Djarn fight already underway: his damage shield, his rune eating our swings.
//   00:39:02, :07, :16, :24  `Efreeti Lord Djarn feels a bit dispelled.` ×4. That message is
//             the Cancel Magic FAMILY's landing line (Cancel Magic | Phobocancel — eleven
//             classes plus NPCs cast it), so the lane must be counted exactly, labeled with
//             both candidates, and flagged ambiguous. The rogue's own dispel proc would print
//             `'s blessings wither!`; this window has none, and neither does the whole log.
//   00:39:59  `You have slain Efreeti Lord Djarn!` — the fight closes on evidence.
// No coat has ever been applied at this point in the log, so this encounter must report
// slowExpected:false and an EMPTY strike ledger — a poison feature that lights up on a fight
// with no poison would be worthless.
slice(1095620, 1096030, 'w37-dispel-variants.log')
