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
//   4. CONSIDER — a LIVE `consider` line (Task #63): you sized something up, so the feed says
//                 what it was, how hard, and (via the row's hover card) what it drops. Unlike
//                 loot this needs no lookup to be admitted — the log line already carries every
//                 field of the row; drop knowledge is the HOVER's job, resolved lazily.
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
import type { ConsiderFaction, LogEvent } from '../../shared/logEvents'
import type { FeedDelta, FeedEvent, FeedReport, FeedSnap, ItemKnowledge } from '../../shared/types'
import { isNotableKnowledge } from '../../shared/itemKnowledge'
import { considerDifficultyShort } from '../../shared/logEvents'

/** How many entries the feed keeps. Oldest fall off the back. */
export const FEED_CAP = 100

/**
 * CONSIDER ANTI-SPAM WINDOW (Task #63). Re-conning the same mob inside this window appends NO
 * second feed row. The real log makes this mandatory, not decorative: conning is a reflex, and
 * the same mob routinely appears two or three times a second or two apart (Guard V`Lex at
 * 18:56:38 / :44 / :45; A Nisch Val Gnoll at 22:43:16 / :23 / :25; Karam Dragonforge four times
 * in 25 seconds, across three different faction rungs as his faction shifted). 10s comfortably
 * covers those bursts while still admitting a genuine re-con later in a pull.
 *
 * The window is per MOB, keyed by the canonical name — and it lives HERE, at the feed boundary,
 * rather than in the consider module: the module's ring already collapses repeats structurally
 * (one row per mob), so the feed is the only surface a burst could actually spam.
 */
export const CONSIDER_FEED_DEDUPE_MS = 10_000

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
  /** mob name (lowercased) → ts of the last con we ADMITTED. See CONSIDER_FEED_DEDUPE_MS. */
  private lastCon = new Map<string, number>()

  constructor(private deps: EventFeedDeps = {}) {}

  reset(): void {
    // A character switch is a different world: drop the feed with the rest of the
    // character-scoped state. Defs/knowledge live elsewhere and are unaffected.
    this.ring = []
    this.pending = []
    this.probing.clear()
    this.lastCon.clear()
    this.seq = 0
  }

  onEvent(ev: LogEvent, live: boolean): void {
    this.seq = ev.seq
    // Historical replay contributes NOTHING (see the hydration note above).
    if (!live) return
    if (ev.kind === 'consider') {
      this.noteConsider({ mob: ev.mob, rare: ev.rare, level: ev.level, faction: ev.faction, difficulty: ev.difficulty, ts: ev.ts })
      return
    }
    if (ev.kind !== 'loot' || !ev.item) return
    this.probeLoot(ev.item, ev.source, ev.ts)
  }

  /**
   * Append a consider row, unless the same mob was already admitted inside the anti-spam window
   * (CONSIDER_FEED_DEDUPE_MS). No lookup gates admission — every field below came straight off
   * the log line, so the row is honest with zero network. What the mob DROPS is the hover
   * card's job (`mobs:lookup`), resolved lazily when the user points at the row.
   *
   * `detail` is the glanceable summary: `Lvl 38 · suicide`, with a `· rare` marker when the
   * line carried the rare-creature infix. An unrecognized difficulty clause falls back to the
   * VERBATIM clause rather than a guessed label. `page` is deliberately absent — the wiki page
   * isn't known yet at this point, and a fabricated link is worse than none.
   */
  noteConsider(con: {
    mob: string
    rare: boolean
    level: number | undefined
    faction: ConsiderFaction
    difficulty: string
    ts: number
  }): void {
    const { mob, rare, level, faction, difficulty, ts } = con
    const key = mob.trim().toLowerCase()
    const last = this.lastCon.get(key)
    if (last !== undefined && ts - last < CONSIDER_FEED_DEDUPE_MS) return
    this.lastCon.set(key, ts)
    const bits: string[] = []
    if (level != null) bits.push(`Lvl ${level}`)
    bits.push(considerDifficultyShort(difficulty) ?? difficulty)
    if (rare) bits.push('rare')
    this.append({
      kind: 'con',
      ts,
      title: mob,
      detail: bits.join(' · '),
      con: { faction, level, rare, difficulty }
    })
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
    if (r?.kind !== 'quest' || !r.title) return
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
