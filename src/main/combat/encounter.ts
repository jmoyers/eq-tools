// The engine's ENCOUNTER / ZONE-SESSION record types, the tuning constants that govern
// segmentation and the ring caps, and the encounter NAMING rule — extracted verbatim from
// engine.ts. Pure data shapes + numbers; nothing here reads or mutates engine state.

import type { Agg } from './aggregate'
import type {
  CoatSlot,
  DamageCategory,
  SegmentSummary,
  SourceKind,
  TimelineMarkerKind,
  ZoneSessionSummary
} from '../../shared/combat'

/**
 * A finalized ZONE SESSION (Task #54). When the player zones, the live zoneAgg is frozen into
 * one of these (kept in a capped ring) instead of being discarded, so a past zone's overall
 * meter is still selectable. Holds the frozen Agg + timing + accumulated durations, plus a
 * memoized summary (computed once at finalize — the aggregate is immutable thereafter, mirroring
 * the Encounter.summary cached-summary pattern).
 */
export interface ZoneSession {
  id: string
  zone: string
  agg: Agg
  /** first/last attributed-damage ts (0 if the session saw no damage — those are dropped). */
  startTs: number
  lastTs: number
  /** Σ finalized-encounter wall durations (ms) — the DPS denominator, matching the live path. */
  finalizedMs: number
  /** Σ finalized-encounter activeMs. */
  activeMs: number
  /** Memoized summary fields (the aggregate is frozen at finalize). */
  summary: ZoneSessionSummary
}

export interface Encounter {
  id: string
  zone?: string
  startTs: number
  lastTs: number
  agg: Agg
  engaged: Set<string>
  /** instanceId → ts we last saw ANY evidence this instance is still in the fight.
   *  This is the PRESENCE (liveness) axis, deliberately distinct from the damage
   *  timeline: landed damage refreshes it, but so do misses (either direction),
   *  resists, CC, and heals involving the instance — a mob that whiffs for eight
   *  seconds, or spends them casting, is emphatically still here. It drives ONLY the
   *  "gone" staleness in evalClosure (see PRESENCE_GONE_MS); it never feeds
   *  firstHit/lastHit/DPS/activeMs, which stay damage-driven (AGENTS.md law 8). */
  engagedSeen: Map<string, number>
  /** Active-combat time accumulator (ms): on each attributed damage hit we add
   *  min(ts - prevDamageTs, ACTIVE_MS). First hit adds 0. See ACTIVE_MS. */
  activeMs: number
  /** ts of the previous attributed damage hit, for the activeMs delta. */
  prevDamageTs?: number
  /** instanceId → epoch-ms until which this engaged instance is CC-held. While any
   *  engaged instance is alive (CC'd instances count as alive), the encounter stays
   *  OPEN regardless of damage gaps — the mez-and-wait case. */
  ccActiveUntil: Map<string, number>
  /** Memoized SegmentSummary, populated once at finalize time. A finalized
   *  encounter is immutable, so its summary is stable for the rest of the session
   *  — recomputing it for all ~1,400 history entries on every snapshot() (2×+/sec)
   *  was the dominant snapshot cost (Task #17). */
  summary?: SegmentSummary
  /**
   * Per-encounter TIMELINE event ring (Task #51). Each attributed damage/miss instant is
   * appended here (absolute ts) for the timeline view; capped at TIMELINE_CAP (drop-
   * oldest) so a marathon charm-grind fight can't grow unbounded. Only retained for
   * encounters in the recent-history window (see TIMELINE_HISTORY_CAP) — older finalized
   * encounters have their ring dropped at finalize to keep the RSS delta small. */
  events: TimelineRaw[]
  /** TRUE count of every instant ever pushed into `events`, including ones the drop-oldest
   *  cap has since evicted. ONE integer per encounter (never per-event bookkeeping) — it is
   *  the only way a consumer can tell "the ring holds 8,000" from "the fight had 8,000":
   *  once TIMELINE_CAP engages, `events.length` saturates and would silently understate the
   *  fight. `eventsTotal > events.length` IS the truncation signal (TimelineView.truncated).
   *  Nothing else reads it — no aggregate, total or attribution depends on it. */
  eventsTotal: number
  /** Stance/invocation spans that overlapped this encounter (Task #51 pinned rows).
   *  Recorded as they change while the encounter is open (absolute ts). */
  stanceSpans: StanceRaw[]
  /** Point ANNOTATIONS on this fight's clock (Task #64): stance/invocation commits, blade
   *  coats, slow landings. Never downsampled and never counted from — see TimelineMarker.
   *  Capped drop-oldest at MARKER_CAP purely as a memory bound; the densest fight in the
   *  user's whole log carries three. */
  markers: MarkerRaw[]
  /** The UTILITY blade coat that was already on when this encounter opened (Task #64), and
   *  the combat venoms alongside it. Snapshotted at ensureEncounter() from the engine's live
   *  coat state, because "was a slow even possible in this pull?" is a question about the
   *  moment of engage — re-reading today's coat later would re-label old fights. */
  coatAtEngage?: CoatSlot
  combatAtEngage: CoatSlot[]
  /** Display name of the MOST RECENT outgoing-damage target (You or pet → mob), for the
   *  LIVE encounter name (Task #54): while a fight is open its name tracks whatever you're
   *  currently swinging at. On FINALIZE the name switches to the largest target (most damage
   *  absorbed) via encounterName(). undefined until the first outgoing hit lands. */
  lastOutTarget?: string
}

