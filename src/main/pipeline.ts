// ============================================================================
// pipeline.ts — the log-derived world: one event stream, and everything that folds it.
// ============================================================================
//
// See AGENTS.md → Architecture. Both feeders (the startup scan and the live Tailer) push
// onto ONE LogBus; the ModuleRegistry folds every event into each extension module and the
// CombatEngine folds it into its own state machine.
//
// This module CONSTRUCTS that world and wires it, at import time, in the order the design
// requires — the module instances, the registry host that pushes `module:delta`, the
// REGISTRATION ORDER (which is bus delivery order), and the two bus subscriptions. index.ts
// imports it as the composition root's first act; `session.ts` drives it (scan → tail →
// reset on character switch).
//
// The ORDER of the `registry.register(...)` calls below is load-bearing and is documented at
// the call site. Do not reorder them.

import { IPC } from '../shared/ipc'
import { logInfo } from './errorLog'
import { LogBus } from './log/bus'
import { EpochDetector } from './log/epochDetector'
import { installSpellDb } from './log/rulesets'
import { loadSpellDb, applyOverlayCorrections } from './data/spellDb'
import { MessageOverlayMiner } from './data/messageOverlay'
import { baselineOverlay, loadUserOverlay } from './data/overlayPersistence'
import { CombatEngine } from './combat/engine'
import { ModuleRegistry } from './modules/registry'
import { LootModule } from './modules/loot'
import { TurnInsModule } from './modules/turnins'
import { KillsModule } from './modules/kills'
import { LevelingModule } from './modules/leveling'
import { ProgressionModule } from './modules/progression'
import { CharacterModule } from './modules/character'
import { ItemTiersModule } from './modules/itemTiers'
import { AlertsModule } from './modules/alerts'
import { BuffsModule } from './modules/buffs'
import { ConsiderModule } from './modules/consider'
import { EventFeedModule } from './modules/eventFeed'
import type { ModuleDelta } from './modules/types'
import { lookupItem } from './itemLookup'
import { MOB_CATALOG_SIZE, lookupMob, ownLoot } from './mobLookup'
import { getAlerts } from './store'
import { getOverlayWindow, sendToMain } from './windows'
import type { AlertsDelta } from '../shared/types'

/**
 * Log-derived state for the active character, rebuilt on launch + appended live.
 * A single canonical LogEvent stream (bus) feeds every consumer: the module
 * registry folds it into each extension module, the combat engine folds it into
 * its state machine. Both feeders (scan + tail) share one monotonic seq counter,
 * owned by session.ts.
 */
export const bus = new LogBus()
export const combat = new CombatEngine()
// Character-epoch detection (Task #49; anchor replaced in Task #50): the OFFICIAL LAUNCH
// (2026-07-28 00:00 local) is the boundary of a same-name+server character being WIPED +
// recreated at launch (they reuse the same log file — see epochDetector.ts's beta-wipe
// story). The first at/after-launch event hands a derived `epoch` event back onto the SAME
// bus (the Task #47 emitDerived path), which every character-scoped module resets on, so
// post-scan tallies (AA/loot/kills/turn-ins/quests) reflect ONLY the current character.
// Fires mid-replay during a rescan, so epochs apply historically for free; a live crossing
// works identically. (The old level-regression heuristic was removed — EQ Legends loadout
// swaps legitimately change level, so a level drop is NOT a reliable rebirth signal.)
export const epoch = new EpochDetector()

