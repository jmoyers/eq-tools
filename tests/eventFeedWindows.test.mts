// TASK #59 TESTS — the event-log feed module (the 'events' overlay's data source).
//
// The load-bearing property is HYDRATION HONESTY: replaying the log's history must NOT spam the
// feed with hours-old events, exactly like the confetti/celebration detectors. The module
// expresses that as "nothing historical is admitted", so the same fixture replayed twice —
// once as history, once live — must produce an EMPTY feed and a POPULATED one.
//
// Fixtures are real loot windows from the user's log (tests/fixtures/w14-sky-currency-loot.log,
// w15-sphinx-claw-variant.log). Notability is resolved through an INJECTED lookup so the test
// touches no network and no userData cache — the stub answers exactly as the shipped local-first
// posky path does, driven by the SAME committed posky.json (Sphinx Claw / Golden Hilt / Hazy
// Opal / Wind Runes / Efreeti War Club are Sky quest items; Belt of Concordance and Bracelet of
// Exertion are not).
//
// Also pinned here: alert rows, quest rows with/without a reward item (law 1 — no fabricated
// reward), the ring cap, reset, the delta contract, and the eqlwiki URL convention that the
// quest/item links are built on (VERIFIED against the live site on 2026-08-02 — see wiki.ts).
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { EventFeedModule, FEED_CAP, stripLogTimestamp } from '../src/main/modules/eventFeed'
import { isNotableKnowledge } from '../src/shared/itemKnowledge'
import { skyQuestPage, wikiPageUrl } from '../src/shared/wiki'
import type { ItemKnowledge, PoskyData } from '../src/shared/types'
import poskyJson from '../src/renderer/src/data/eqlegends/posky.json'
import { readFixture } from './harness.mts'

const posky = poskyJson as unknown as PoskyData

/** Every item name the committed Sky dataset requires, normalized the way counting keys are. */
const POSKY_ITEMS = new Set<string>()
for (const q of posky.quests) for (const it of q.items) POSKY_ITEMS.add(norm(it.name))

/** Strip an item-level ` +N` suffix + lowercase (the app's counting-key normalization). */
function norm(name: string): string {
  return name.replace(/\s*\+\d+\s*$/, '').trim().toLowerCase()
}

/**
 * A stand-in for main's `lookupItem`: local posky only, no network. Records what it was asked
 * for so a test can prove the historical replay never triggered a single lookup.
 */
function makeLookup(): { fn: (n: string) => Promise<ItemKnowledge>; asked: string[] } {
  const asked: string[] = []
  const fn = async (name: string): Promise<ItemKnowledge> => {
    asked.push(name)
    const display = name.replace(/\s*\+\d+\s*$/, '').trim()
    const isQuestItem = POSKY_ITEMS.has(norm(name))
    return {
      name: display,
      page: isQuestItem ? display : undefined,
      lore: false,
      quest: isQuestItem,
      questUses: isQuestItem ? [{ quest: 'Some Sky Test', page: 'Plane of Sky', source: 'posky' }] : [],
      cached: true
    }
  }
  return { fn, asked }
}

/** Let every queued lookup promise settle (the probe appends on resolve). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Replay raw lines through the module at a given liveness. */
async function replay(
  lines: string[],
  live: boolean,
  lookup: (n: string) => Promise<ItemKnowledge>
): Promise<EventFeedModule> {
  const mod = new EventFeedModule({ lookupItem: lookup })
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev, live)
  }
  await settle()
  return mod
}

// ─────────────────────────────────────────────────────────────────────────────
// (A) HYDRATION: the historical replay contributes NOTHING.
test('A historical replay (live:false) adds no feed events and probes no items', async () => {
  const lines = [...readFixture('w14-sky-currency-loot.log'), ...readFixture('w15-sphinx-claw-variant.log')]
  const { fn, asked } = makeLookup()
  const mod = await replay(lines, false, fn)

  assert.equal(mod.snapshot().state.length, 0, 'the startup replay must never seed the feed')
  assert.equal(mod.flushDelta(), null, 'and it must push no delta')
  assert.equal(asked.length, 0, 'no item lookup is even attempted for historical loot')
})

// (B) LIVE: the same fixture produces rows — but only for NOTABLE items.
test('B live replay surfaces notable loot only, with source mob + loot timestamp', async () => {
  const lines = readFixture('w14-sky-currency-loot.log')
  const { fn, asked } = makeLookup()
  const mod = await replay(lines, true, fn)
  const feed = mod.snapshot().state

  assert.ok(asked.length > 0, 'live loot probes item knowledge')
  assert.ok(feed.length > 0, 'live loot produces feed rows')
  assert.ok(
    feed.every((e) => e.kind === 'loot'),
    'a loot-only fixture yields loot rows only'
  )

  const titles = feed.map((e) => e.title)
  assert.ok(titles.includes('Sphinx Claw'), 'a Sky quest item is notable and surfaces')
  assert.ok(titles.includes('Hazy Opal'), 'so is the Hazy Opal')
  // Vendor gear that no quest wants must NOT be in the feed (the notability gate is real).
  assert.ok(
    !titles.some((t) => t.startsWith('Belt of Concordance')),
    'non-quest vendor gear is filtered out'
  )
  assert.ok(
    !titles.some((t) => t.startsWith('Bracelet of Exertion')),
    'non-quest vendor gear is filtered out (auto-sold line too)'
  )

  // Rows carry the loot line's own timestamp and its source mob, not the resolve time.
  const claw = feed.find((e) => e.title === 'Sphinx Claw')!
  assert.equal(claw.detail, 'from Sister of the Spire', 'the row names the mob it dropped from')
  assert.equal(
    claw.ts,
    Date.parse('Aug 01 2026 22:55:00'),
    'the row keeps the LOOT timestamp, not the time the lookup resolved'
  )
})