/** Internal raw timeline record (absolute ts; converted to relative at snapshot). */
export interface TimelineRaw {
  ts: number
  lane: string
  category: DamageCategory
  amount: number
  crit: boolean
  modifiers?: string[]
  kind: SourceKind
  /** 'miss' | 'resist' for avoided/resisted instants (Task #51 v2); absent = a landed hit. */
  outcome?: 'hit' | 'miss' | 'resist'
  /** miss subtype (dodge/parry/…) or 'resisted', for the tooltip. */
  detail?: string
  /** target/defender name, for the tooltip. */
  target?: string
}

/** Internal raw timeline MARKER (absolute ts; converted to relative at snapshot). */
export interface MarkerRaw {
  ts: number
  kind: TimelineMarkerKind
  label: string
  detail?: string
}

/** Internal raw stance/invocation span (absolute ts). `end` is undefined while active. */
export interface StanceRaw {
  group: 'stance' | 'invocation'
  name: string
  start: number
  end?: number
}

// Encounter closure (Task #20 — death-closed segmentation, replacing the old
// SEGMENT_GAP_MS idle rule). Two INDEPENDENT axes decide it, and conflating them was
// the multi-mob-pull split bug (Task #55):
//
//   TIMING axis (damage only) — LINGER_MS is measured against the encounter's last
//                 ATTRIBUTED DAMAGE. After every engaged hostile instance is gone,
//                 wait this long with no new damage before finalizing at the last
//                 damage ts: the linger absorbs the trailing DoT tick / cleanup swing.
//                 Nothing else may touch this clock — firstHit/lastHit/DPS/activeMs
//                 are damage-derived (AGENTS.md law 8).
//   PRESENCE axis (any evidence) — whether an engaged instance is still IN the fight,
//                 tracked per instance in Encounter.engagedSeen and refreshed by any
//                 observation of it: landed damage, misses in either direction,
//                 resists, CC, and heals it gives or receives. Presence never opens or
//                 extends an encounter; it only vetoes closing one.
//
//   PRESENCE_GONE_MS — how long a LIVE (not retired) engaged instance must go without
//                 ANY presence evidence before the death-close treats it as gone. A
//                 RETIRED instance is gone immediately (its death is the evidence; the
//                 LINGER_MS damage window still covers trailing hits), so this window
//                 only governs mobs that are still alive and simply quiet. It is
//                 deliberately 4× LINGER_MS because real fights go quiet for many
//                 seconds at a time: miss/dodge/parry streaks land nothing, mob cast
//                 phases (Stun/Root/Healing) produce no swings at all, a player stun
//                 stops YOUR damage, and the log flushes in multi-second batches while
//                 the closure is also evaluated against the WALL clock from
//                 snapshot(now). A genuinely fled mob still closes at
//                 FALLBACK_IDLE_MS — 3× sooner than it would if we waited that out.
//   FALLBACK_IDLE_MS — if there's no attributed damage AND no CC event for this long
//                 while instances remain engaged-but-not-retired (mob fled/deagroed,
//                 the log never reports a death), close anyway.
//   ACTIVE_MS   — per-hit active-time cap AND the "in combat" freshness window.
export const LINGER_MS = 5_000
export const PRESENCE_GONE_MS = 20_000
export const FALLBACK_IDLE_MS = 60_000
// How long a single CC application/refresh keeps an instance "held" (alive for
// closure) without further evidence. A live mez is re-applied well within this, and
// resumed damage refreshes activity; this is only the backstop expiry for a CC that
// is never refreshed and never followed by damage (so a lone mez can't pin a fight
// open forever). It exceeds FALLBACK_IDLE_MS so an actively-refreshed mez holds.
export const CC_HOLD_MS = 120_000
export const ACTIVE_MS = 3_000
export const RECENT_CAP = 300
// Zone-session history cap (Task #54): how many FINALIZED zone sessions to retain (the live one
// is separate). Each holds only frozen aggregate maps + a small summary — no per-event rings — so
// 20 sessions is a trivial footprint (see the finalize note + the task report).
export const ZONE_HISTORY_CAP = 20

