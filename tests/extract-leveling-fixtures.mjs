// Leveling fixture extractor (loadout-swap golden window). Slices the real log and keeps
// every line the LevelingModule consumes (level-ups, AA gains, AA purchases) plus the
// self `/who` line — which is the ONLY place the log ever states the class loadout, and
// which proves the level is a SINGLE number shared by three classes
// (`[50 PAL/MNK/ENC] Primitive (Dark Elf)`), not three concurrent levels.
//
// Usage: node tests/extract-leveling-fixtures.mjs "<path to eqlog_Primitive_freeport.txt>"
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
  /You have gained a level! Welcome to level \d+!$/,
  /gained \d+ ability point/,
  /You have gained the ability "/,
  /You have improved .+ \d+ at a cost of/,
  // self /who — documentary evidence of the one-level / three-class loadout
  /^\[[^\]]+\] \[\d+ [A-Z]{3}(?:\/[A-Z]{3})*\] Primitive /
]
// Routed through the SHARED scrub (tests/fixture-scrub.mjs) like every other extractor. The
// self `/who` row survives because the scrub exempts the user's OWN character by name; every
// other player's `/who` row is dropped there, not here.
const keep = (l) => l.startsWith('[') && scrubKeep(l) && KEEP.some((re) => re.test(l))

function slice(fromLine, toLine, out) {
  const seg = []
  for (let i = fromLine - 1; i < toLine && i < lines.length; i++) if (keep(lines[i])) seg.push(lines[i])
  writeFileSync(join(FIXTURES, out), seg.join('\n') + '\n')
  console.log(`${out}: ${seg.length} lines (from raw ${toLine - fromLine + 1})`)
}

// WL1 LOADOUT SWAP. Real span 669590 (Fri Jul 31 16:19:04, "Welcome to level 50!") ..
// 975780 (Sun Aug 02 02:26:50, "Welcome to level 13!"). Between them the user swapped a
// class into the loadout: the reported level fell 50 → 10 with NO log line of any kind
// (verified: every "loadout"/"swap"/"class" string in the whole 985k-line log is another
// player's chat), and the next thing the log says is "Welcome to level 11!". The window
// also carries the Jul 31 23:48 self /who at `[50 PAL/MNK/ENC]` — pre-swap loadout, one
// level for three classes.
slice(669590, 975780, 'wl1-loadout-swap.log')
