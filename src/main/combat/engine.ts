// The combat engine: a formal state machine over the log stream.
//
// State it maintains (see state.ts — EngineState):
//   petNames: Set<name>           — names of your ACTIVE pets, charmed OR summoned
//                                   (name-keyed). This is purely an ATTRIBUTION set —
//                                   it is NOT a charm roster. The world model owns the
//                                   charmed/summoned distinction (Instance.petKind).
//   zone:     string              — current zone (resets the overall aggregate)
//   current:  Encounter | null    — the in-progress/most-recent fight
//   history:  Encounter[]         — finalized fights
//   zoneAgg:  Agg                 — damage aggregated for the whole zone
//
// Transitions (one per ingested line — see ingest.ts):
//   zone     → finalize current, reset zoneAgg
//   charm    → petNames.add(mob)  (`<mob> has been charmed.` — only the charmer sees it)
//   petClaim → petNames.add(name) (`<Name> told you, '… Master.'` — the ONLY binding
//              signal for a random-named SUMMONED class pet; charmed mobs send it too)
//   uncharm/death(charm spell/mob death) → petNames.delete(mob)
//   cc     → mark the mob's instance engaged + CC-held (mez/root keep-alive)
//   damage → route to current encounter + zoneAgg (see routing.ts route())
//
// Attribution rule (damage `A → B` for N) — routing.ts classify():
//   A = You            → your outgoing
//   A ∈ petNames       → your pet's outgoing (unless B is friendly)
//   B = You            → incoming
//   otherwise          → not your fight (ignored)
//
// Encounter segmentation (Task #20 — death-closed, replacing the old idle-gap
// rule; the rules and their tuning constants live in encounter.ts, the evaluation in
// lifecycle.ts evalClosure). A fight CLOSES when either:
//   - every engaged hostile instance is GONE (retired = dead/zoned; or still alive but
//     with no PRESENCE evidence for PRESENCE_GONE_MS) AND LINGER_MS passes with no new
//     attributed damage → crisp pull boundaries from the death timeline. A multi-mob
//     pull is therefore ONE encounter: killing one add cannot close it while another is
//     demonstrably still swinging/casting/being healed (Task #55).
//   - OR no attributed damage AND no CC event for FALLBACK_IDLE_MS (fled/deagro).
// A CC (mez/root) application or refresh HOLDS the encounter open regardless of
// damage gaps while the CC'd instance is alive (the mez-and-wait case). Pet swap
// (uncharm/charm) is NOT a boundary event. Closure is time-driven, so it's evaluated
// both on the next ingested event and in snapshot(now) — finalization always stamps
// the encounter's own lastTs (a damage ts), never the eval moment. DPS uses
// (lastHit − firstHit), so it freezes when a fight ends. Each encounter also tracks
// activeMs (Σ capped gaps between hits) for an active-time DPS stat.
//
// Seeding: the engine is fed the entire log on load (recording=false) so charm
// and encounter state reflect reality before the live tail (recording=true)
// takes over — this is why a pet charmed before the app opened is still tracked.
//
// THIS FILE is the public face of all of that: one `CombatEngine` object owning one
// EngineState, plus snapshot assembly. Everything else is a module beside it —
// aggregate.ts (accumulators), encounter.ts (record types + constants), state.ts,
// ingest.ts (the switch), routing.ts / procRouting.ts (where a line lands),
// lifecycle.ts (when a segment opens/closes), sourceViews.ts + segmentViews.ts
// (serialization), healing.ts, fightSearch.ts, world.ts, taxonomy.ts.

import { EngineState } from './state'
import { ingestEvent } from './ingest'
import { encSummary, evalClosure, zoneSessionSummaries, zoneSummary } from './lifecycle'
import { buildSelected, buildTimeline } from './segmentViews'
import { searchFights } from './fightSearch'
import { ACTIVE_MS, SLOW_SAMPLE_CAP } from './encounter'
import type { LogEvent } from '../../shared/logEvents'
import type {
  BladeCoatState,
  CombatSnapshot,
  CurrentTarget,
  FightSearchResult,
  SegmentSummary,
  SlowRollup,
  SnapshotOpts,
  StanceState
} from '../../shared/combat'

export { classify } from './routing'
export type { Attribution } from './routing'

/**
 * The finalized fight summaries a snapshot serializes. Only the current encounter is
 * recomputed per call; finalized fight summaries are memoized (immutable). The window is
 * capped to `maxSegments` newest-first — the current encounter is always included
 * regardless of the cap, and the zone summary is appended by the caller.
 */