// The extension framework. Modules own their slice of log-derived state and push
// deltas to the renderer over the generic `module:delta` channel. Registration
// order = bus delivery order.
export const registry = new ModuleRegistry({
  emitDelta: (delta: ModuleDelta) => {
    sendToMain(IPC.onModuleDelta, delta)
    // Task #59: alert fires are ALSO event-log rows. Folding them here (rather than teaching
    // AlertsModule about the feed) keeps the alerts module untouched, and because eventFeed is
    // registered LAST the row it appends is picked up by the same flush pass.
    feedAlertDelta(delta)
    // The 'events' overlay is a second consumer of the module transport (it hydrates the
    // eventFeed module and rides its deltas), so deltas must reach that window too.
    const evOverlay = getOverlayWindow('events')
    if (evOverlay && !evOverlay.isDestroyed()) evOverlay.webContents.send(IPC.onModuleDelta, delta)
  }
})
export const lootModule = new LootModule()
export const turnInsModule = new TurnInsModule()
export const killsModule = new KillsModule()
// Leveling analytics (docs/plans/leveling-analytics.md): the capped, range-queryable series of
// experience / credited kills / loot / zone intervals behind the drag-select stats panel. A
// SEPARATE module from leveling on purpose — LevelingSnap is uncapped by contract (the AA
// identity needs the whole history) and this one is a drop-oldest ring.
export const progressionModule = new ProgressionModule()
export const levelingModule = new LevelingModule()
export const characterModule = new CharacterModule()
// Observed item levels (Task #60): character-scoped, epoch-aware per-item tier state folded
// from the merge lines, so an item window can show YOUR tier for an item you upgraded.
export const itemTiersModule = new ItemTiersModule()
// The alerts extension (Task #18): evaluates event/raw triggers on live events and
// pushes fired deltas over the standard module transport. Its defs are user prefs
// (owned by the store), loaded into the module here and re-synced on every save.
export const alertsModule = new AlertsModule()
alertsModule.setDefs(getAlerts())
// Load the scraped spell DB (Task #34) and inject it into the parser config so the
// parser emits PRECISE message-driven buff events (buffApply/buffWearOff) — and give the
// same DB to the buffs module for authoritative durations + the self-heal-by-buff apply.
export const spellDb = loadSpellDb()
// Effective DB = spells.json + observed-message overlay, overlay WINS (Task #36): fold the
// committed baseline + the user's persisted overlay into a miner, derive its verified /
// wiki-contradicting landing corrections, and apply them to the parser's cast-on-you table
// so a self-landing line the wiki got wrong or omitted (e.g. Symbol of Pinzarn's real
// message) is recognized. Done BEFORE installSpellDb so the parser uses the corrected DB.
{
  const seedMiner = new MessageOverlayMiner(spellDb.byKey)
  seedMiner.merge(baselineOverlay())
  seedMiner.merge(loadUserOverlay())
  const n = applyOverlayCorrections(spellDb, seedMiner.deriveLandingCorrections())
  logInfo(`[everquest-companion] Message overlay: applied ${n} cast-message corrections over the wiki DB.`)
}
installSpellDb(spellDb)
logInfo(`[everquest-companion] Spell DB: ${spellDb.spells.length} spells (${spellDb.castOnYou.size} unique cast-on-you msgs).`)
// The buffs extension (Task #19; message-driven model Task #34): tracks the player's own
// buffs from precise message applies + cast-timing mining, serving live actives + stats.
// Task #36: seed the observed-message overlay miner with the committed baseline + the user's
// persisted overlay so it starts warm; the user's overlay is re-saved (debounced) as the
// live log teaches it more.
export const buffsModule = new BuffsModule(spellDb, [baselineOverlay(), loadUserOverlay()])
// DERIVED EVENTS (Task #47): the buffs module is the only authoritative source of the RESOLVED
// "wears off you / your pet" signal (the raw parser buffWearOff carries an ambiguous candidate
// list for the 123 shared-message families). Let it synthesize a `buffExpired { spell, target }`
// back onto the SAME bus so the alerts module (registered after buffs) can match one reliable
// kind for both sides. bus.emitDerived queues it until the current primary event finishes
// delivering — no re-entrancy, no feedback loop (buffs ignores buffExpired).
buffsModule.setDerivedEmitter((ev, live) => bus.emitDerived(ev, live))
// The event-log feed (Task #59): the live "things worth noticing" ring behind the 'events'
// overlay — alert fires, NOTABLE loot, quest completions. It resolves loot notability through
// the SAME cache-first lookupItem the loot tab uses (which also warms the cache, so this
// replaces the old bare prefetch subscription below). Registered LAST so a row appended while
// an earlier module's delta is being emitted still flushes in that pass.
export const eventFeedModule = new EventFeedModule({ lookupItem })
// The consider ring (Task #63): the mobs you've recently `/con`ed, enriched asynchronously with
// drop knowledge. It also OWNS the shared own-loot index's lifetime — it folds every loot event
// into `ownLoot` and resets it on epoch/character switch, so mobLookup's "what has this mob
// dropped for ME" answer is rebuilt by the same replay that rebuilds the loot module.
export const considerModule = new ConsiderModule({ lookupMob, ownLoot })
logInfo(
  `[everquest-companion] Mob catalog: ${MOB_CATALOG_SIZE} mobs (scraped drop tables; the live wiki lookup is the fallback).`
)

/** Fold an `alerts` module delta into the event feed (alert id → its display name). */
function feedAlertDelta(delta: ModuleDelta): void {
  if (delta.moduleId !== 'alerts') return
  const { fired } = delta.delta as AlertsDelta
  if (!fired?.length) return
  const defs = alertsModule.snapshot().state.defs
  for (const f of fired) {
    const def = defs.find((d) => d.id === f.alertId)
    eventFeedModule.noteAlertFire(def?.name ?? f.alertId, f.matchedText, f.ts)
  }
}

registry.register(lootModule)
registry.register(turnInsModule)
registry.register(killsModule)
registry.register(progressionModule)
registry.register(levelingModule)
registry.register(characterModule)
registry.register(itemTiersModule)
registry.register(alertsModule)
registry.register(buffsModule)
registry.register(considerModule)
// eventFeed stays LAST: a row appended while an earlier module's delta is being emitted still
// rides out on the same flush pass.
registry.register(eventFeedModule)
// Subscribe consumers to the bus ONCE, at startup. The bus persists across
// character switches; on a switch we reset() each consumer rather than tearing
// down and re-subscribing (the old bus.clear() churned subscriptions and risked
// registration-order drift). Registry first, then combat — same order as before.
registry.attach(bus)
bus.subscribe((ev, live) => combat.ingestEvent(ev, live))
// Item-knowledge prefetch (Task #53): when a LIVE loot event arrives, warm the
// "what's this for" cache in the background (throttled by itemLookup's serialized queue
// + persistent cache) so the answer is ready by the time the user clicks the item. LIVE
// only — the historical scan (live:false) would otherwise fire thousands of lookups; the
// cache/local-posky path covers those instantly on demand.
//
// Task #59 folded this INTO the event-feed module: its live-loot notability probe calls the
// same cache-first `lookupItem`, so the cache is warmed exactly as before with ONE request
// per item (the module also de-dupes concurrent probes of the same name, which the bare
// prefetch did not). A second subscription here would double-request every uncached loot.
//
// The THIRD and last subscription — epoch detection — is added by index.ts, after this
// module has finished wiring: it must observe each event only once the modules and the
// combat engine have folded it, and it reaches for the active character, which session.ts
// owns. See the composition root.
