# Design: hover tooltips on the combat + leveling charts

Status: DESIGN ONLY — no source touched. Grounded in a read of the real components
(paths below are absolute-from-repo-root).

---

## 0. What actually exists today (read, not assumed)

Four SVG surfaces are in play. The brief calls them "two graphs"; the repo has three
that matter, and **the poison/slow markers are NOT on the timeline** — that is the
single most important finding.

| Surface | File | Hover today |
|---|---|---|
| **Combat TIMELINE** (lanes × time) | `src/renderer/src/features/combat/CombatTimeline.tsx` + `TimelineChart.tsx` | Per-element `onMouseEnter` on **every tick** and every stance span → `setHover({x,y,lines})` in the ROOT component → `HoverCard` (absolute div). No DPS readout. **No markers drawn at all.** |
| **DPS over time** (curve + markers) | `src/renderer/src/features/combat/CombatDashboard.tsx` (`DpsCurve`/`MarkerTicks`) | **Nothing on the curve.** Markers carry a native `<title>` only (`MarkerTicks`, ~line 187) — no styled tooltip, no value readout, no crosshair. |
| **Leveling: AA gained over time** | `src/renderer/src/features/leveling/levelCharts.tsx` (`AreaChart`) | None. |
| **Leveling: Level over time** | same file (`LevelStepChart`) | None. |

Key facts pulled out of the code:

- `TimelineMarker` (`src/shared/combat.ts:576`) = `{ t, kind: 'stance'|'invocation'|'coat'|'slow', label, detail? }`.
  Built in `src/main/combat/segmentViews.ts:241`. Carried on `TimelineView.markers`.
  **Never downsampled** (deliberate, documented at `src/shared/combat.ts:561-573`).
  They are rendered ONLY by `MarkerTicks` in `CombatDashboard.tsx`. The timeline
  component never reads `tl.markers`.
- `MARKER_COLOR` / `MARKER_WORD` are **module-private** to `CombatDashboard.tsx:59-70`.
  Colors are shared-by-copy with `ProcsPanel.tsx` (`POISON_COLOR`, `SLOW_COLOR`) and the
  header slots. That is a third copy waiting to drift — the `CAT_COLOR` comment in
  `combatShared.tsx:20-28` is the precedent for fixing it.
- `TimelineEvent` (`src/shared/combat.ts:534`) already carries
  `t, lane, category, amount, crit, modifiers?, kind, outcome?, detail?, target?` —
  **rich enough for a per-tick tooltip with zero lookups.** `tickTooltip()`
  (`timelineGeometry.ts:140`) already builds the three-arm text (hit / miss / resist).
- A **DPS curve already exists**: `buildDpsSeries()` (`dashboardData.ts:206`) — bucketed at
  `bucketMs = max(1000, ceil(dur/360/1000)*1000)`, smoothed with a **trailing rolling mean**
  over `smoothMs = round(5000/bucketMs)*bucketMs`, scaled by the downsample factor,
  carrying `estimated`. Its header already labels itself "Ns rolling"
  (`ChartLegend`, `CombatDashboard.tsx:262`). **This is the definition of "DPS at a point".**
- Timeline zoom/pan: `useTimelineViewport.ts` — wheel zoom (native non-passive listener),
  shift-wheel pan, **pointer drag = pan** (`onPointerDown/Move/Up`, `dragRef`,
  `setPointerCapture`). Rendering is windowed: `visibleEvents` filter in
  `CombatTimeline.tsx:115`.
- Coordinate systems differ and this bites:
  - Timeline `<svg>` uses `width`/`height` **attributes, no viewBox** → 1 user unit = 1 CSS px.
    `clientX - rect.left` is directly usable.
  - `DpsCurve`, `AreaChart`, `LevelStepChart` all use `viewBox="0 0 720 H" width="100%"
    preserveAspectRatio="none"` → **X is stretched**, Y is 1:1. Raw `clientX` maths is wrong there.
- Lint is clean for every one of these files (no `eslint.ratchet.mjs` entries — verified by grep).
  New code must land green under `complexity 12 / max-depth 3 / max-lines 400 /
  max-lines-per-function 100 / max-params 4` + `strictTypeChecked`. **Adding a ratchet entry
  is the integrator's call, never an executor's** (AGENTS.md).
- e2e (`tests/e2e/combat-dashboard.e2e.mts` + `appHarness.mts`) drives the real app with
  Playwright `page.evaluate` / `page.click`. It has `rectOf`, `countOf`, `combatText` and
  can dispatch synthetic pointer events — **synthetic hover assertions are feasible** (§9).