function collectSegments(st: EngineState, now: number, maxSegments: number): SegmentSummary[] {
  const segments: SegmentSummary[] = []
  if (st.current) segments.push(encSummary(st.current, 'current', now))
  const startIdx = st.history.length - 1
  const stopIdx = Math.max(0, st.history.length - maxSegments)
  for (let i = startIdx; i >= stopIdx; i--) {
    const e = st.history[i]
    segments.push(e.summary ?? encSummary(e, 'fight', now))
  }
  return segments
}

/**
 * DEFAULT selection = the FIGHT scope's head row: the open fight if there is one, else the
 * most recent finalized fight. Fight and Overall are an explicit user-chosen SCOPE now, so
 * this must never wander into the zone aggregate — a meter that swapped to zone-overall
 * between pulls is exactly what the user rejected. Overall is reached by ASKING for a zone
 * session id ('zone' / 'zs<n>'), never by default. With no fights at all the default
 * resolves to nothing (`selected: null`) and the UI shows a quiet "no fights yet" — the
 * renderer labels a finished head row honestly ("Last fight — X"), so nothing here has to
 * pretend a closed encounter is live.
 *
 * An explicit request is validated against ALL encounters, not just the capped segment
 * window — a selected finalized fight outside the cap is still fully resolvable via
 * buildSelected() (it searches history directly).
 */
function resolveSelectedId(st: EngineState, opts: SnapshotOpts): string {
  const defaultId = st.current?.id ?? st.history[st.history.length - 1]?.id ?? ''
  const selectableId =
    opts.selectedId === 'zone' ||
    st.current?.id === opts.selectedId ||
    st.history.some((h) => h.id === opts.selectedId) ||
    st.zoneHistory.some((z) => z.id === opts.selectedId)
  const explicitId = opts.selectedId && selectableId ? opts.selectedId : undefined
  return explicitId ?? defaultId
}

/** The live stance/invocation pair, as the snapshot carries it. */
function stanceState(st: EngineState): StanceState {
  return {
    stance: st.stance?.name,
    stanceTs: st.stance?.ts,
    invocation: st.invocation?.name,
    invocationTs: st.invocation?.ts
  }
}

export class CombatEngine {
  private st = new EngineState()

  /** Enable classification logging (after the historical scan, for the live tail), and
   *  flip HYDRATION off — from here on every snapshot describes the real present. */
  setLive(): void {
    this.st.setLive()
  }

  /**
   * Display names of your GENUINELY-CHARMED live pets (mobs bound by a
   * `<mob> has been charmed.` line). SUMMONED class pets are deliberately excluded —
   * they are pets, not charms. Deliberately NOT in the snapshot: no UI needs a charm
   * roster today, and the old snapshot field lied (it was the attribution set). This is
   * the ONLY correct door for one; never reconstruct it from petNames.
   */
  charmedPetNames(): string[] {
    return this.st.charmedPetNames()
  }

  /** Display names of ALL your live pets — charmed AND summoned. This is what the DPS
   *  meter attributes to (both kinds produce `kind: 'pet'` source rows). */
  petDisplayNames(): string[] {
    return this.st.petDisplayNames()
  }

  /**
   * The mob in front of you (law 6, LIVE half). Undefined when no encounter is open or when
   * the open encounter has not yet landed an outgoing hit — never a guess, never the largest
   * target (that is the FINALIZED naming rule and would relabel a live pull retroactively).
   *
   * READ-ONLY, and deliberately does NOT evaluate closure: snapshot() has already done that
   * before it calls this, so a fight that just closed on elapsed time reports nothing.
   */
  currentTarget(): CurrentTarget | undefined {
    const e = this.st.current
    if (!e?.lastOutTarget) return undefined
    return { name: e.lastOutTarget, others: Math.max(0, e.agg.targets.size - 1), lastTs: e.lastTs }
  }

  /**
   * Inject the player's own character name (from index.ts's tail ref). This is the
   * authoritative source: called before the scan replay and again on a character
   * switch after reset(). Keyed canonically so it matches the idKey() the heal path
   * uses. Wins over any heal-line-learned name.
   */
  setPlayerName(name: string): void {
    this.st.setPlayerName(name)
  }

  reset(): void {
    this.st.reset()
  }

  /**
   * Fold one canonical LogEvent into the state machine (ingest.ts). `live` drives the
   * classification ring (recording): historical replay events mutate state silently;
   * live events are also ring-logged.
   */
  ingestEvent(ev: LogEvent, live: boolean): void {
    ingestEvent(this.st, ev, live)
  }

