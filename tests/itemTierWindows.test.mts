// GOLDEN-WINDOW ITEM-TIER TESTS — W30–W33 (Task #60): observed item levels.
//
// METHODOLOGY (AGENTS.md): every window is a VERBATIM span of the user's real log, cut by
// tests/extract-item-tier-fixtures.mjs through the shared scrub, hand-read line by line, and
// replayed through the REAL parser + ItemTiersModule. The expectations below are what a
// human counted in the fixture, not what the code produced.
//
//   W30  the merge run (Aug 01 01:40–01:57) — three items levelled at once, with REPEATED
//        tiers (two copies climbing in parallel) and a failed mote merge in the middle.
//   W31  both evidence families in one span (Jul 28 23:40–23:42) — merge lines AND the
//        auto-merge-on-pickup loot line whose `created` names the result.
//   W32  the only four `Your request to merge <A> with <B> failed.` lines in the log — no
//        upgrade happened, but the line states a tier the user is holding.
//   W33  the launch/epoch boundary — the wiped beta character's merges must not survive.
//
// Plus a FULL-LOG tripwire that asserts INVARIANTS only (the log is live and grows; frozen
// counts rot): tier ranges, key canonicalization, the epoch floor on every row, and the
// direction of the contamination the epoch removes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { EpochDetector, LAUNCH_MS } from '../src/main/log/epochDetector'
import { ItemTiersModule } from '../src/main/modules/itemTiers'
import { ITEM_MAX_TIER, itemTierKey } from '../src/shared/itemStats'
import { itemCountKey } from '../src/renderer/src/lib/itemName'
import type { ItemTiersSnap } from '../src/shared/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

function readFixture(name: string): string[] {
  return readFileSync(join(HERE, 'fixtures', name), 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
}

/**
 * Replay raw lines through the real parser + ItemTiersModule. With `withEpoch`, the REAL
 * EpochDetector runs exactly as index.ts's feeder wires it: the primary event is folded
 * first, then the synthesized `epoch` event is delivered (bus.emitDerived semantics).
 */
function replay(lines: string[], withEpoch = false): ItemTiersSnap {
  const mod = new ItemTiersModule()
  mod.reset()
  const epoch = new EpochDetector()
  epoch.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    mod.onEvent(ev, false)
    if (withEpoch) {
      const epochEv = epoch.observe(ev)
      if (epochEv) mod.onEvent(epochEv, false)
    }
  }
  return mod.snapshot().state
}

// ─────────────────────────────────────────────────────────────────────────────
// W30 — the merge run. HAND-READ from tests/fixtures/w30-item-merge-run.log:
//   01:40:18  Whitened Treant Fists +1
//   01:40:30  (mote too weak — FAILED, nothing upgraded)
//   01:40:43  +2   01:40:54  +2   01:40:58  +3   01:41:08  +3   01:41:18  +4
//   01:51:13  Umbral Platemail Bracer +1   01:51:16  +2   01:51:19  +2
//   01:55:19  Thelvorn, Blade of Light +1  01:56:05 +2  01:56:11 +2  01:56:27 +3
//   01:56:33  +3   01:56:47 +4   01:57:07 +5
test('W30 merge run: highest tier wins over "latest", and a failed merge moves nothing', () => {
  const tiers = replay(readFixture('w30-item-merge-run.log'))

  // Whitened Treant Fists: SIX merges, tiers 1,2,2,3,3,4 — repeated tiers because two
  // copies are being levelled in parallel. Highest observed is 4.
  const fists = tiers['whitened treant fists']
  assert.ok(fists, 'the Fists row exists')
  assert.equal(fists.tier, 4, 'highest observed tier')
  assert.equal(fists.lastTier, 4, 'the last result in the window was +4')
  assert.equal(fists.merges, 6, 'six merge lines (the mote failure is NOT one)')
  assert.equal(fists.name, 'Whitened Treant Fists', 'display name keeps its raw base form')
  assert.equal(fists.key, 'whitened treant fists')

  // Umbral Platemail Bracer: +1, +2, +2 — the LAST line says +2 and so does the max, but the
  // repeat proves two instances; merges counts lines, not tiers.
  const bracer = tiers['umbral platemail bracer']
  assert.ok(bracer && bracer.tier === 2 && bracer.lastTier === 2 && bracer.merges === 3)

  // Thelvorn, Blade of Light: the COMMA in the name must survive the result capture, and the
  // run ends at +5 after seven merges (with the +2/+2 and +3/+3 repeats).
  const blade = tiers['thelvorn, blade of light']
  assert.ok(blade, 'a comma in the item name does not break the capture')
  assert.equal(blade.name, 'Thelvorn, Blade of Light')
  assert.equal(blade.tier, 5)
  assert.equal(blade.merges, 7)

  // Exactly three items were upgraded in this window — the sold/currency loot lines in the
  // span (Bracelet of Exertion, Wind Rune Meda) are NOT merge evidence and mint no rows.
  assert.deepEqual(Object.keys(tiers).sort(), [
    'thelvorn, blade of light',
    'umbral platemail bracer',
    'whitened treant fists'
  ])

  // Ordering sanity: first observation precedes the last, and both are inside the window.
  for (const row of Object.values(tiers)) assert.ok(row.firstAt <= row.lastAt)
})

