// TASK #63 TESTS — the CONSIDER family: parser goldens, mob-page wikitext parse, the own-loot
// index, the feed's anti-spam window, and the consider module's ring/epoch/enrichment contract.
//
// Three layers, three kinds of evidence:
//
//   1. PARSER GOLDENS replay REAL, scrubbed log windows (tests/fixtures/w22–w24-consider-*.log,
//      cut by tests/extract-consider-fixtures.mjs) through the real parser and pin every field
//      of every event. The windows were chosen to cover the shapes a synthetic line wouldn't
//      have: BACKTICK mob names (Guard V`Lex), the ` - a rare creature - ` infix, the GENDERED
//      difficulty clause ("looks like HE would wipe the floor with you!"), six of the seven
//      faction rungs the log contains, and the same mob conned three or four times in seconds.
//
//   2. WIKITEXT PARSE GOLDENS + the committed catalog + the own-loot index now live in the
//      sibling file tests/mobCatalogWindows.test.mts — the two were split for file mass alone,
//      along the seam the section banners already drew, with no assertion changed.
//
//   3. MODULE CONTRACT tests drive ConsiderModule / EventFeedModule directly with an INJECTED
//      lookup, so nothing here touches the network or a userData cache.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { considerDifficultyShort } from '../src/shared/logEvents'
import type { ConsiderEvent } from '../src/shared/logEvents'
import { CONSIDER_BACKFILL, CONSIDER_CAP, ConsiderModule } from '../src/main/modules/consider'
import { MobLootIndex, mobKey } from '../src/main/mobLookupParse'
import { CONSIDER_FEED_DEDUPE_MS, EventFeedModule } from '../src/main/modules/eventFeed'
import type { ConsiderDelta, ConsiderRow, MobKnowledge } from '../src/shared/types'
import { readFixture } from './harness.mts'

/** Every `consider` event a fixture yields, in order. */
function considers(lines: string[]): ConsiderEvent[] {
  const out: ConsiderEvent[] = []
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev?.kind === 'consider') out.push(ev)
  }
  return out
}

/** A field-by-field projection, so a golden reads like the log line it came from. */
function shape(e: ConsiderEvent): Record<string, unknown> {
  return { mob: e.mob, rare: e.rare, level: e.level, faction: e.faction, difficulty: e.difficulty }
}

// =============================================================================
// 1. PARSER GOLDENS — real, scrubbed log windows
// =============================================================================

test('W22 guards: backtick mob names, the threatening rung, and a triple con in 8s', () => {
  const evs = considers(readFixture('w22-consider-guards.log'))
  // Six consider lines in the window; the zone line in between is not one of them.
  assert.equal(evs.length, 6)
  assert.deepEqual(evs.map(shape), [
    {
      mob: 'Blugurg',
      rare: false,
      level: 40,
      faction: 'indifferent',
      difficulty: 'what would you like your tombstone to say?'
    },
    // A BACKTICK name — the character that breaks inline `node -e` and would break a naive
    // apostrophe-based split. The parser never touches it; the name is carried verbatim.
    {
      mob: 'Guard V`Lex',
      rare: false,
      level: 17,
      faction: 'threatening',
      difficulty: "You would probably win this fight... it's not certain though."
    },
    {
      mob: 'Guard V`Lex',
      rare: false,
      level: 17,
      faction: 'threatening',
      difficulty: "You would probably win this fight... it's not certain though."
    },
    {
      mob: 'Guard V`Lex',
      rare: false,
      level: 17,
      faction: 'threatening',
      difficulty: "You would probably win this fight... it's not certain though."
    },
    {
      mob: 'Guard Gvarr',
      rare: false,
      level: 13,
      faction: 'threatening',
      difficulty: 'looks like a reasonably safe opponent.'
    },
    {
      mob: 'A fire drake',
      rare: false,
      level: 11,
      faction: 'indifferent',
      difficulty: 'looks like a reasonably safe opponent.'
    }
  ])
  // The three V`Lex cons span 18:56:38 → :45, i.e. 7 seconds — inside the feed's window.
  assert.equal((evs[3].ts - evs[1].ts) / 1000, 7)
})