  snapshot(now: number, opts: SnapshotOpts = {}): CombatSnapshot {
    // Encounters can close purely from elapsed time (death-linger / fallback). A
    // snapshot may be the first observation after that threshold, so evaluate the
    // deferred closure here (stamped at the encounter's own lastTs, not `now`).
    evalClosure(this.st, now)
    const st = this.st
    const combinePets = opts.combinePets ?? false
    const maxSegments = opts.maxSegments ?? 100
    const inCombat = !!st.current && now - st.current.lastTs < ACTIVE_MS

    const segments = collectSegments(st, now, maxSegments)
    segments.push(zoneSummary(st))

    const selectedId = resolveSelectedId(st, opts)
    const selected = buildSelected(st, selectedId, now, combinePets)

    const recent = (opts.showUnparsed ? st.recent : st.recent.filter((r) => r.cat !== 'unparsed')).slice(-150)
    const timeline = opts.timeline ? buildTimeline(st, selectedId, now) : undefined
    return {
      selectedId, selected, segments, inCombat, zone: st.zone,
      recent, stance: stanceState(st), timeline,
      // AFTER evalClosure() above: a fight that just closed on elapsed time reports nothing.
      currentTarget: this.currentTarget(),
      poison: { coat: this.coatState(), slow: this.slowRollup() },
      zoneSessions: zoneSessionSummaries(st),
      hydrating: st.hydrating
    }
  }

  /** The live blade-coat pair, copied out so a consumer can't mutate engine state. */
  private coatState(): BladeCoatState {
    return {
      utility: this.st.coatUtility ? { ...this.st.coatUtility } : undefined,
      combat: this.st.coatCombat.map((c) => ({ ...c }))
    }
  }

  /**
   * The rolling time-to-slow rollup (Task #64). Statistics are computed over the LANDED
   * samples ONLY; the nulls are surfaced as `noLand` so the reader sees both halves. With no
   * landed samples every statistic is absent rather than 0 — "0 ms to slow" would be a lie
   * about a thing that never happened.
   */
  private slowRollup(): SlowRollup {
    const landed = this.st.slowSamples.filter((s): s is number => s !== null).sort((a, b) => a - b)
    const pulls = this.st.slowSamples.length
    const base: SlowRollup = {
      pulls,
      landed: landed.length,
      noLand: pulls - landed.length,
      window: SLOW_SAMPLE_CAP
    }
    if (landed.length === 0) return base
    const sum = landed.reduce((a, b) => a + b, 0)
    const mid = landed.length >> 1
    return {
      ...base,
      avgMs: Math.round(sum / landed.length),
      medianMs: landed.length % 2 ? landed[mid] : Math.round((landed[mid - 1] + landed[mid]) / 2),
      minMs: landed[0],
      maxMs: landed[landed.length - 1]
    }
  }

  /**
   * SEARCH THE WHOLE FIGHT HISTORY (Task #61) — "it should go back for all time and be fast
   * and somewhat fuzzy" (the user).
   *
   * "All time" needs no new storage: `history` is UNCAPPED (only the per-encounter timeline
   * RINGS are capped, at TIMELINE_HISTORY_CAP, and zone sessions at ZONE_HISTORY_CAP), and
   * every finalized encounter already carries a memoized SegmentSummary. So this walks the
   * ENTIRE history — deliberately NOT the `maxSegments` window snapshot() serializes, which
   * is a payload cap, not a retention one — plus the live fight (as `kind: 'current'`, so an
   * open pull is findable by the mob you are presently swinging at).
   *
   * Newest-first, because the pure scorer breaks score ties by recency and a stable input
   * order keeps that deterministic. The scoring itself lives in the MUI/electron-free
   * fightSearch.ts; this method is only the corpus.
   *
   * READ-ONLY: no closure evaluation, no memoization side effects, nothing mutated — typing
   * in a search box must never be able to finalize a fight or move a point of damage.
   */
  searchFights(text: string, limit?: number, now: number = Date.now()): FightSearchResult {
    const summaries: SegmentSummary[] = []
    if (this.st.current) summaries.push(encSummary(this.st.current, 'current', now))
    for (let i = this.st.history.length - 1; i >= 0; i--) {
      const e = this.st.history[i]
      // `summary` is always populated by finalizeCurrent(); the fallback keeps this total
      // even if a future path ever pushes an encounter without memoizing one.
      summaries.push(e.summary ?? encSummary(e, 'fight', now))
    }
    return searchFights(summaries, text, limit)
  }
}