---

## 1. Decisions

**D1 — Hover is a CROSSHAIR + nearest-in-time hit test, not per-element handlers.**
Delete the per-tick `onMouseEnter` closures from `EventTicks`. One transparent capture
surface over the plot; a pure function resolves the cursor to an event. Reasons:
(a) the ring cap is 8k with a ~2k serialization budget — up to ~2k React elements each
re-created with a fresh arrow closure on every render; (b) a 2px-wide tick is a
sub-pixel-precision mouse target, which is the actual UX complaint; (c) it is consistent
with the existing *windowed* rendering — the same `visibleEvents` array is the hit-test
population, so hit-testing cost tracks what is drawn.

**D2 — "DPS at that point" = the chart's existing rolling series, never a new number.**
Reuse `buildDpsSeries(tl)` and sample it at the hovered time. The readout is labeled with
the series' OWN `smoothMs` (`${Math.round(series.smoothMs/1000)}s rolling`), never
"instantaneous", and wears the `~` prefix when `series.estimated`. This guarantees the
timeline's number and the curve's number can never disagree — the same law that made
`CAT_COLOR` one map. Rate text goes through `formatRate` (`lib/formatRate`), **no `/s`
anywhere** (AGENTS.md UI conventions).
Honest caveat to put in the tooltip's own wording: at deep timeline zoom the series
resolution is ≥1s buckets, so the readout is flat across a bucket. The "Ns rolling" label
already says this; do not interpolate between buckets to make it look smoother — that
would invent a rate.

**D3 — The timeline gains a MARKER RAIL; markers become one shared style source.**
The brief's "identify what an event marker is (poison/slow)" cannot be satisfied on the
timeline today because the timeline never draws markers. Add a thin marker rail to
`timelineMetrics` (sibling of the existing pin rows), drawing each `TimelineMarker` as a
full-plot-height dashed guide at low opacity + a head glyph in the rail (the `slow` pennant
from `MarkerTicks` reused verbatim). Extract `MARKER_COLOR` / `MARKER_WORD` from
`CombatDashboard.tsx` into a new `src/renderer/src/features/combat/markerStyle.ts` so the
timeline rail, the DPS-curve ticks, the header slots and `ProcsPanel`'s
`POISON_COLOR`/`SLOW_COLOR` are one source (`ProcsPanel` re-exports from it rather than
declaring hexes).