test('W23 rare: the ` - a rare creature - ` infix is a flag, never part of the name', () => {
  const evs = considers(readFixture('w23-consider-rare.log'))
  assert.equal(evs.length, 6)
  // Five ordinary gnolls, then the rare one. Only the last carries the infix.
  assert.deepEqual(evs.map((e) => e.rare), [false, false, false, false, false, true])
  assert.equal(evs[5].mob, 'A Tesch Val Brute') // NOT "A Tesch Val Brute - a rare creature -"
  assert.equal(evs[5].level, 37)
  assert.equal(evs[5].faction, 'indifferent')
  // The same mob conned three times, 22:43:16 / :23 / :25.
  const nisch = evs.filter((e) => e.mob === 'A Nisch Val Gnoll')
  assert.equal(nisch.length, 3)
  assert.equal((nisch[2].ts - nisch[0].ts) / 1000, 9)
})

test('W24 factions: six rungs, the gendered difficulty clause, and one mob across three rungs', () => {
  const evs = considers(readFixture('w24-consider-factions.log'))
  assert.equal(evs.length, 15)
  // Every faction rung the window contains, in order of appearance.
  assert.deepEqual(
    [...new Set(evs.map((e) => e.faction))],
    ['indifferent', 'warmly', 'scowls', 'apprehensive', 'dubious', 'amiably']
  )
  // The gendered variant is carried VERBATIM — and still folds onto the neuter short label.
  const keyMaster = evs[0]
  assert.equal(keyMaster.mob, 'Key Master')
  assert.equal(keyMaster.difficulty, 'looks like he would wipe the floor with you!')
  assert.equal(considerDifficultyShort(keyMaster.difficulty), 'wipes the floor')
  assert.equal(considerDifficultyShort('looks like it would wipe the floor with you!'), 'wipes the floor')
  // Karam Dragonforge conned four times in 25s as his faction shifted apprehensive → dubious
  // → amiable. Three DIFFERENT rungs for one mob is exactly why the row keeps the latest.
  const karam = evs.filter((e) => e.mob === 'Karam Dragonforge')
  assert.deepEqual(karam.map((e) => e.faction), ['apprehensive', 'dubious', 'dubious', 'amiably'])
  // A level-1 mob and a level-55 one in the same window — the level is read, not inferred.
  assert.deepEqual(
    evs.filter((e) => e.mob === 'A large rat').map((e) => e.level),
    [1, 1]
  )
})

test('every fixture line that states a level parses as a consider, and nothing else does', () => {
  for (const name of ['w22-consider-guards.log', 'w23-consider-rare.log', 'w24-consider-factions.log']) {
    const lines = readFixture(name)
    let seq = 0
    for (const raw of lines) {
      const ev = parseEvent(raw, seq++)
      assert.ok(ev, `${name}: every fixture line is a timestamped log line`)
      // `(Lvl: N)` is the family's anchor: it appears on consider lines and nowhere else.
      assert.equal(
        ev.kind === 'consider',
        /\(Lvl: \d+\)$/.test(raw),
        `${name}: ${raw}`
      )
    }
  }
})

test('a difficulty clause we have never seen has NO short label (never a guessed tier)', () => {
  assert.equal(considerDifficultyShort('looks like an even fight.'), undefined)
  // …and the whole set the real log contains DOES resolve.
  for (const clause of [
    'what would you like your tombstone to say?',
    'looks like it would wipe the floor with you!',
    'looks like she would wipe the floor with you!',
    'it appears to be quite formidable.',
    'he appears to be quite formidable.',
    'looks like quite a gamble.',
    'looks kind of dangerous.',
    "You would probably win this fight... it's not certain though.",
    'looks quite risky, but might be worth a try.',
    'looks kind of risky, but you might win.',
    'looks kind of risky... you might win.',
    'You could probably win this fight.',
    'looks like a reasonably safe opponent.'
  ]) {
    assert.ok(considerDifficultyShort(clause), clause)
  }
})