// ─────────────────────────────────────────────────────────────────────────────
// W31 — HAND-READ from tests/fixtures/w31-item-merge-sources.log:
//   23:40:54  Ghoulbane +1      23:40:58  Ghoulbane +2
//   23:41:20  Bracers of Erollisi +1
//   23:41:36  Antiqued Silver Band +1
//   23:42:57  You looted a Mesh Bracers … to create a Mesh Bracers +2   (auto-merge loot)
test('W31 both evidence families: the merge line AND the auto-merge loot line raise tiers', () => {
  const tiers = replay(readFixture('w31-item-merge-sources.log'))

  const ghoulbane = tiers['ghoulbane']
  assert.ok(ghoulbane && ghoulbane.tier === 2 && ghoulbane.merges === 2, 'Ghoulbane +1 then +2')
  assert.ok(tiers['bracers of erollisi']?.tier === 1)
  assert.ok(tiers['antiqued silver band']?.tier === 1)

  // The loot family's 'combined' disposition is the ONLY report of this upgrade — no merge
  // line exists for it anywhere in the log.
  const mesh = tiers['mesh bracers']
  assert.ok(mesh, 'the auto-merge-on-pickup loot line created a tier row')
  assert.equal(mesh.tier, 2, 'the `created` name carries the reached tier')
  assert.equal(mesh.merges, 1)
  assert.equal(mesh.name, 'Mesh Bracers', 'the CONSUMED copy\'s name is not what we record')

  // The span is full of ordinary loot and combat; only the five upgrades above make rows.
  assert.equal(Object.keys(tiers).length, 4, 'four distinct items upgraded in the window')
})

// ─────────────────────────────────────────────────────────────────────────────
// W32 — the four failure lines. HAND-READ from tests/fixtures/w32-item-merge-failures.log:
//   01:15:36 / 01:15:51 / 01:16:12  merge Valorium Bracers +2 with Valorium Bracers — failed
//   01:16:41                        merge Boots of the Long Road +1 with Boots … — failed
test('W32 failed merges: the line still states a tier you hold, but nothing was merged', () => {
  const tiers = replay(readFixture('w32-item-merge-failures.log'))

  const valorium = tiers['valorium bracers']
  assert.ok(valorium, 'the failure line names an item we hold at a known tier')
  assert.equal(valorium.tier, 2, '`Valorium Bracers +2` is quoted verbatim')
  assert.equal(valorium.merges, 0, 'a failure is NOT a merge')

  const boots = tiers['boots of the long road']
  assert.ok(boots && boots.tier === 1 && boots.merges === 0)

  // The COMPONENT (`… with Valorium Bracers`) carries no tier and must not invent one, and
  // no other row appears from an 80-line window of combat and loot.
  assert.equal(Object.keys(tiers).length, 2)
})

// ─────────────────────────────────────────────────────────────────────────────
// W33 — the epoch boundary. HAND-READ from tests/fixtures/w33-item-tier-epoch.log:
//   BETA (Jul 19 20:46-20:47): a sold `Rusty Long Sword +4` loot, then TWO
//                              `Kitchen Toolbelt +4` merges by the character that was wiped.
//   CURRENT (Jul 28 15:10, the first at/after-launch event trips the epoch):
//                              `Enchanted Fine Steel Morning Star +1, +1, +2`.
test('W33 epoch: the wiped beta character\'s merges do not survive the boundary', () => {
  const lines = readFixture('w33-item-tier-epoch.log')

  // WITHOUT the epoch reset (the contaminated view): the beta toolbelt is right there.
  const contaminated = replay(lines, false)
  assert.equal(contaminated['kitchen toolbelt']?.tier, 4, 'no-reset: the beta +4 toolbelt is present')
  assert.equal(contaminated['kitchen toolbelt']?.merges, 2)

  // WITH the epoch reset: the toolbelt is ABSENT — not tier 0. Unknown ≠ zero (law 1).
  const current = replay(lines, true)
  assert.equal(current['kitchen toolbelt'], undefined, 'the beta character\'s upgrade is gone entirely')
  assert.ok(!('kitchen toolbelt' in current), 'absent, never a zeroed row')

  // The current character's own merges survive: +1, +1, +2 → highest 2, three merge lines.
  const star = current['enchanted fine steel morning star']
  assert.ok(star, 'post-epoch merges are kept')
  assert.equal(star.tier, 2)
  assert.equal(star.merges, 3)
  assert.deepEqual(Object.keys(current), ['enchanted fine steel morning star'])

  // A SOLD `Rusty Long Sword +4` sits in the beta span: an ordinary `+N` loot is never
  // merge evidence, so it makes no row on EITHER side of the boundary.
  assert.equal(contaminated['rusty long sword'], undefined, 'a looted +N drop is not an upgrade we made')
})