**D4 — ONE shared tooltip primitive, MUI-free.** `src/renderer/src/lib/ChartTooltip.tsx`.
MUI `Tooltip` is wrong here and the repo already says so in prose
(`CombatDashboard.tsx:171-173`: "an MUI Tooltip per tick would mount a popper for every one
of them"). It is anchor-bound, not cursor-following, and mounts a Popper + portal per
element. The existing `HoverCard` (`TimelineChart.tsx:231`) is already the right shape —
promote and generalize it. Write it with a plain `<div>` + inline styles rather than MUI
`Box`/`Typography`: emotion serializes styles on every render, and this component renders
on a mousemove path; it also keeps the door open for the **MUI-free overlay bundle** (an
overlay law in AGENTS.md) at zero cost. Colors are already hardcoded `rgba()` in `HoverCard`,
so nothing is lost.

**D5 — Hover state never lives in the chart's root component.** Today `hover` state sits in
`CombatTimelineInner`, so *every mousemove re-renders the entire tick SVG*. The new hover
state lives in a leaf `<HoverLayer>` that renders the crosshair + tooltip as an
**absolutely-positioned sibling** of the chart SVG (`pointerEvents: 'none'`), receiving
stable memoized props. The chart SVG subtree does not re-render on hover at all.

**D6 — Pure hit-test + lookup functions live in their own modules and are unit-tested.**
No DOM, no React, no MUI — so `tests/*.test.mts` can import them under tsx the way
`dashboardData.ts` already is (precedent: `tests/combatPerMobGhosts.test.mts` imports it,
which is exactly why `dashboardData.ts` spells `SLAY_LABEL` literally instead of
value-importing `@shared/combat` — **new pure modules must follow that same rule: type-only
imports from `@shared/*`, no value imports**, or the node tests break on the missing alias).

**D7 — Hit-testing happens in the TIME domain, not in two pixel spaces.** Every hit-test
function takes `(cursorMs, tolMs)` where the caller derives
`tolMs = TOL_PX * msPerCssPx`. This makes one implementation correct for both the 1:1
timeline SVG and the `preserveAspectRatio="none"` stretched charts, and makes the tests
pure arithmetic with no viewport.

**D8 — Hover binds `pointermove` ONLY, and bails when any button is down.** See §7. This
is the seam that lets timeline drag-pan and the (separately designed) leveling drag-select
coexist with hover without either owner editing the other's file.

---

## 2. Shared primitives (library-first)

### 2.1 `src/renderer/src/lib/ChartTooltip.tsx` (new)

```ts
export interface TooltipRow {
  label?: string          // dim, left
  value: string           // bright, right (or the whole line when label is absent)
  color?: string          // value tint (category color, RESIST_COLOR, marker color)
}
export interface ChartTooltipModel {
  /** cursor position in CSS px, relative to the tooltip's positioned ancestor. */
  x: number
  y: number
  title: string
  /** optional dim second-rank line under the title (e.g. "You · 1:04"). */
  subtitle?: string
  rows: TooltipRow[]
  /** honesty footer, rendered dim + italic ("5s rolling · ~ estimated"). */
  note?: string
  /** clamp box: the plot's width/height in CSS px, for edge flipping. */
  bounds: { w: number; h: number }
}
export function ChartTooltip(m: ChartTooltipModel): React.JSX.Element
```

Behaviour: `position:absolute`, `pointerEvents:'none'`, `zIndex:5`, offset `+10/+12` from
the cursor, **flips to the left of the cursor** when `x + width > bounds.w` and **above**
when `y + height > bounds.h` (the current `HoverCard` only clamps X with a hardcoded 170px
guess — replace that with a measured flip via a `ref` + `getBoundingClientRect`, measured
once per content change, not per move). Max width 280, `whiteSpace: nowrap` per row.

`HoverCard` in `TimelineChart.tsx` is **deleted** and its callers moved onto this.

### 2.2 `src/renderer/src/lib/rafThrottle.ts` (new)

```ts
/** Coalesce calls to at most one per animation frame; last args win. */
export function rafThrottle<A extends unknown[]>(fn: (...a: A) => void): ((...a: A) => void) & { cancel(): void }
```

Pure enough to unit-test with a stubbed `globalThis.requestAnimationFrame`. Used by every
hover layer's `pointermove`. Paired with a `useEffect` cleanup that calls `.cancel()`.

### 2.3 `src/renderer/src/features/combat/timelineHitTest.ts` (new, pure)

```ts
import type { TimelineEvent, TimelineMarker } from '@shared/combat'   // TYPE-ONLY (D6)

export interface Pick<T> { item: T; index: number; dtMs: number }

/** Nearest event in `lane` (already resolved from Y) within ±tolMs. Events are in
 *  ascending `t` (ring append order) → binary search + local scan, O(log n + k). */
export function pickEventInLane(
  events: readonly TimelineEvent[], laneName: string, cursorMs: number, tolMs: number
): Pick<TimelineEvent> | null

/** Nearest marker within ±tolMs, lane-independent (the rail spans all lanes). */
export function pickMarker(
  markers: readonly TimelineMarker[], cursorMs: number, tolMs: number
): Pick<TimelineMarker> | null

/** Y (px, relative to the lane block top) → lane index, or null outside the block. */
export function laneAt(y: number, laneH: number, laneCount: number): number | null
```

Tie-breaks, spelled out so tests can pin them: smallest `|dt|`; on an exact tie prefer the
**landed** event over a miss/resist (a solid tick is what the eye is on), then the larger
`amount`, then the earlier index. Never returns an event whose `|dt| > tolMs`.

### 2.4 `src/renderer/src/features/combat/dpsAt.ts` (new, pure)

```ts
import type { DpsSeries } from './dashboardData'   // type-only

export interface DpsPoint { you: number; pet: number; inc: number; out: number }
/** Sample the rolling series at `tMs` (clamped to the series). NO interpolation — the
 *  series is bucketed and the label says so (D2). */
export function dpsAt(series: DpsSeries, tMs: number): DpsPoint
/** The honesty note both charts print: "5s rolling" / "~ 5s rolling (sampled ring)". */
export function rollingNote(series: DpsSeries): string
```

### 2.5 `src/renderer/src/features/leveling/levelChartGeometry.ts` (new, pure)

Extracted from the two chart components so the **hover layer and the future drag-select
share one mapping** (this is the explicit seam — see §7.2):

```ts
export const CHART_W = 720
export interface ChartScale { t0: number; t1: number; w: number; padX: number }
export function xOf(s: ChartScale, ts: number): number     // ts → user units
export function tOf(s: ChartScale, ux: number): number     // user units → ts
/** CSS px → user units for a preserveAspectRatio="none" chart. */
export function pxToUser(cssX: number, rectW: number, w = CHART_W): number

/** The level in effect at `ts`, honestly (see §6.2). */
export type LevelAt =
  | { kind: 'level'; level: number; sinceTs: number; nextTs: number | null }
  | { kind: 'swap-gap'; beforeLevel: number; afterLevel: number; gapMs: number }
  | { kind: 'before-first' }
export function levelAt(segments: readonly LevelSegment[], ts: number): LevelAt

/** Cumulative AA gained at `ts` (step lookup over the same points AreaChart plots). */
export function cumulativeAt(points: readonly { ts: number; y: number }[], ts: number): number | null
```

`AreaChart` and `LevelStepChart` then compute their scale via this module instead of
inline constants — behavior-identical, and the hover layer cannot drift from the drawing.

---

## 3. Chart 1 — Combat TIMELINE hover

### 3.1 Structure

```
<Box ref={wrapRef} position:relative>            ← already exists
  <svg ref={svgRef} …>   … lanes, ticks, marker rail, axis …   ← MEMOIZED, never re-renders on hover
  <TimelineHoverLayer                             ← NEW leaf; owns ALL hover state
     events={visibleEvents} markers={tl.markers} lanes={tl.lanes}
     m={m} view={vp.view} span={vp.span} series={dpsSeries} startTs={tl.startTs} />
</Box>
```

`TimelineHoverLayer` renders:
1. a full-height absolutely-positioned `<svg pointerEvents:none>` holding the **crosshair**
   (1px vertical rule at the cursor, `rgba(255,255,255,0.18)`) and, when an event is picked,
   a **highlight ring** around that tick (2px stroke in the tick's category color) — the
   confirmation that the tooltip is describing *that* mark, which nearest-in-time hit-testing
   otherwise lacks;
2. `<ChartTooltip …>`.

The capture surface is the layer's own root `div` (`position:absolute; inset:0;
pointerEvents:'auto'` — it must not swallow the SVG's wheel/pointer handlers, so it is a
**sibling that forwards**: bind `onPointerMove`/`onPointerLeave` on the layer, and let
wheel/drag stay on the `<svg>` beneath by giving the layer `pointerEvents:'none'` and
binding the move listener on the **wrapper Box** instead). Concretely: the wrapper `Box`
gets `onPointerMove`/`onPointerLeave`; the layer is pure output. This keeps
`useTimelineViewport`'s wheel/drag handlers exactly where they are — **zero changes to
`useTimelineViewport.ts`**.

### 3.2 Hit test per move

```
px  = ev.clientX - rect.left - m.labelW           // 0 outside the gutter ⇒ ignore if < 0
py  = ev.clientY - rect.top  - m.laneTop
cursorMs = view.start + (px / m.plotW) * span
msPerPx  = span / m.plotW
markerHit = pickMarker(markers, cursorMs, MARKER_TOL_PX * msPerPx)      // MARKER_TOL_PX = 5
lane      = laneAt(py, m.laneH, lanes.length)
eventHit  = lane != null ? pickEventInLane(visibleEvents, lanes[lane].lane, cursorMs, TICK_TOL_PX * msPerPx) : null
```

Priority: **cursor in the marker rail → marker wins**; cursor in the lane block → event wins,
marker only as a secondary row when it is within `MARKER_TOL_PX` (so hovering a tick that sits
on a coat guide tells you both). `TICK_TOL_PX = 6`.

Result is stored as `{ evIndex, mkIndex, x, y }`; **if the indices are unchanged and the
cursor moved <2px, no `setState` is issued** (§8).

### 3.3 Tooltip content per kind

Text builders extend `timelineGeometry.ts`'s existing `tickTooltip` family (keep those
functions, change their return type from `string[]` to the structured
`{title, subtitle, rows, note}`; `tickTooltip` currently has exactly one consumer).

| Kind | Title | Rows | Note |
|---|---|---|---|
| **Damage tick** | `Backstab · CRIT` | `1.4k` (category color) · `→ a zol ghoul knight` · `Riposte` (modifiers) · `You · 1:04.3` | rolling-DPS row (below) |
| **Miss / avoided** | `Melee — PARRY` (from `e.detail`) | `You vs <target>` · `1:04.3` · `no damage — an avoided swing` | — |
| **Resist** | `Mez III — RESISTED` | `<target> resisted your spell` · `1:04.3` · `no damage — a fully-resisted cast` | — |
| **Coat marker** | `Neurotoxic — blade coat` | `applied 1:04.3` · `e.detail` when present | — |
| **Slow marker** | `<mob> — slow landed` | `1:04.3` · `e.detail` | `the outcome this tab exists to show` (already the chart's framing) |
| **Stance / invocation marker** | `Berserker — stance` | `committed 1:04.3` | — |
| **Stance/invocation SPAN** (pinned rows, existing hover) | `stance: Berserker` | `1:02 – 3:41` · `2:39 active` | — |
| **Empty space (no hit)** | `1:04.3` (+ wall clock, §10) | **rolling DPS rows only** | `Ns rolling` |

Every tooltip that has a time also carries the **rolling-DPS block** — that is the brief's
"DPS at that point":

```
you + pet   12.4k dps          (OUT_COLOR)
pet          3.1k dps          (only when series.hasPet)
incoming     0.9k dps          (only when series.hasInc)
—— 5s rolling · ~ estimated ——     (note; `~` only when series.estimated)
```

`buildDpsSeries(tl)` is memoized on `tl` identity inside `CombatTimeline` (`useStableTimeline`
in `CombatView.tsx` already stabilizes that identity across snapshot ticks, so a finalized
fight recomputes zero times).

### 3.4 Encounter boundaries

The timeline is scoped to ONE encounter, so there are no internal boundaries to hit-test.
What the tooltip should say instead, at the extremes: `t ≤ 0` → `fight start`; `t ≥
durationMs` → `fight end`. If the ring is **truncated** (`tl.truncated`), the tooltip's note
must add `earliest retained instant` at the left edge — the fight's real opening is not in
the ring and the chart must not imply otherwise (world-model law 8 / the `ApproxChip` wording).

---

## 4. Chart 2 — DPS-over-time curve hover (`CombatDashboard.tsx`)

This is where the markers actually live and where a DPS readout is most natural. Same
primitives, smaller surface.

- Wrap the existing `<Box position:relative>` (already there, `DpsCurve`) with
  `onPointerMove`/`onPointerLeave`.
- Convert cursor: `ux = pxToUser(ev.clientX - rect.left, rect.width)` then
  `tMs = chart.startMs + ((ux - PAD_X) / (CHART_W - 2*PAD_X)) * (chart.endMs - chart.startMs)`.
  Add that inverse to `dpsChart.ts` as `tAtUserX(chart, ux)` (pure, testable) — the forward
  `x()` there is a local closure, so the inverse must be written, not extracted.
- Hit test: `pickMarker(placedMarkers-by-time, tMs, MARKER_TOL_PX * msPerUser)` — reuse
  `pickMarker` from `timelineHitTest.ts` (it takes plain `TimelineMarker[]`, no timeline
  coupling). **Delete the `<title>` elements** from `MarkerTicks` once the real tooltip
  lands — two tooltips for one mark is worse than one.
- Always show the rolling-DPS block at the cursor time via `dpsAt(series, tMs)` + a
  crosshair + a dot on the outgoing polyline at that x.
- Marker hit ⇒ the marker block is the tooltip's **title**, DPS rows drop to secondary.

The curve's existing legend already names the marker kinds present; hover is what turns
"a violet dashed line" into "3: Neurotoxic, applied at 1:04".

---

## 5. (Deliberately not designed) — leveling drag-select

A separate planning agent owns drag-select range statistics on the leveling chart (zone
overlays, per-range stats). Nothing below designs it. §7.2 defines the seam it needs.

---

## 6. Chart 3 — LEVELING hover

### 6.1 Structure

Both `AreaChart` and `LevelStepChart` currently return a bare `<svg>`. Wrap each in
`<Box position:relative>` inside `levelCharts.tsx` and mount a shared
`<LevelHoverLayer>` (new, in `levelCharts.tsx` or a sibling `LevelHoverLayer.tsx` if the
file approaches the 400-line cap — it is at ~123 code lines, so in-file is fine).

Props: `{ scale, segments?, points?, aaPoints, suppressed?: boolean }`.
`suppressed` is the drag-select seam (§7.2) and ships **from wave 1**, defaulted `false`,
so the other agent never has to edit this file to disable hover mid-drag.

### 6.2 Content — and the honesty rule that shapes it

**Level over time**, at cursor time `ts`:

| `levelAt()` result | Title | Rows |
|---|---|---|
| `level` | `Level 47` | `since <formatDateTime(sinceTs)>` · `held 3.2h` (or `current level` when `nextTs === null`) · `AA gained by then: 214` |
| `swap-gap` | `Between loadouts` | `last reported 50 · next reported 11` · `the class swap is not logged — the level here is unknown` |
| `before-first` | *(no tooltip)* | — |

The `swap-gap` arm is required by world-model law 1/6 and by `levelSeries.ts`'s own
existing precedent: `levelFeedEntries` already **suppresses** `sinceMs` across a swap because
"`+38.9h` there would be a fabricated 'time to level'". A hover that read "Level 50" halfway
through that gap would be exactly the fabrication that file refuses to make. The chart
already draws the segments **disjoint** for the same reason — the tooltip must agree with
the drawing.

**AA gained over time**, at cursor time `ts`:

- Title: `214 AA gained` (cumulative), sub: `<formatDateTime(ts)>`.
- Row: the nearest gain event within tolerance → `+4 AA · 37 unspent at the time`.
- Note (mandatory): `cumulative gain lines — includes points re-gained after a respec`.
  The panel caption already says this (`AaOverTimePanel`); the tooltip repeats it because a
  hover readout is read in isolation, and calling this "earned" would contradict
  `computeAAAccounting` (world-model law 5).

All timestamps go through `lib/formatDate` (`formatDateTime`) — never `toISOString`, never
epoch-day math (AGENTS.md UI conventions, and `formatDate.ts`'s own header).

---

## 7. The drag / hover seam (explicit — do not let this rot)

### 7.1 Combat timeline (drag = pan, exists today)

Rule: **the hover handler is bound to `pointermove` only, and returns immediately when
`ev.buttons !== 0`**, clearing any live hover on the first such event. `PointerEvent.buttons`
is 0 for a bare move and non-zero throughout a drag (including after `setPointerCapture`),
so this needs **no change to `useTimelineViewport.ts`** and no shared "isDragging" state —
which is the point: the two interactions stay in files owned by different agents.

Also: `onPointerLeave` clears hover; `onPointerUp` does not re-show it (the next real move
does). Cursor stays `grab` from the viewport's own style.

### 7.2 Leveling chart (drag-select = future, another agent)

Three commitments made now so the future feature is additive:

1. **Hover binds `pointermove` / `pointerleave` only.** It never binds `pointerdown`,
   `pointerup`, or `pointercancel`. Those are free for the drag-select owner.
2. **Same bail-on-`ev.buttons !== 0`.** A drag in progress therefore suppresses hover for
   free even if the other agent forgets to wire `suppressed`.
3. **`suppressed?: boolean` prop exists from day one** on `LevelHoverLayer`, and the shared
   `levelChartGeometry.ts` exports `xOf`/`tOf`/`pxToUser` **publicly** so the range-select
   uses the identical mapping instead of re-deriving `padX`/`W` from the drawing code.
   A range overlay must render *under* the hover layer; reserve `zIndex` 1 (range),
   2 (crosshair), 3 (tooltip).

Open coordination note for the integrator: if the drag-select design wants a *combined*
"hover shows the range you'd get" affordance, that belongs in their file consuming our
`levelAt`, not in ours.

---

## 8. Perf constraints (no re-render storms)

Non-negotiables for the executors:

1. **Hover state lives in a leaf.** Chart SVG subtrees are `memo`ized and receive no
   hover-derived props. Verifiable: `EventTicks` must not re-render on mousemove (drop a
   temporary `console.count` while developing; remove before commit).
2. **rAF coalescing.** Every `pointermove` goes through `rafThrottle`. A 1000Hz mouse must
   still produce ≤1 state update per frame.
3. **Change-gated `setState`.** Store `{evIndex, mkIndex, xPx, yPx}`; skip the update when
   the indices are identical **and** `|Δx| < 2 && |Δy| < 2`. Most moves inside one tick's
   tolerance therefore cost zero React work.
4. **No allocation in the hot path.** Hit-test functions return an existing object reference
   (`{item, index, dtMs}` is one small object per *accepted* pick, not per move); tooltip
   text is built in a `useMemo` keyed on the indices, not per move.
5. **Binary search, not `.filter`.** `pickEventInLane` binary-searches the ascending `t`
   array and scans outward while `|dt| <= tolMs`. `visibleEvents` is already time-windowed,
   so the scan is over ticks that are literally on screen.
6. **No emotion on the move path.** `ChartTooltip` is plain `div` + inline style objects
   hoisted to module constants where static (D4).
7. **No new timers, no `setInterval`.** The DPS curve's live window already advances on the
   existing snapshot cadence (`CombatDashboard.tsx` header comment) — hover must not add a
   clock.
8. **Memo keys.** `buildDpsSeries` memoized on `tl` identity; `laneIndex` already is; the
   marker array is `tl.markers` (stable per snapshot).

---

## 9. Data-shape additions

**Almost none — the payloads are already rich.**

| Need | Verdict |
|---|---|
| Describe a damage/miss/resist tick | `TimelineEvent` already carries lane, category, amount, crit, modifiers, kind, outcome, detail, target. **No change.** |
| Describe a coat/slow/stance marker | `TimelineMarker` already carries kind, label, detail. **No change.** |
| DPS at a point | Derived renderer-side from the existing `buildDpsSeries`. **No change.** |
| Wall-clock time in the timeline tooltip | **ONE additive field**: `TimelineView.startTs: number`. `src/main/combat/segmentViews.ts:213` already has `const start = e.startTs` — add `startTs: start` to the returned object and the field to `src/shared/combat.ts` `TimelineView`. Not persisted ⇒ **no store migration**. `SegmentView` has no `startTs` (only `SegmentSummary` does), so the alternative — threading it from `CombatView` — would mean plumbing through three components for a display detail; the view should describe itself. |
| Leveling | `LevelEvent`/`AASpendEvent`/gain events already carry `ts`, `level`, `amount`, `nowHave`. **No change.** |

If the integrator prefers zero `src/main` + `src/shared` churn in wave 1, drop the wall-clock
row: elapsed-only tooltips are complete without it. Marked optional in the wave plan.

---

## 10. Compliance checklist (the laws this must not break)

- **Rates**: `formatRate` only, `21.7k dps` shape, no `/s` anywhere.
- **Totals**: `formatNum`, no unit word.
- **Dates/times**: `lib/formatDate` (`formatDateTime`/`formatTime`), user-local.
- **Elapsed** inside a fight: existing `fmtDur`/`fmtClock` (`timelineGeometry.ts`) and
  `fmtElapsed` (`copyText.ts`) — do not add a fourth elapsed formatter.
- **State, never process** (AGENTS.md UI conventions): tooltips state facts. No "computed
  from a 5s rolling window over the sampled ring" prose — the compact note `5s rolling` +
  the `~` marker is the established vocabulary (`ApproxChip`, `ChartLegend`).
- **`~` discipline**: any number derived from a downsampled/truncated ring wears `~`;
  observed maxima/minima never get scaled. The DPS rows are scaled estimates ⇒ they wear it
  when `series.estimated`. A single tick's `amount` is an **observation**, not an estimate ⇒
  it never wears `~`.
- **Miss/resist are damage-free**: their tooltips must not print an amount, and must say so
  in words (they carry `amount: 0`, and a bare `0` would read as "hit for zero").
- **Colors**: one source. `CAT_COLOR`/`RESIST_COLOR` from `combatShared.tsx`; marker hues
  from the new `markerStyle.ts` (D3). No new hex literals in a hover file.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Removing per-tick `onMouseEnter` regresses hover fidelity (nearest-in-time can pick a neighbour). | The highlight ring (§3.1) makes the pick visible; `TICK_TOL_PX = 6` with lane restriction; unit tests pin the tie-break order. |
| The marker rail changes `timelineMetrics.laneTop`, shifting lane geometry. | Rail height is 0 when `tl.markers` is empty (same conditional pattern `pinRows` already uses). Timeline isn't covered by `checkGrid`, so e2e layout risk is low — but re-run `test:e2e` anyway. |
| `max-lines` (400) on `CombatDashboard.tsx` / `TimelineChart.tsx`. | Both are near the ceiling. New code goes into NEW files (`markerStyle.ts`, `timelineHitTest.ts`, `dpsAt.ts`, `ChartTooltip.tsx`); extracting `MARKER_COLOR`/`MARKER_WORD` out of `CombatDashboard.tsx` buys headroom. **Executors may not add ratchet entries.** |
| `pointerEvents` layering swallows the wheel-zoom listener (native, non-passive, on the `<svg>`). | Hover listeners go on the **wrapper Box**, hover layer is `pointerEvents:'none'`. Verify wheel-zoom + drag-pan by hand after the change; the e2e can assert a wheel still changes the toolbar's visible-window text. |
| Tooltip flicker at high pointer rates. | rAF + change-gating (§8.3); tolerance hysteresis is implicit because the picked index only changes when the cursor genuinely leaves the tick's ±6px. |
| A `swap-gap` hover that guesses a level. | `levelAt` returns a discriminated union; the `swap-gap` arm has no `level` field at all, so a component **cannot** render one (TS enforces the honesty). |
| Type-only-import rule for node tests. | D6. Any `@shared/combat` value import in a new pure module breaks `npm test` (no renderer alias). Enforce in review. |

---

## 12. Wave plan

Two waves, two agents each, **disjoint file ownership**. Each agent writes its own
`tests/*.test.mts` (distinct filenames ⇒ no collision).

### Wave 1 — shared primitives + the two hover surfaces that don't touch `CombatDashboard.tsx`

**Agent 1A — shared tooltip + combat timeline hover**
Owns (new): `src/renderer/src/lib/ChartTooltip.tsx`, `src/renderer/src/lib/rafThrottle.ts`,
`src/renderer/src/features/combat/timelineHitTest.ts`,
`src/renderer/src/features/combat/dpsAt.ts`,
`src/renderer/src/features/combat/markerStyle.ts`, `tests/timelineHitTest.test.mts`.
Owns (edit): `CombatTimeline.tsx`, `TimelineChart.tsx`, `timelineGeometry.ts`,
`ProcsPanel.tsx` (re-export the two hues from `markerStyle.ts`), and the **import-line-only**
edit in `CombatDashboard.tsx` that deletes `MARKER_COLOR`/`MARKER_WORD` and imports them.
Optional (integrator's call): `src/shared/combat.ts` + `src/main/combat/segmentViews.ts`
`startTs` addition (§9).
Does NOT touch: anything under `features/leveling`, the rest of `CombatDashboard.tsx`.

**Agent 1B — leveling hover**
Owns (new): `src/renderer/src/features/leveling/levelChartGeometry.ts`,
`tests/levelHover.test.mts`.
Owns (edit): `levelCharts.tsx`, `LevelingView.tsx` (pass `aaPoints` to the level chart).
Depends on `ChartTooltip` + `rafThrottle` from 1A → **1B must be briefed with the exact
`ChartTooltip` prop contract from §2.1 and stub nothing**; if the two run truly in parallel,
have 1A create both lib files FIRST (AGENTS.md: create any file you import before writing the
import — keep the tree buildable).

Gate: `npm run typecheck` · `npm run lint` (ratchet must not grow — `EQ_LINT_NO_RATCHET=1 npx
eslint .` for the true state) · `npm test`. Commit.

### Wave 2 — the DPS curve + proof

**Agent 2A — DPS-over-time curve hover**
Owns (edit): `CombatDashboard.tsx` (hover layer, delete `MarkerTicks`' `<title>`),
`dpsChart.ts` (add `tAtUserX`). Owns (new): `tests/dpsChartHover.test.mts`.
Reuses 1A's `pickMarker` / `dpsAt` / `ChartTooltip` untouched.

**Agent 2B — e2e hover assertions**
Owns: `tests/e2e/appHarness.mts`, `tests/e2e/combat-dashboard.e2e.mts` only.
New helper in the harness:

```ts
export async function hoverAt(page: Page, sel: string, fx: number, fy: number): Promise<void>
// resolve the element rect, then page.mouse.move(x, y) — a REAL pointer move, so
// ev.buttons === 0 and the bail-out in §7 is exercised as the user exercises it.
export function tooltipText(page: Page): Promise<string>   // [data-testid="chart-tooltip"]
```

Assertions (identities, never today's numbers — AGENTS.md "frozen numbers rot"):
1. In Timeline view, moving the mouse into the plot renders exactly one
   `[data-testid="chart-tooltip"]`; moving out removes it.
2. That tooltip's text **matches `/\d+(\.\d+)?[kM]? dps/`** and contains `rolling`.
3. Hovering the plot with the **button held** (`page.mouse.down()` → `move` → `up`) renders
   **zero** tooltips — the drag/hover seam, asserted rather than assumed.
4. On the Dashboard's DPS card, a hover produces a tooltip (marker presence is
   log-dependent ⇒ if `tl.markers` is empty in the live log, `note()` it rather than fail —
   same convention as the existing quiet-log steps).
5. `no renderer console errors` (the existing final check) still passes.

Gate: `npm run typecheck` · `npm run lint` · `npm test` · `npm run test:e2e`. Commit.

### Out of scope (state plainly, do not drift into)

Drag-select range statistics on the leveling chart (owned by a separate planning agent);
any change to the game log; any change to the engine's aggregates; touching the overlay
bundle.
