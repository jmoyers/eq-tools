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
