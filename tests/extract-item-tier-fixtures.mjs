// ITEM-TIER golden-window fixture extractor (Task #60 — observed item levels).
//
// Cuts VERBATIM spans of the real log (only third-party chat/social dropped, via the shared
// scrub tests/fixture-scrub.mjs — never a hand-copied or rewritten line) into
// tests/fixtures/. Fixtures are COMMITTED and CI runs them, so this must be DETERMINISTIC:
// re-running it against the same log rewrites every file byte-identically.
//
// Usage: node tests/extract-item-tier-fixtures.mjs "<path to eqlog_Primitive_freeport.txt>"
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { scrubKeep } from './fixture-scrub.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG = process.argv[2]
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

/** Collect a raw 1-based inclusive line range, scrubbed. */
function span(fromLine, toLine) {
  const seg = []
  for (let i = fromLine - 1; i < toLine && i < lines.length; i++) {
    const l = lines[i]
    if (!l.startsWith('[')) continue
    if (!scrubKeep(l)) continue
    seg.push(l)
  }
  return seg
}

/** Write one fixture from one or more raw spans (concatenated in the order given). */
function slice(out, ...ranges) {
  const seg = ranges.flatMap(([from, to]) => span(from, to))
  writeFileSync(join(HERE, 'fixtures', out), seg.join('\n') + '\n')
  const raw = ranges.reduce((n, [from, to]) => n + (to - from + 1), 0)
  console.log(`${out}: ${seg.length} lines (from raw ${raw})`)
}

// W30 THE MERGE RUN (Sat Aug 01 01:40:18 → 01:57:07, raw 814584..814725). The user levels
// THREE items back to back, and the span is chosen because it contains the two things a
// naive "latest tier wins" model gets wrong:
//   • Whitened Treant Fists  +1, +2, +2, +3, +3, +4 — SIX merges but repeated tiers, because
//     two physical copies are being levelled in parallel. The last line the model sees for
//     the item is +4 here, but the +3/+3 pair proves the sequence is not monotonic.
//   • Thelvorn, Blade of Light  +1, +2, +2, +3, +3, +4, +5 — same shape, and its name carries
//     a COMMA, so it also pins that the result capture takes the whole rest of the line.
//   • Umbral Platemail Bracer  +1, +2, +2.
// A `The item you are trying to add will not work, this mote is not sufficiently powerful to
// upgrade this item.` failure sits between the first two Fists merges (01:40:30) — the tier
// must NOT move for it. Ordinary combat, loot (a sold + a currency line, neither carrying a
// tier) and turn-ins ride along untouched.
slice('w30-item-merge-run.log', [814584, 814725])

// W31 BOTH MERGE EVIDENCE SOURCES IN ONE SPAN (Tue Jul 28 23:40:54 → 23:42:57, raw
// 295840..296160). The merge LINE and the auto-merge-on-pickup LOOT line are two different
// log families that report the same mechanic, and the module has to fold both:
//   • `You have successfully merged …: Ghoulbane +1` then `+2` (23:40:54/58), plus
//     `Bracers of Erollisi +1` and `Antiqued Silver Band +1` — the merge family.
//   • `You looted a Mesh Bracers from a froglok shin warrior's corpse to create a Mesh
//     Bracers +2` (23:42:57) — the loot family's 'combined' disposition, whose `created`
//     names the resulting tier. Nothing else in the log reports that upgrade.
slice('w31-item-merge-sources.log', [295840, 296160])

// W32 THE FAILURE THAT NAMES ITEMS (Sat Aug 01 01:15:36 → 01:16:41, raw 805225..805305).
// All four `Your request to merge <target> with <component> failed. …` lines in the entire
// log live in this one minute. NOTHING was upgraded — but the line quotes the user's own
// item verbatim (`Valorium Bracers +2`, `Boots of the Long Road +1`), which is a direct
// statement of a tier sitting in their bags. Neither item is merged inside this span, so the
// window proves the failure line ALONE establishes a tier while leaving the merge count at 0.
slice('w32-item-merge-failures.log', [805225, 805305])

// W33 THE EPOCH BOUNDARY (two real spans, concatenated — the same construction
// tests/fixtures/epoch-beta-wipe.log uses, for the same reason: the two sides of the launch
// boundary are 60k lines apart and only the merge lines matter).
//   BETA side  (Sun Jul 19 20:46:37 → 20:47:04, raw 113160..113182): the WIPED character
//     merging `Kitchen Toolbelt +4` twice. That character got a Toolbelt to +5 and Pristine
//     Studded Leather to +4 — none of it in the current character's bags.
//   CURRENT side (Tue Jul 28 15:10:11 → 15:10:42, raw 190566..190578): the first line is
//     at/after the 2026-07-28 launch instant, so it trips the EpochDetector; then
//     `Enchanted Fine Steel Morning Star +1, +1, +2` — the live character's own merges.
// Post-epoch the toolbelt must be GONE (not "tier 0" — absent), the morning star present.
slice('w33-item-tier-epoch.log', [113160, 113182], [190566, 190578])