// =============================================================================
// 4. THE FEED'S ANTI-SPAM WINDOW
// =============================================================================

/** Replay raw lines through an EventFeedModule at a given liveness. */
function feedReplay(lines: string[], live: boolean): EventFeedModule {
  const mod = new EventFeedModule({})
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev, live)
  }
  return mod
}

test('feed: a triple con of the same mob in 8s yields ONE row (the anti-spam window)', () => {
  const feed = feedReplay(readFixture('w22-consider-guards.log'), true)
  const rows = feed.snapshot().state.filter((r) => r.kind === 'con')
  // Six con lines in the window, but Guard V`Lex's three collapse to one.
  assert.deepEqual(rows.map((r) => r.title), ['Blugurg', 'Guard V`Lex', 'Guard Gvarr', 'A fire drake'])
  const vlex = rows.find((r) => r.title === 'Guard V`Lex')
  assert.ok(vlex)
  assert.equal(vlex.detail, 'Lvl 17 · probably win')
  assert.deepEqual(vlex.con, {
    faction: 'threatening',
    level: 17,
    rare: false,
    difficulty: "You would probably win this fight... it's not certain though."
  })
})

test('feed: a re-con OUTSIDE the window is admitted again', () => {
  const feed = new EventFeedModule({})
  feed.reset()
  const t0 = 1_000_000
  feed.noteConsider({ mob: 'a giant rat', rare: false, level: 2, faction: 'indifferent', difficulty: 'looks like a reasonably safe opponent.', ts: t0 })
  // Just inside the window ⇒ dropped.
  feed.noteConsider({ mob: 'a giant rat', rare: false, level: 2, faction: 'indifferent', difficulty: 'looks like a reasonably safe opponent.', ts: t0 + CONSIDER_FEED_DEDUPE_MS - 1 })
  assert.equal(feed.snapshot().state.length, 1)
  // At the window ⇒ admitted.
  feed.noteConsider({ mob: 'a giant rat', rare: false, level: 2, faction: 'indifferent', difficulty: 'looks like a reasonably safe opponent.', ts: t0 + CONSIDER_FEED_DEDUPE_MS })
  assert.equal(feed.snapshot().state.length, 2)
  // The window is PER MOB — a different mob inside the window is never suppressed.
  feed.noteConsider({ mob: 'a fire beetle', rare: false, level: 3, faction: 'scowls', difficulty: 'looks like a reasonably safe opponent.', ts: t0 + 1 })
  assert.equal(feed.snapshot().state.length, 3)
})

test('feed: a RARE con says so, and an unknown difficulty clause falls back to the verbatim text', () => {
  const feed = new EventFeedModule({})
  feed.reset()
  feed.noteConsider({ mob: 'A Tesch Val Brute', rare: true, level: 37, faction: 'indifferent', difficulty: 'what would you like your tombstone to say?', ts: 1 })
  feed.noteConsider({ mob: 'Something New', rare: false, level: 9, faction: 'dubious', difficulty: 'looks like an even fight.', ts: 2 })
  const [rare, unknown] = feed.snapshot().state
  assert.equal(rare.detail, 'Lvl 37 · suicide · rare')
  assert.equal(unknown.detail, 'Lvl 9 · looks like an even fight.')
})

test('feed: the HISTORICAL replay admits no con rows at all (the hydration law)', () => {
  const feed = feedReplay(readFixture('w24-consider-factions.log'), false)
  assert.equal(feed.snapshot().state.length, 0)
  assert.equal(feed.flushDelta(), null)
})

// =============================================================================
// 5. THE CONSIDER MODULE
// =============================================================================

/** A stand-in for main's `lookupMob`: no network, no cache; records what it was asked. */
function makeLookup(drops: Record<string, string[]> = {}): {
  fn: (n: string) => Promise<MobKnowledge>
  asked: string[]
} {
  const asked: string[] = []
  const fn = async (name: string): Promise<MobKnowledge> => {
    asked.push(name)
    const items = drops[name.toLowerCase()]
    return {
      name,
      cached: true,
      ...(items ? { dropsWiki: items.map((item) => ({ item })) } : { notFound: true })
    }
  }
  return { fn, asked }
}

