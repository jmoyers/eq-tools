// One-off LOOT fixture extractor (Task #47) — sibling of extract-fixtures.mjs (which is
// buffs-oriented and drops loot lines). Slices line ranges from the real log keeping only
// the lines the loot family cares about (loot + zone), so fixtures stay small and
// reviewable but replay through the real parser + LootModule is faithful.
//
//   node tests/extract-loot-fixtures.mjs "<path-to-eqlog>"
//
// Line numbers below were located in eqlog_Primitive_freeport.txt on 2026-08-02;
// re-locate if the log is truncated/rotated.
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// Fixtures resolve RELATIVE to this file — the repo moved once and these extractors kept
// writing into the old absolute path. Never hardcode a repo path here again.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const LOG = process.argv[2]
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

const KEEP = [
  /\] --You have looted /,
  /\] You looted /,
  /\] You have entered /
]
function keep(line) {
  if (!line.startsWith('[')) return false
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

// W19 DRAGON HOARD: the Jul 30 22:36–23:06 Plane of Fear gear session — a run of
// "… and stored it in your Dragon Hoard" loots (Blighted Gloves ×2, Vermiculated
// Bracelet +1, Umbral Platemail Gauntlets +1 with the "an" article, …).
slice(598500, 609900, 'w19-hoard.log')
// W19b TRADESKILL DEPOT: the Aug 1 00:28:20 "Griffenne Blood … stored it in your
// tradeskill depot" line (one of only two in the whole log).
slice(793350, 793410, 'w19b-depot.log')
// W20 COMBINE/UPGRADE: the Jul 19 08:48–09:39 lowbie session — "You looted <item> …
// to create a <item> +N" upgrade lines (Thaumaturgist's Robe → +2 twice incl. a
// same-second double combine, Antiqued Silver Band → "an" article on the created item).
slice(2560, 15115, 'w20-combine.log')
// W21 STACKED COUNTS: the Jul 20 19:01–20:34 session — dashed "--You have looted 2 Bone
// Chips …--" kept stacks AND "You looted 2 Phosphorous Powder … and sold it …" sold
// stacks (the old regexes swallowed the digits into the item name).
slice(151440, 169545, 'w21-stacked.log')
