// THE ACTIVE-STATE TIMELINE (docs/plans/proc-analytics.md §3) — "what was on at time T", as
// an interval model with EVIDENCE on both edges.
//
// WHY IT LIVES IN THE COMBAT ENGINE. Three of the four kinds already have exactly one owner
// here: EngineState owns `stance` / `invocation` and the two-slot coat state, and
// `Encounter.stanceSpans` is already a span list. A parallel service would fork state that has
// one owner today, and forked state drifts. The BuffsModule is the wrong home and cannot be
// the home — it is reached only via `registry.snapshot(id)` (there is no cross-module read
// path), and its job is MINING DURATIONS under own-cast gating, which is a different question
// from "was this on at time T"; it cannot see stances or coats at all.
//
// DELIBERATELY NOT MERGED with `Encounter.stanceSpans`: that list is consumed by the shipped
// TimelineView and sits inside the byte-identical regression surface. Two lists, one shared
// writer (procRouting.applyStance). This ring is SESSION-level and purely additive.
//
// LAW 1 IS THE SHAPE OF THIS FILE. The game prints a state's START (a stance commit, a coat
// line, a buff landing). It almost never prints the END — the real log carries 97
// `Instrument of Nife` landings against ONE observed fade. So every edge is labeled: only a
// line the game printed earns 'observed'; a replacing sibling is 'inferred'; a severed
// boundary is 'censored' and NEVER renders as an end time.

import type { EdgeEvidence, StateKind, StateSpan } from '../../shared/procAnalytics'

/**
 * Memory bound only — the whole 1.1M-line log produces ~700 stance+invocation commits, 6
 * coats and 97 buff applies, so this is never reached in practice. Drop-oldest, like every
 * other ring in the engine.
 */
export const STATE_SPAN_CAP = 2_000

/**
 * The engine-internal span record: the shared `StateSpan` plus the EXCLUSIVITY GROUP, which
 * is the whole mechanism by which an unprinted end becomes an inferred one.
 *
 * Groups, and why each is what it is:
 *   'stance' / 'invocation' — nine members each, mutually exclusive, so a new commit ENDS the
 *                             previous span. The game prints no "your stance ends" line.
 *   'coat:utility'          — one slot; a new utility coat replaces the old one.
 *   'coat:combat:<key>'     — combat venoms STACK (wiki, Rogue page; proved by the real log),
 *                             so each venom is its own group and only a RE-coat of the SAME
 *                             venom supersedes.
 *   'buff:<key>'            — a re-apply supersedes its own span; unrelated buffs coexist.
 *
 * `group` is engine-internal on purpose: `spansOverlapping()` projects plain `StateSpan`s, so
 * the shared payload type never grows a field the renderer has no use for.
 */
export interface SpanRecord extends StateSpan {
  group: string
}

/** Everything needed to open a span. An args object, not a parameter list — the plan's
 *  six-argument `noteState` would blow the repo's `max-params 4`. */
export interface OpenStateArgs {
  kind: StateKind
  /** Canonical join key — lowercased (law 2: canonicalize at boundaries). */
  key: string
  /** Display name, raw casing. */
  name: string
  ts: number
  /** Exclusivity group; defaults to `<kind>:<key>` (self-exclusive: only a re-open of the
   *  same state supersedes). */
  group?: string
  /** Defaults to 'observed' — a span only ever opens because a line was printed. */
  startEvidence?: EdgeEvidence
}

/** Everything needed to close a span from a printed line. */
export interface CloseStateArgs {
  kind: StateKind
  key: string
  ts: number
  endEvidence: EdgeEvidence
}

/** The join key a window ledger / link join uses: one string per active state. */
export function stateKeyOf(kind: StateKind, key: string): string {
  return `${kind}:${key}`
}

/**
 * The session-level span ring plus its LIVE open index.
 *
 * `active` is a mutable set of `<kind>:<key>` for every currently-open span. It exists so the
 * per-event hot paths (every damage line, every swing) can ask "what is on right now" in O(1)
 * instead of rescanning the ring — a linear `activeAt()` per damage event would be ~400M
 * comparisons over a full-log replay. It is exposed READ-ONLY by contract: the class is the
 * only writer.
 */
export class StateTimeline {
  spans: SpanRecord[] = []
  /** `<kind>:<key>` of every open span. Read-only to callers; mutated here only. */
  readonly active = new Set<string>()
  /** group → the one OPEN span in that group. The exclusivity index. */
  private open = new Map<string, SpanRecord>()

  reset(): void {
    this.spans = []
    this.active.clear()
    this.open.clear()
  }

