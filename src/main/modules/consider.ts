// consider module (Task #63) — "what have I been sizing up, and what does it drop".
//
// A capped ring of RECENTLY CONSIDERED mobs, served over the ordinary module transport
// (`module:getSnapshot` / `module:delta`), enriched ASYNCHRONOUSLY with drop knowledge.
//
// ONE ROW PER MOB. A mob conned five times during one pull is one row with `cons: 5`, not five
// rows — the real log does that constantly (the biggest run is a goblin magician conned nine
// times inside 30 seconds), and five identical lines answer "what have I been sizing up" worse
// than one. The row carries the MOST RECENT con's facts; re-conning moves it to the front.
//
// ENRICHMENT NEVER BLOCKS THE EVENT PATH. `mobLookup` may need the network, so the row is
// appended immediately from the log line alone and `knowledge` lands later as its own delta —
// the same shape the event feed's loot probe uses. A lookup that fails leaves `knowledge`
// absent, which is the honest state (law 1); it is never filled with an empty record to mean
// "we checked".
//
// HISTORY vs LIVE — deliberately DIFFERENT from the event feed. The feed admits nothing
// historical because a feed is a stream of things that just happened. This ring is a STATE
// ("the mobs you've been conning"), so the startup replay DOES fold into it and the card is
// populated the moment the app opens. What replay does NOT do is fire hundreds of wiki lookups:
// enrichment is live-only, plus a bounded BACKFILL of the newest rows on the first wall-clock
// tick (which the registry only ever calls once the live tail is running — that tick is the
// module contract's "the replay is over" edge). Everything else enriches on demand when the
// user actually hovers it, through the same cache-first `mobs:lookup` door.
//
// OWN-LOOT INDEX (mobLookup's LOCAL 1): this module is also what FEEDS it, folding every loot
// event — historical included, since your loot history is exactly what makes it useful — into
// the shared MobLootIndex. That keeps one owner for the character-scoped/epoch-scoped lifetime
// of that index instead of a second bus subscription that could reset out of step.

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import type { ConsiderDelta, ConsiderRow, ConsiderSnap, MobKnowledge } from '../../shared/types'
import { MobLootIndex, mobKey } from '../mobLookupParse'

/** How many considered mobs the ring keeps. Oldest fall off the front. */
export const CONSIDER_CAP = 50

/**
 * How many of the ring's newest rows get enriched when the live tail takes over. A full ring
 * would be 50 mob pages on a cold cache; the newest handful is what a user actually looks at
 * right after opening the app, and everything else resolves on hover. Bounded on purpose —
 * scraper etiquette is a law here, not a preference (AGENTS.md "Data sources").
 */
export const CONSIDER_BACKFILL = 12

export interface ConsiderDeps {
  /**
   * Resolve a mob's drop knowledge — main's `lookupMob` in production (own loot + quest catalog
   * first, then the cached, politely-throttled wiki lookup; never throws). Injected so the
   * module is unit-testable with no network and no userData cache. Omit to disable enrichment.
   */
  lookupMob?: (name: string) => Promise<MobKnowledge>
  /**
   * The own-loot index this module folds `loot` events into — mobLookup's shared singleton in
   * production, so the enrichment above and the IPC hover card read the same numbers. Omit and
   * loot folding is skipped entirely.
   */
  ownLoot?: MobLootIndex
}

/**
 * Pick the display name to keep for a mob seen under two casings. THE SAME RULE as
 * combat/world.ts `adoptDisplay`: a lowercase-initial spelling is the mob's true name ("a zol
 * ghoul knight"), and a sentence-start capital is an artifact of the line it appeared in — and
 * a consider line ALWAYS sentence-cases the leading article. So a lowercase spelling wins, and
 * otherwise the first one seen is kept. Never relabels across identities (callers only pass
 * names that share a `mobKey`).
 */
function adoptDisplay(current: string | undefined, incoming: string): string {
  if (current === undefined) return incoming
  if (current === incoming) return current
  const incomingIsLower = /^[a-z]/.test(incoming)
  const currentIsLower = /^[a-z]/.test(current)
  return incomingIsLower || !currentIsLower ? incoming : current
}

export class ConsiderModule implements EqModule<ConsiderSnap, ConsiderDelta> {
  readonly id = 'consider'
  /** newest LAST (the UI reverses), one entry per mob key. */
  private ring: ConsiderRow[] = []
  private byId = new Map<string, ConsiderRow>()
  private zone: string | undefined
  private seq = 0
  /** row ids touched since the last flush (deltas carry only these). */
  private dirty = new Set<string>()
  /** mob keys with a lookup in flight, so a re-con burst probes each mob once. */
  private probing = new Set<string>()
  /** the first live tick has run ⇒ the historical replay is over (see the header). */
  private backfilled = false

  constructor(private deps: ConsiderDeps = {}) {}