// ─────────────────────────────────────────────────────────────────────────────
// KEY CANONICALIZATION — the main-side `itemTierKey` and the renderer's loot-counting
// `itemCountKey` implement the SAME law-2 rule in two layers that cannot import each other.
// Pin them together against every distinct upgraded name in the fixtures so they can never
// drift (a drift would silently split one item into two rows).
test('the tier key and the loot counting key agree on every real +N name', () => {
  const names = new Set<string>()
  for (const f of ['w30-item-merge-run.log', 'w31-item-merge-sources.log', 'w32-item-merge-failures.log']) {
    for (const raw of readFixture(f)) {
      const m = /: (.+ \+\d+)$/.exec(raw) ?? /to create an? (.+ \+\d+)$/.exec(raw)
      if (m) names.add(m[1])
    }
  }
  assert.ok(names.size >= 10, `sampled ${names.size} distinct upgraded names`)
  for (const n of names) assert.equal(itemTierKey(n), itemCountKey(n), n)
})

// ─────────────────────────────────────────────────────────────────────────────
// FULL-LOG TRIPWIRE — INVARIANTS ONLY. The real log is live and grows every session, so
// there are no fixed counts here: every assertion is either a structural identity or a
// direction. Skipped when the real log is absent (CI).
test('full-log replay: observed tiers are structurally sound and epoch-clean', { skip: !existsSync(LOG) }, () => {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)
  const contaminated = replay(lines, false)
  const current = replay(lines, true)

  const rows = Object.values(current)
  assert.ok(rows.length > 0, 'the current character has merged at least one item')

  for (const row of rows) {
    // Range: a tier we read from a name is always 1..MAX (a `+0` name has never been printed;
    // tier 0 is the unstated base state and is exactly what an ABSENT row means).
    if (row.tier !== undefined) {
      assert.ok(row.tier >= 1 && row.tier <= ITEM_MAX_TIER, `${row.name} tier ${row.tier} in range`)
      // `tier` is the max, so it can never sit below the most recent observation.
      assert.ok(row.lastTier !== undefined && row.tier >= row.lastTier, `${row.name}: max >= latest`)
    }
    // Canonicalization: the key IS the normalized name, and the display name never keeps a
    // tier suffix (law 2 — canonicalize at the boundary, display the raw BASE name).
    assert.equal(row.key, itemTierKey(row.name), `${row.name} key is canonical`)
    assert.doesNotMatch(row.name, / \+\d+$/, `${row.name} carries no tier suffix`)
    assert.ok(row.merges >= 0 && row.firstAt <= row.lastAt)
    // THE EPOCH FLOOR — the load-bearing, anchor-independent invariant: nothing the wiped
    // character did can appear. (This is what "character-scoped" means; it stays true no
    // matter how much the user plays.)
    assert.ok(row.firstAt >= LAUNCH_MS, `${row.name} first observed after the launch boundary`)
  }

  // CONTAMINATION DIRECTION: the epoch can only ever REMOVE evidence, never add it — every
  // current row exists in the contaminated replay too, and at a tier no higher.
  for (const row of rows) {
    const dirty = contaminated[row.key]
    assert.ok(dirty, `${row.name} also present without the epoch reset`)
    assert.ok((dirty.tier ?? 0) >= (row.tier ?? 0), `${row.name}: epoch never raises a tier`)
    assert.ok(dirty.merges >= row.merges)
  }
  assert.ok(
    Object.keys(contaminated).length > rows.length,
    `the beta character contributed items the current one never merged (${Object.keys(contaminated).length} → ${rows.length})`
  )

  // Items the BETA character merged and the current one never touched must be absent —
  // derived from the data (no frozen item name), so it can't rot as the user keeps playing.
  const betaOnly = Object.values(contaminated).filter((r) => r.lastAt < LAUNCH_MS)
  assert.ok(betaOnly.length > 0, 'the beta character did merge items (the wipe is real)')
  for (const r of betaOnly) {
    assert.equal(current[r.key], undefined, `${r.name} was merged ONLY pre-launch and must not survive`)
  }
})