  /**
   * Open a span, closing whatever open span shares its exclusivity group as 'inferred' — the
   * only honest verdict when the game never printed an end. Callers that can be re-asserted
   * with no state change (applyStance) already drop the no-op before reaching here, so this
   * never accrues zero-width spans from re-commits.
   */
  noteState(a: OpenStateArgs): void {
    const group = a.group ?? stateKeyOf(a.kind, a.key)
    const prev = this.open.get(group)
    if (prev) this.finish(prev, a.ts, 'inferred')
    const span: SpanRecord = {
      kind: a.kind,
      key: a.key,
      name: a.name,
      startTs: a.ts,
      startEvidence: a.startEvidence ?? 'observed',
      endEvidence: 'open',
      group
    }
    this.spans.push(span)
    if (this.spans.length > STATE_SPAN_CAP) this.dropOldest()
    this.open.set(group, span)
    this.active.add(stateKeyOf(a.kind, a.key))
  }

  /** Close the open span for (kind, key) — the printed-end path. A close with nothing open is
   *  a no-op: the game can print a wears-off for a buff whose landing predates the replay, and
   *  fabricating a zero-width span for it would be an invention. */
  closeState(a: CloseStateArgs): void {
    for (const span of this.open.values()) {
      if (span.kind === a.kind && span.key === a.key) {
        this.finish(span, a.ts, a.endEvidence)
        return
      }
    }
  }

  /** Close EVERY open span in a group (the combat-coat dry line: it names the family, and the
   *  log CANNOT say which venom of a stack expired — law 6). */
  closeGroupPrefix(prefix: string, ts: number, endEvidence: EdgeEvidence): void {
    for (const span of [...this.open.values()]) {
      if (span.group.startsWith(prefix)) this.finish(span, ts, endEvidence)
    }
  }

  /**
   * A boundary severed every span: epoch, engine reset, player death. The end is UNKNOWABLE,
   * so it is 'censored' — never 'observed', and never a fabricated expiry. The spans stay in
   * the ring (they describe real, observed intervals up to the cut); only their end evidence
   * says the cut is where our knowledge stops.
   */
  censorAll(ts: number): void {
    for (const span of [...this.open.values()]) this.finish(span, ts, 'censored')
  }

  /** Spans that overlap [fromTs, toTs], projected to the shared payload shape. An OPEN span
   *  overlaps any window that ends after it started. */
  spansOverlapping(fromTs: number, toTs: number): StateSpan[] {
    const out: StateSpan[] = []
    for (const s of this.spans) {
      const end = s.endTs ?? Number.POSITIVE_INFINITY
      if (end >= fromTs && s.startTs <= toTs) out.push(project(s))
    }
    return out
  }

  /** Spans covering an instant. `[startTs, endTs)` — a state that ended exactly at `ts` was
   *  replaced at `ts`, and counting both sides of a switch as active would make every
   *  transition look like an overlap. */
  activeAt(ts: number): StateSpan[] {
    const out: StateSpan[] = []
    for (const s of this.spans) {
      if (s.startTs <= ts && (s.endTs === undefined || ts < s.endTs)) out.push(project(s))
    }
    return out
  }

  private finish(span: SpanRecord, ts: number, endEvidence: EdgeEvidence): void {
    span.endTs = ts
    span.endEvidence = endEvidence
    this.open.delete(span.group)
    this.active.delete(stateKeyOf(span.kind, span.key))
  }

  /** Drop-oldest under the cap. A dropped span may still be the OPEN one for its group (a
   *  permanent buff outliving 2,000 later commits), so the open index is repaired rather than
   *  left pointing at a record no longer in the ring. */
  private dropOldest(): void {
    const gone = this.spans.shift()
    if (!gone) return
    if (this.open.get(gone.group) === gone) {
      this.open.delete(gone.group)
      this.active.delete(stateKeyOf(gone.kind, gone.key))
    }
  }
}

/** Milliseconds of [fromTs, toTs] a span covers. An OPEN span is clamped at `toTs` — it has no
 *  end, and inventing one past the last observation would be a claim about the future. */
export function overlapMs(span: StateSpan, fromTs: number, toTs: number): number {
  const end = span.endTs ?? toTs
  return Math.max(0, Math.min(end, toTs) - Math.max(span.startTs, fromTs))
}

/** True when a span covers the WHOLE of [fromTs, toTs] — the purity half of the Tier-B
 *  eligibility gate ("active for the whole window or inactive for the whole window"). */
export function coversWholly(span: StateSpan, fromTs: number, toTs: number): boolean {
  return span.startTs <= fromTs && (span.endTs === undefined || span.endTs >= toTs)
}

function project(s: SpanRecord): StateSpan {
  return {
    kind: s.kind,
    key: s.key,
    name: s.name,
    startTs: s.startTs,
    endTs: s.endTs,
    startEvidence: s.startEvidence,
    endEvidence: s.endEvidence
  }
}