  reset(): void {
    this.ring = []
    this.byId = new Map()
    this.zone = undefined
    this.seq = 0
    this.dirty = new Set()
    this.probing = new Set()
    this.backfilled = false
    this.deps.ownLoot?.reset()
  }

  onEvent(ev: LogEvent, live = false): void {
    this.seq = ev.seq
    if (ev.kind === 'epoch') {
      // Character rebirth (Task #49): everything before the boundary belongs to a dead
      // same-name character — including the loot history the own-loot index is built from,
      // which would otherwise credit this character with drops it never saw.
      this.ring = []
      this.byId = new Map()
      this.dirty = new Set()
      this.deps.ownLoot?.reset()
      return
    }
    if (ev.kind === 'zone') {
      this.zone = ev.zone
      return
    }
    if (ev.kind === 'loot') {
      // Historical loot counts — it IS the history. Stacked loots add their count, not 1.
      this.deps.ownLoot?.note(ev.item, ev.source, ev.ts, ev.count ?? 1)
      return
    }
    if (ev.kind !== 'consider') return
    this.foldConsider(ev, live)
  }

  /**
   * Fold ONE `consider` line into the ring: upsert the mob's single row (moving it to the front
   * and bumping `cons`), evict past the cap, and enrich when live. Split out of onEvent purely
   * to keep each method's branch count in range; the order of every step is unchanged.
   */
  private foldConsider(ev: Extract<LogEvent, { kind: 'consider' }>, live: boolean): void {
    const id = mobKey(ev.mob)
    if (!id) return
    const prev = this.byId.get(id)
    const row: ConsiderRow = {
      id,
      mob: adoptDisplay(prev?.mob, ev.mob),
      ts: ev.ts,
      rare: ev.rare,
      level: ev.level,
      faction: ev.faction,
      difficulty: ev.difficulty,
      zone: this.zone,
      cons: (prev?.cons ?? 0) + 1,
      // Enrichment is per-MOB, not per-con: a re-con keeps whatever we already learned.
      knowledge: prev?.knowledge
    }
    if (prev) this.ring.splice(this.ring.indexOf(prev), 1)
    this.ring.push(row)
    this.byId.set(id, row)
    this.dirty.add(id)
    while (this.ring.length > CONSIDER_CAP) {
      const dropped = this.ring.shift()
      if (dropped) this.byId.delete(dropped.id)
    }
    // LIVE cons enrich immediately; historical ones wait for the bounded backfill below, so a
    // startup replay of a 1M-line log never becomes a burst of wiki traffic.
    if (live) this.probe(row)
  }

  /**
   * Wall-clock heartbeat. The registry only calls this once the LIVE tail is running, so the
   * FIRST one is the module contract's "the historical replay is over" edge — the moment to
   * backfill knowledge for the newest rows the replay left in the ring.
   */
  onTick(): void {
    if (this.backfilled) return
    this.backfilled = true
    for (const row of this.ring.slice(-CONSIDER_BACKFILL)) this.probe(row)
  }

  /**
   * Ask mobLookup about this mob, at most once per mob per session. Async by design: the answer
   * may be instant (own loot / quest catalog / cache) or a queued wiki call, so it lands on a
   * later flush — the registry's 1s tick pushes it even if the log has gone quiet.
   */
  private probe(row: ConsiderRow): void {
    const lookup = this.deps.lookupMob
    if (!lookup || row.knowledge || this.probing.has(row.id)) return
    this.probing.add(row.id)
    void lookup(row.mob)
      .then((k) => {
        // The row may have fallen off the ring while the lookup was in flight.
        const cur = this.byId.get(row.id)
        if (!cur) return
        cur.knowledge = k
        this.dirty.add(cur.id)
        // Out-of-band change with no fresh LogEvent seq. Bump it so useModule's gap/dupe check
        // (delta.seq must EXCEED the known seq) accepts the delta — the same trick eventFeed
        // and AlertsModule use for their async/out-of-band appends.
        this.seq += 1
      })
      .catch(() => {
        /* lookupMob never rejects in production; a test double might. Silence is correct — an
           unresolved mob simply has no knowledge, never a fabricated record. */
      })
      .finally(() => this.probing.delete(row.id))
  }

  /** Newest-last ring (the UI reverses it). */
  snapshot(): { seq: number; state: ConsiderSnap } {
    return { seq: this.seq, state: this.ring.map((r) => ({ ...r })) }
  }

  flushDelta(): { seq: number; delta: ConsiderDelta } | null {
    if (this.dirty.size === 0) return null
    const upserted: ConsiderRow[] = []
    for (const id of this.dirty) {
      const row = this.byId.get(id)
      // A row evicted by the cap before the flush has nothing to upsert; the renderer applies
      // the same cap, so it falls off there too.
      if (row) upserted.push({ ...row })
    }
    this.dirty = new Set()
    return { seq: this.seq, delta: { upserted } }
  }
}