// Timeline (Task #51):
//   TIMELINE_CAP          — per-encounter event ring size (drop-oldest). Bumped 5k→8k for
//                           Task #51 v2: miss AND resist ticks now enter the ring (misses
//                           are ~70% of combat lines), so the densest fight's instant count
//                           roughly doubled. Full-log measurement (2026-08-02): exactly ONE
//                           marathon charm-grind fight exceeds 5k, peaking at 5259 instants;
//                           8k captures it with ZERO drop-oldest at trivial cost (only ≤60
//                           rings are ever retained — see TIMELINE_HISTORY_CAP — so the
//                           whole-session RSS delta stays well under 1MB, dominated by the
//                           68MB log string, not the ring). If a denser fight ever DOES
//                           overflow it, the loss is DECLARED, not silent: Encounter.
//                           eventsTotal keeps the true count and TimelineView.truncated
//                           tells the renderer its event-derived panels are lower bounds.
//   TIMELINE_HISTORY_CAP  — how many finalized encounters keep their event ring after
//                           finalize. Older ones drop the ring (timeline only for recent /
//                           live fights) so the whole-session RSS delta stays bounded.
//   TIMELINE_BUDGET       — max events serialized into a single TimelineView; above this
//                           the engine downsamples (uniform stride) and flags it.
export const TIMELINE_CAP = 8_000
export const TIMELINE_HISTORY_CAP = 60
export const TIMELINE_BUDGET = 2_000

// Rogue poisons (Task #64):
//   MARKER_CAP     — per-encounter marker ring (drop-oldest). Markers are point annotations
//                    (stance/invocation commits, coats, slow landings), NOT damage: they are
//                    never downsampled, because uniform-striding a sparse series just deletes
//                    most of it. Measured on the user's whole log, the densest single fight
//                    carries 3 markers, so this cap is a pure memory bound and has never
//                    engaged. No COUNT is derived from markers (ProcAccum is), so even if it
//                    did engage no statistic would move.
//   SLOW_SAMPLE_CAP — how many recent QUALIFYING pulls (a slow-capable coat on at engage) the
//                    rolling time-to-slow ring keeps. Small on purpose: this is meant to
//                    answer "how is my poison doing right now", not to average a whole
//                    evening's worth of loadouts together.
export const MARKER_CAP = 1_000
export const SLOW_SAMPLE_CAP = 25

/**
 * The name of an encounter (Task #54). Two modes:
 *   - `live=false` (FINALIZED / any non-current view): named after the LARGEST target —
 *     the mob that absorbed the most damage. The log has no HP, so "most damage absorbed"
 *     is a LABELED proxy for "the thing we were killing" (AGENTS.md world-model law 6).
 *   - `live=true` (the CURRENT open fight): named after whatever you're presently swinging
 *     at (the most-recent outgoing target), so a live pull is labeled by the mob in front of
 *     you, not retroactively by whichever twin ended up taking the most damage.
 * Both keep the '+N others' suffix counting the OTHER distinct engaged targets.
 */
export function encounterName(e: Encounter, live = false): string {
  const targets = [...e.agg.targets.values()]
  if (targets.length === 0) return 'Combat'
  const others = targets.length - 1
  const suffix = others > 0 ? ` +${others}` : ''
  if (live && e.lastOutTarget) return `${e.lastOutTarget}${suffix}`
  const top = [...targets].sort((a, b) => b.amount - a.amount)[0].name
  return `${top}${suffix}`
}