/** Let every queued lookup promise settle (enrichment lands on resolve). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

function replayConsider(
  lines: string[],
  live: boolean,
  deps: ConstructorParameters<typeof ConsiderModule>[0] = {}
): ConsiderModule {
  const mod = new ConsiderModule(deps)
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev, live)
  }
  return mod
}

test('module: ONE row per mob — a triple con is one row with cons:3, moved to the front', () => {
  const mod = replayConsider(readFixture('w22-consider-guards.log'), true)
  const rows = mod.snapshot().state
  assert.deepEqual(rows.map((r) => r.mob), ['Blugurg', 'Guard V`Lex', 'Guard Gvarr', 'A fire drake'])
  const vlex = rows.find((r) => r.mob === 'Guard V`Lex') as ConsiderRow
  assert.equal(vlex.cons, 3)
  // The row carries the MOST RECENT con's timestamp (18:56:45, not :38).
  assert.equal(new Date(vlex.ts).getSeconds(), 45)
  // The zone the module was tracking when each was conned rides along.
  assert.equal(rows[rows.length - 1].zone, 'The Lavastorm Mountains')
})

test('module: a mob whose faction SHIFTS keeps the latest rung, not the first', () => {
  const mod = replayConsider(readFixture('w24-consider-factions.log'), true)
  const karam = mod.snapshot().state.find((r) => r.mob === 'Karam Dragonforge') as ConsiderRow
  assert.ok(karam)
  assert.equal(karam.cons, 4)
  assert.equal(karam.faction, 'amiably') // apprehensive → dubious → dubious → amiable
  assert.equal(karam.rare, false)
  assert.equal(karam.level, 50)
})

test('module: the ring is capped and evicts the OLDEST mob', () => {
  const mod = new ConsiderModule({})
  mod.reset()
  for (let i = 0; i < CONSIDER_CAP + 5; i++) {
    mod.onEvent(
      {
        kind: 'consider',
        seq: i,
        ts: 1000 + i,
        raw: '',
        mob: `mob ${i}`,
        rare: false,
        level: 1,
        faction: 'indifferent',
        difficulty: 'looks like a reasonably safe opponent.'
      },
      true
    )
  }
  const rows = mod.snapshot().state
  assert.equal(rows.length, CONSIDER_CAP)
  assert.equal(rows[0].mob, 'mob 5')
  assert.equal(rows[rows.length - 1].mob, `mob ${CONSIDER_CAP + 4}`)
})

test('module: enrichment lands as a LATER delta and never blocks the event path', async () => {
  const { fn, asked } = makeLookup({ 'guard v`lex': ['Rusty Short Sword'] })
  const mod = replayConsider(readFixture('w22-consider-guards.log'), true, { lookupMob: fn })

  // The rows exist IMMEDIATELY, with no knowledge yet — the log line alone made them.
  const first = mod.flushDelta()
  assert.ok(first)
  assert.equal(first.delta.upserted.length, 4)
  assert.ok(first.delta.upserted.every((r) => r.knowledge === undefined))

  await settle()
  const second = mod.flushDelta()
  assert.ok(second, 'enrichment produced its own delta')
  // The seq ADVANCED past the last log event, so useModule's gap/dupe check accepts it.
  assert.ok(second.seq > first.seq)
  const vlex = second.delta.upserted.find((r) => r.mob === 'Guard V`Lex') as ConsiderRow
  assert.deepEqual(vlex.knowledge?.dropsWiki, [{ item: 'Rusty Short Sword' }])
  // A mob with no page keeps NO knowledge fields it didn't earn — just the honest negative.
  const drake = second.delta.upserted.find((r) => r.mob === 'A fire drake') as ConsiderRow
  assert.equal(drake.knowledge?.notFound, true)
  assert.equal(drake.knowledge?.dropsWiki, undefined)

  // One lookup per MOB, not per con: V`Lex was conned three times.
  assert.equal(asked.filter((n) => n === 'Guard V`Lex').length, 1)
  assert.equal(asked.length, 4)
  assert.equal(mod.flushDelta(), null)
})

test('module: a HISTORICAL replay fires no lookups; the first live tick backfills the newest', async () => {
  const { fn, asked } = makeLookup()
  const mod = replayConsider(readFixture('w24-consider-factions.log'), false, { lookupMob: fn })
  // Rows exist (this is STATE, not a feed) …
  assert.ok(mod.snapshot().state.length > 0)
  await settle()
  // … but the replay asked the wiki nothing.
  assert.deepEqual(asked, [])

  // The first wall-clock tick is the registry's "the live tail is running" edge.
  mod.onTick()
  await settle()
  assert.equal(asked.length, Math.min(CONSIDER_BACKFILL, mod.snapshot().state.length))
  // …and it happens ONCE.
  const after = asked.length
  mod.onTick()
  await settle()
  assert.equal(asked.length, after)
})

test('module: the epoch boundary clears the ring AND the own-loot index', () => {
  const ownLoot = new MobLootIndex()
  const mod = new ConsiderModule({ ownLoot })
  mod.reset()
  let seq = 0
  const feed = (raw: string): void => {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev, true)
  }
  feed('[Sun Jul 19 18:56:37 2026] Blugurg regards you indifferently -- what would you like your tombstone to say? (Lvl: 40)')
  feed('[Sun Jul 19 18:57:00 2026] --You have looted a Rusty Dagger from Blugurg\'s corpse.--')
  assert.equal(mod.snapshot().state.length, 1)
  assert.deepEqual(ownLoot.drops('Blugurg').map((d) => d.item), ['Rusty Dagger'])

  // The derived epoch event (Task #49): everything before it belongs to a dead character.
  mod.onEvent({ kind: 'epoch', seq: seq++, ts: Date.now(), raw: '', reason: 'launch' }, true)
  assert.deepEqual(mod.snapshot().state, [])
  assert.equal(ownLoot.size, 0)
  assert.deepEqual(ownLoot.drops('Blugurg'), [])

  // …and the module keeps working afterwards (a reset is not a teardown).
  feed('[Sun Jul 19 18:58:19 2026] Guard Gvarr glares at you threateningly -- looks like a reasonably safe opponent. (Lvl: 13)')
  assert.deepEqual(mod.snapshot().state.map((r) => r.mob), ['Guard Gvarr'])
})

test('module: reset() clears everything, including the backfill latch', async () => {
  const { fn, asked } = makeLookup()
  const mod = replayConsider(readFixture('w23-consider-rare.log'), false, { lookupMob: fn })
  mod.onTick()
  await settle()
  const first = asked.length
  assert.ok(first > 0)

  mod.reset()
  assert.deepEqual(mod.snapshot().state, [])
  assert.equal(mod.snapshot().seq, 0)
  assert.equal(mod.flushDelta(), null)
  // A fresh character replays from scratch, so the backfill must be armed again.
  let seq = 0
  for (const raw of readFixture('w23-consider-rare.log')) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev, false)
  }
  mod.onTick()
  await settle()
  assert.ok(asked.length > first)
})

test('module: the delta upserts by row id, so a renderer merge converges on the snapshot', () => {
  const mod = replayConsider(readFixture('w24-consider-factions.log'), true)
  const delta = mod.flushDelta()
  assert.ok(delta)
  // Apply the delta the way BossView does and compare against the authoritative snapshot.
  const merged = new Map<string, ConsiderRow>()
  for (const r of (delta.delta as ConsiderDelta).upserted) merged.set(r.id, r)
  const byTs = [...merged.values()].sort((a, b) => a.ts - b.ts)
  assert.deepEqual(byTs, mod.snapshot().state)
  // Every id is the canonical mob key, so the two casings of one mob can never split a row.
  for (const r of byTs) assert.equal(r.id, mobKey(r.mob))
})
