// eventFeed module (Task #59) — the live event log behind the 'events' overlay.
//
// A capped ring of FeedEvents ("things worth noticing"), served over the ordinary module
// transport (`module:getSnapshot` / `module:delta`) so the overlay window hydrates on open and
// then rides deltas exactly like every other view.
//
// THREE SOURCES, all of them existing detectors — this module invents nothing:
//   1. ALERTS   — index.ts hands every fire from the AlertsModule delta (main-side event/raw
//                 triggers) AND every renderer-routed 'app'-signal fire (alerts:appFired) to
//                 `noteAlertFire`. Cooldowns/enabled were already applied upstream.
//   2. LOOT     — a LIVE `loot` event kicks a cache-first item lookup (injected, so tests need
//                 no network); the row is appended ONLY if the item comes back NOTABLE by the
//                 shared predicate (lore / quest-flagged / used by a quest). This replaces the
//                 old bare prefetch call in index.ts — one lookup, same warm cache.
//   3. QUESTS   — the renderer's posky/turn-in detector reports a completion over `feed:report`
//                 (`report()`), because only the renderer can match turn-ins against posky.
//
// HYDRATION (the celebration-detector rule, AGENTS.md "Celebrations"): the startup replay must
// NOT spam the feed with hours-old events. Rather than seeding a baseline and diffing, this
// module simply IGNORES every historical event — `onEvent` returns immediately when `live` is
// false, and the two out-of-band inputs (alerts, quest reports) are live-only by construction
// upstream. The ring therefore starts EMPTY and only ever contains events observed after the
// tail took over. That is the silent baseline, expressed as "nothing historical is admitted".
//
// HONESTY (law 1): a field is present only when something knows it. A quest whose dataset names
// no reward carries no `reward`, so the UI has no item hover to show — never a fabricated one.

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import type { FeedDelta, FeedEvent, FeedReport, FeedSnap, ItemKnowledge } from '../../shared/types'
import { isNotableKnowledge } from '../../shared/itemKnowledge'

/** How many entries the feed keeps. Oldest fall off the back. */
export const FEED_CAP = 100

/** Strip a raw log line's `[Sat Aug 02 13:00:28 2026] ` prefix for display. */
export function stripLogTimestamp(raw: string): string {
  return raw.replace(/^\[[^\]]*\]\s*/, '').trim()
}

export interface EventFeedDeps {
  /**
   * Resolve an item's lore/quest knowledge — main's `lookupItem` in production (local posky
   * first, then the cached + politely-throttled wiki lookup; never throws). Injected so the
   * module is unit-testable without a network or a userData cache. Omit to disable the loot
   * source entirely.
   */
  lookupItem?: (name: string) => Promise<ItemKnowledge>
}

export class EventFeedModule implements EqModule<FeedSnap, FeedDelta> {
  readonly id = 'eventFeed'
  private ring: FeedEvent[] = []
  private pending: FeedEvent[] = []
  private seq = 0
  private idCounter = 0
  /** Item names with a lookup in flight, so a stacked loot burst probes each name once. */
  private probing = new Set<string>()

  constructor(private deps: EventFeedDeps = {}) {}

  reset(): void {
    // A character switch is a different world: drop the feed with the rest of the
    // character-scoped state. Defs/knowledge live elsewhere and are unaffected.
    this.ring = []
    this.pending = []
    this.probing.clear()
    this.seq = 0
  }

  onEvent(ev: LogEvent, live: boolean): void {
    this.seq = ev.seq
    // Historical replay contributes NOTHING (see the hydration note above).
    if (!live) return
    if (ev.kind !== 'loot' || !ev.item) return
    this.probeLoot(ev.item, ev.source, ev.ts)
  }

  /**
   * Probe a freshly-looted item and append a feed row IFF it's notable. Async: the answer may
   * be instant (posky-local / cached) or a queued wiki call, so the row lands on a later flush
   * — the registry's 1s wall-clock tick pushes it even if the log goes quiet. The row keeps the
   * LOOT timestamp, not the resolve time.
   */
  private probeLoot(item: string, source: string | undefined, ts: number): void {
    const lookup = this.deps.lookupItem
    if (!lookup) return
    const key = item.toLowerCase()
    if (this.probing.has(key)) return
    this.probing.add(key)
    void lookup(item)
      .then((k) => {
        if (!isNotableKnowledge(k)) return
        this.append({
          kind: 'loot',
          ts,
          title: k.name || item,
          detail: source ? `from ${source}` : undefined,
          page: k.page
        })
      })
      .catch(() => {
        /* lookupItem never rejects in production; a test double might. Silence is correct —
           an unknown item is simply not notable, never a fabricated row. */
      })
      .finally(() => this.probing.delete(key))
  }

  /**
   * Record an alert fire. `name` is the alert's display name (main resolves it from the defs);
   * `matchedText` is the raw log line for event/raw triggers, or the app-signal context (e.g.
   * the boss/quest name) for renderer-routed fires.
   */
  noteAlertFire(name: string, matchedText: string, ts: number): void {
    this.append({
      kind: 'alert',
      ts,
      title: name,
      detail: stripLogTimestamp(matchedText) || undefined
    })
  }

  /** Append a renderer-reported event (today: quest completions — see FeedReport). */
  report(r: FeedReport): void {
    if (!r || r.kind !== 'quest' || !r.title) return
    this.append({
      kind: 'quest',
      ts: r.ts || Date.now(),
      title: r.title,
      detail: r.detail,
      page: r.page,
      reward: r.reward
    })
  }

  private append(e: Omit<FeedEvent, 'id'>): void {
    const full: FeedEvent = { id: `f${++this.idCounter}`, ...e }
    this.ring.push(full)
    if (this.ring.length > FEED_CAP) this.ring.splice(0, this.ring.length - FEED_CAP)
    this.pending.push(full)
    // Out-of-band appends (async loot resolves, alert fires, renderer reports) carry no fresh
    // LogEvent seq. Bump it so useModule's gap/dupe check (delta.seq must exceed the known seq)
    // accepts the delta — the same trick AlertsModule.appFired uses.
    this.seq += 1
  }

  /** Newest-last ring (the UI reverses it). */
  snapshot(): { seq: number; state: FeedSnap } {
    return { seq: this.seq, state: this.ring.slice() }
  }

  flushDelta(): { seq: number; delta: FeedDelta } | null {
    if (this.pending.length === 0) return null
    const appended = this.pending
    this.pending = []
    return { seq: this.seq, delta: { appended } }
  }
}
