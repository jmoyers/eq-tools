// Combat golden-window fixture extractor (Task #55 — multi-mob pull segmentation).
//
// Unlike extract-fixtures.mjs (buffs/entity windows, which prune aggressively to the
// lifecycle lines), COMBAT windows must replay the fight VERBATIM: every damage / miss /
// resist / heal / death line is load-bearing for segmentation and for the byte-identical
// damage tripwire. So this slicer keeps the raw span and drops ONLY player chat spam
// (tells/says/auctions/shouts/OOC), which can never affect the combat model but bloats
// the fixture and leaks other players' conversations into the repo.
//
// Usage: node tests/extract-combat-fixtures.mjs "<path to eqlog_Primitive_freeport.txt>"
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG = process.argv[2]
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

// Player chat only. `told you, '… Master.'` (the pet-claim binding) is a DIFFERENT shape
// ("told you", not "tells <channel>:<n>") and is deliberately NOT dropped.
const DROP = [
  / tells [^,]+, '/,
  / says,? '/,
  / auctions,? '/,
  / shouts,? '/,
  / (tells you|told the guild),/
]
const drop = (line) => DROP.some((re) => re.test(line))

function slice(fromLine, toLine, out) {
  const seg = []
  for (let i = fromLine - 1; i < toLine && i < lines.length; i++) {
    const l = lines[i]
    if (!l.startsWith('[')) continue
    if (drop(l)) continue
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