// (C) The notability predicate is the SHARED one (the loot strip and the feed can't diverge).
test('C notability uses the shared predicate', () => {
  const base = { name: 'x', lore: false, quest: false, questUses: [], cached: true } as ItemKnowledge
  assert.equal(isNotableKnowledge(base), false, 'plain vendor trash is not notable')
  assert.equal(isNotableKnowledge({ ...base, lore: true }), true, 'lore is notable')
  assert.equal(isNotableKnowledge({ ...base, quest: true }), true, 'quest-flagged is notable')
  assert.equal(
    isNotableKnowledge({ ...base, questUses: [{ quest: 'q', source: 'wiki' }] }),
    true,
    'a related quest makes it notable'
  )
})

// (D) ALERT rows: name + the triggering line, timestamp-prefix stripped.
test('D alert fires become rows carrying the alert name and what triggered it', () => {
  const mod = new EventFeedModule()
  mod.reset()
  mod.noteAlertFire(
    'Charm broke!',
    '[Sat Aug 01 22:55:00 2026] Your charm spell has worn off.',
    1_700_000_000_000
  )
  const [row] = mod.snapshot().state
  assert.equal(row.kind, 'alert')
  assert.equal(row.title, 'Charm broke!')
  assert.equal(row.detail, 'Your charm spell has worn off.', 'the log timestamp prefix is stripped')
  assert.equal(row.ts, 1_700_000_000_000, 'the row keeps the FIRE timestamp')

  assert.equal(stripLogTimestamp('[Sat Aug 01 22:55:00 2026] hello'), 'hello')
  assert.equal(stripLogTimestamp('no prefix here'), 'no prefix here')
})

// (E) QUEST rows: the reward rides along ONLY when the data names one (law 1).
test('E quest completions carry the quest link + a reward only when known', () => {
  const mod = new EventFeedModule()
  mod.reset()
  const quest = posky.quests.find((q) => q.reward)!
  mod.report({
    kind: 'quest',
    ts: 1_700_000_000_000,
    title: quest.name,
    detail: quest.giver,
    page: skyQuestPage(quest.className),
    reward: { item: quest.reward!, page: quest.rewardPage, stats: quest.rewardStats }
  })
  mod.report({
    kind: 'quest',
    ts: 1_700_000_001_000,
    title: 'A quest whose reward we do not know',
    page: undefined,
    reward: undefined
  })

  const [withReward, without] = mod.snapshot().state
  assert.equal(withReward.kind, 'quest')
  assert.equal(withReward.title, quest.name)
  assert.equal(withReward.page, `${quest.className} Plane of Sky Tests`, 'links the QUEST page')
  assert.equal(withReward.reward?.item, quest.reward)
  assert.equal(without.reward, undefined, 'an unknown reward is absent — never fabricated')
  assert.equal(without.page, undefined, 'and an unknown page is absent, not a dead link')

  // Anything that isn't a quest report is rejected outright (main owns the other sources).
  mod.report({ kind: 'quest', ts: 0, title: '' })
  assert.equal(mod.snapshot().state.length, 2, 'a titleless report is dropped')
})

// (F) The delta contract: appended-once, then null; seq advances so useModule accepts it.
test('F flushDelta returns each row exactly once and advances seq', () => {
  const mod = new EventFeedModule()
  mod.reset()
  const before = mod.snapshot().seq
  mod.noteAlertFire('a', 'raw a', 1)
  mod.noteAlertFire('b', 'raw b', 2)
  const out = mod.flushDelta()
  assert.equal(out?.delta.appended.length, 2)
  assert.ok(out!.seq > before, 'seq advanced so the renderer will accept the delta')
  assert.equal(mod.flushDelta(), null, 'nothing pending after a flush')
})

// (G) The ring is capped, and reset() drops it (character switch = a different world).
test('G the feed is capped and cleared on reset', () => {
  const mod = new EventFeedModule()
  mod.reset()
  for (let i = 0; i < FEED_CAP + 25; i++) mod.noteAlertFire(`alert ${i}`, `raw ${i}`, 1000 + i)
  const state = mod.snapshot().state
  assert.equal(state.length, FEED_CAP, `the ring holds at most ${FEED_CAP} rows`)
  assert.equal(state[state.length - 1].title, `alert ${FEED_CAP + 24}`, 'newest is kept (ring is newest-last)')
  assert.equal(state[0].title, 'alert 25', 'oldest fell off the front')

  mod.reset()
  assert.equal(mod.snapshot().state.length, 0)
  assert.equal(mod.flushDelta(), null)
})

// (H) The eqlwiki URL convention the links are built on. VERIFIED live 2026-08-02:
//     https://eqlwiki.com/<Title> → 200 ; https://eqlwiki.com/wiki/<Title> → 404.
test('H wiki link helpers follow the verified eqlwiki convention', () => {
  assert.equal(wikiPageUrl('Mask of Song'), 'https://eqlwiki.com/Mask_of_Song')
  assert.equal(
    wikiPageUrl('Enchanter Plane of Sky Tests'),
    'https://eqlwiki.com/Enchanter_Plane_of_Sky_Tests'
  )
  assert.ok(!wikiPageUrl('Mask of Song')!.includes('/wiki/'), 'the /wiki/ path 404s on this site')
  assert.equal(wikiPageUrl(undefined), undefined, 'no page ⇒ no link (never a dead href)')
  assert.equal(wikiPageUrl('   '), undefined)
  assert.equal(skyQuestPage('Paladin'), 'Paladin Plane of Sky Tests')
  assert.equal(skyQuestPage(undefined), undefined)
})
