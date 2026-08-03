// SEGMENT SERIALIZATION — turning a selected fight / zone session into the SegmentView the
// renderer draws, and the per-fight TimelineView. Extracted verbatim from engine.ts.
//
// READ-ONLY over the engine, by design: selecting a fight or asking for a timeline must never
// be able to finalize an encounter or move a point of damage (asserted by
// tests/combatRingTruncation.test.mts).

import { sourceViews } from './sourceViews'
import { sumHeal } from './aggregate'
import { buildHealingView } from './healing'
import { buildProcsView } from './procViews'
import { zoneActiveSec, zoneDurationSec } from './lifecycle'
import { ACTIVE_MS, TIMELINE_BUDGET, encounterName, type Encounter, type TimelineRaw } from './encounter'
import { CATEGORY_ORDER } from '../../shared/combat'
import type { Agg } from './aggregate'
import type { EngineState } from './state'
import type {
  DamageCategory,
  HealerView,
  SegmentView,
  SourceKind,
  StanceSpan,
  TimelineEvent,
  TimelineMarker,
  TimelineView
} from '../../shared/combat'

/** Everything a SegmentView needs about the segment it describes. Bundled because a fight,
 *  the live zone aggregate and a frozen zone session differ only in these fields. */
interface ViewSpec {
  id: string
  kind: 'fight' | 'zone'
  name: string
  zone: string | undefined
  agg: Agg
  durationSec: number
  activeSec: number
  active: boolean
  /** Engine state, for the SESSION-level active-state timeline the proc view clips its spans
   *  from. Read-only here, like everything else in this module. */
  st: EngineState
  /** Segment span in absolute ms (first/last attributed damage). The proc view clips the state
   *  spans to it; a segment that saw no damage carries 0/0 and reports no spans. */
  startTs: number
  endTs: number
  /** Present only for a FIGHT — see buildProcsView. */
  enc?: Encounter
}

export function buildSelected(st: EngineState, id: string, now: number, combinePets: boolean): SegmentView | null {
  if (id === 'zone') {
    const zDur = zoneDurationSec(st)
    return buildView({
      id: 'zone', kind: 'zone', name: `${st.zone ?? 'Session'} — overall`, zone: st.zone,
      agg: st.zoneAgg, durationSec: zDur, activeSec: Math.min(zDur, zoneActiveSec(st)), active: false,
      st, startTs: st.zoneStartTs, endTs: st.zoneLastTs
    }, combinePets)
  }
  // A finalized zone SESSION (Task #54): rebuild its full breakdown from the frozen aggregate.
  const zs = st.zoneHistory.find((z) => z.id === id)
  if (zs) {
    const zDur = Math.max(1, zs.finalizedMs / 1000)
    const zActive = Math.min(zDur, zs.activeMs / 1000)
    return buildView({
      id: zs.id, kind: 'zone', name: `${zs.zone} — overall`, zone: zs.zone,
      agg: zs.agg, durationSec: zDur, activeSec: zActive, active: false,
      st, startTs: zs.startTs, endTs: zs.lastTs
    }, combinePets)
  }
  const e = st.current?.id === id ? st.current : st.history.find((h) => h.id === id)
  if (!e) return null
  const dur = Math.max(1, (e.lastTs - e.startTs) / 1000)
  const activeSec = Math.min(dur, e.activeMs / 1000)
  const isCurrent = st.current?.id === id
  const active = isCurrent && now - e.lastTs < ACTIVE_MS
  return buildView({
    id: e.id, kind: 'fight', name: encounterName(e, isCurrent), zone: e.zone,
    agg: e.agg, durationSec: dur, activeSec, active, enc: e,
    st, startTs: e.startTs, endTs: e.lastTs
  }, combinePets)
}

function buildView(spec: ViewSpec, combinePets: boolean): SegmentView {
  const { agg, durationSec, activeSec } = spec
  const entities = sourceViews(agg.out, durationSec, combinePets)
  const incoming = sourceViews(agg.inc, durationSec, false)
  const outTotal = entities.reduce((s, e) => s + e.total, 0)
  const inTotal = incoming.reduce((s, e) => s + e.total, 0)
  const incomingHealers: HealerView[] = [...agg.incHeal.values()]
    .map((h) => ({ name: h.name, total: h.amount, count: h.count }))
    .sort((a, b) => b.total - a.total)
  return {
    id: spec.id,
    kind: spec.kind,
    name: spec.name,
    zone: spec.zone,
    durationSec,
    active: spec.active,
    activeSec,
    outTotal,
    outDps: outTotal / durationSec,
    activeDps: outTotal / Math.max(1, activeSec),
    entities,
    inTotal,
    inDps: inTotal / durationSec,
    incoming,
    enemyHealTotal: sumHeal(agg.enemyHeal),
    incomingHealTotal: incomingHealers.reduce((s, h) => s + h.total, 0),
    incomingHealers,
    healing: buildHealingView(agg.heal, durationSec),
    procs: buildProcsView({
      st: spec.st, agg, id: spec.id, kind: spec.kind, durationSec, activeSec,
      startTs: spec.startTs, endTs: spec.endTs, enc: spec.enc
    })
  }
}

/** One ring record → one serialized timeline instant (absolute ts → ms-since-start). The
 *  optional fields are spread in only when set, so a plain landed hit keeps its exact
 *  pre-#51v2 shape. */
function timelineEvent(r: TimelineRaw, start: number): TimelineEvent {
  return {
    t: Math.max(0, r.ts - start),
    lane: r.lane,
    category: r.category,
    amount: r.amount,
    crit: r.crit,
    modifiers: r.modifiers?.length ? r.modifiers : undefined,
    kind: r.kind,
    ...(r.outcome && r.outcome !== 'hit' ? { outcome: r.outcome } : {}),
    ...(r.detail ? { detail: r.detail } : {}),
    ...(r.target ? { target: r.target } : {})
  }
}

/** Walk the ring once: aggregate EVERY event into its lane (so lane totals and ordering are
 *  accurate even when the plotted instants are downsampled) while emitting only the
 *  stride-sampled ones. */
function collectTimeline(
  raw: TimelineRaw[],
  start: number,
  stride: number
): { events: TimelineEvent[]; lanes: TimelineView['lanes'] } {
  const events: TimelineEvent[] = []
  const laneAgg = new Map<string, { category: DamageCategory; total: number; kind: SourceKind }>()
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]
    // Lane aggregation uses EVERY event (not just sampled ones) so a lane's total and
    // ordering are accurate even when the plotted instants are downsampled.
    const la = laneAgg.get(r.lane) ?? { category: r.category, total: 0, kind: r.kind }
    la.total += r.amount
    laneAgg.set(r.lane, la)
    if (i % stride !== 0) continue
    events.push(timelineEvent(r, start))
  }
  const lanes = [...laneAgg.entries()]
    .map(([lane, v]) => ({ lane, category: v.category, total: v.total, kind: v.kind }))
    .sort((a, b) =>
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || b.total - a.total
    )
  return { events, lanes }
}

/**
 * Build the selected encounter's timeline view (Task #51). Returns null for the zone
 * selection (no single-fight timeline) or an encounter whose event ring was evicted
 * (older than TIMELINE_HISTORY_CAP). Converts absolute ts → ms-since-start, downsamples
 * with a uniform stride when over TIMELINE_BUDGET, and derives the Y-axis lanes (grouped
 * by category, then total desc) + the pinned stance/invocation spans.
 *
 * READ-ONLY over the encounter: it copies out of the ring and never mutates the ring, the
 * aggregate or any counter — asking for a timeline can't move a point of damage (asserted
 * by tests/combatRingTruncation.test.mts).
 */
export function buildTimeline(st: EngineState, id: string, now: number): TimelineView | null {
  if (id === 'zone') return null
  const cur = st.current
  const isCurrent = cur?.id === id
  const e = isCurrent ? cur : st.history.find((h) => h.id === id)
  if (!e) return null
  // An evicted finalized encounter carries no ring — no timeline available.
  if (e.events.length === 0 && e !== st.current) return null
  const start = e.startTs
  const endTs = isCurrent ? Math.max(e.lastTs, now) : e.lastTs
  const durationMs = Math.max(1, endTs - start)

  const raw = e.events
  const rawCount = raw.length
  // TRUNCATION (drop-oldest already engaged): the ring holds only the most recent
  // TIMELINE_CAP instants of a longer fight. `rawCount` stays the ring occupancy — it is
  // the population the stride samples, so it is the honest sampling denominator — while
  // `totalCount` carries the fight's true instant count so the renderer can say "N of M"
  // without understating M. Deliberately NOT folded into the sampling factor: scaling by
  // totalCount/kept would extrapolate the discarded prefix from the retained tail, which
  // is exactly the silent guess law 1 forbids.
  const totalCount = Math.max(rawCount, e.eventsTotal)
  const truncated = totalCount > rawCount
  // Uniform-stride downsample when over budget (keeps the temporal shape; a dense
  // charm-grind fight is capped so the payload/render stays cheap).
  const stride = rawCount > TIMELINE_BUDGET ? Math.ceil(rawCount / TIMELINE_BUDGET) : 1
  const { events, lanes } = collectTimeline(raw, start, stride)
  const stanceSpans: StanceSpan[] = e.stanceSpans.map((s) => ({
    group: s.group,
    name: s.name,
    start: Math.max(0, s.start - start),
    end: Math.max(0, (s.end ?? endTs) - start)
  }))
  // MARKERS ARE NOT DOWNSAMPLED (Task #64) — every one is carried, deliberately, whatever
  // `stride` does to the damage instants above. They are sparse by construction and drawing
  // one in five of them would be worse than drawing none.
  const markers: TimelineMarker[] = e.markers.map((m) => ({
    t: Math.max(0, m.ts - start),
    kind: m.kind,
    label: m.label,
    ...(m.detail ? { detail: m.detail } : {})
  }))
  return {
    id: e.id,
    name: encounterName(e, isCurrent),
    startTs: start,
    durationMs,
    lanes,
    events,
    stanceSpans,
    markers,
    downsampled: stride > 1,
    rawCount,
    totalCount,
    truncated
  }
}
