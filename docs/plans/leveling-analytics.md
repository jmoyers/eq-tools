# Leveling analytics — zone bands, drag-select range stats

Design doc. Library-first: one new parser event, one new main-side module, one PURE
range-stats function in `src/shared`, and a renderer interaction layer. Nothing here is
implemented yet.

Grounded in a read-only sweep of the real log
(`C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest Legends\Logs\eqlog_Primitive_freeport.txt`,
1,108,684 lines, 90 MB, 2026-08-03 14:27) and the current source.

---

## 0. Headline finding: the log DOES carry granular experience

The brief assumed exp might only be level-ups + AA points. It is not. **`You gain
experience!` lines carry a level-bar percentage**, and they are an INCREMENT, not a
cumulative bar position.

Full-log line-shape sweep (`grep -i experience | strip ts | digits→N | sort | uniq -c`):

| shape | count |
|---|---|
| `You gain experience! (N.N%)` | 3841 |
| `You gain experience!` (no percent) | 474 |
| `You gain party experience! (N.N%)` | 471 |
| `You gain party experience!` (no percent) | 28 |

The only other lines containing "experience" are player chat and one mob emote
(`Coercer T\`vala experiences a quickening.`) — both must be rejected by anchoring the
regex at start-of-text.

**Increment, proven.** Summing the percentages between consecutive `Welcome to level N!`
lines lands on ~100% every time:

| level span | exp lines between | Σ percent |
|---|---|---|
| 40 → 41 | 47 | 98.785 |
| 39 → 40 | 41 | 100.176 |
| 38 → 39 | 58 | 100.466 |
| 36 → 37 | 46 | 102.050 |

Whole-log post-epoch cross-check: Σ percent = 8279.7 (= **82.8 level-equivalents**) against
**81** observed `Welcome to level N!` lines in the same span. The residual is 3-decimal
rounding per line plus the percent-less window below. This is a real, honest measure of
experience — not an inference.

**The percent-less lines are the level cap.** All 502 post-epoch percent-less lines fall in
one contiguous window, Fri Jul 31 17:51:24 → Sat Aug 01 23:53:55. The character hit
`Welcome to level 50!` at Fri Jul 31 16:19:04 and did not ding again until
`Welcome to level 11!` (post-loadout-swap) on Sun Aug 02 02:13:34. So the window is exactly
"at the cap", where there is no level bar to report progress against — and 22 AA gains land
inside it. **The game prints a percentage only when a level bar exists.** Model this as
`pct: undefined`, never as `0`, and label it in the UI (law 1). Do NOT assert in UI copy
that the exp "went to AA" — say the percentage was not stated, and that in this log that has
only ever happened at cap.

**Ordering at a ding**: the level line comes FIRST, then the exp line carrying the overflow
into the new level (verified at `Mon Aug 03 00:40:46` — `Welcome to level 41!` then
`You gain experience! (3.867%)`). No double counting; no special case needed.

**Nothing parses these lines today.** `grep -rn "experience" src/` returns exactly one hit,
an unrelated comment in `src/shared/types.ts:254`. Every exp line currently falls through to
`{ kind: 'unknown' }`.

### Unit honesty (law 1 label)

1% at level 40 is far more raw experience than 1% at level 10. Σ percent is therefore
**"levels of progress"**, not "experience points". Every surface must say `levels`, never
`xp` or `exp points`. The log never states a raw exp number, an exp-to-next-level total, or a
current bar position — only per-kill deltas. Say so.

---

## 1. Kill credit: what the log actually attributes to you

Kill credit already exists but is **not** range-queryable and **not** attributed to you.

- `src/main/log/parseWorld.ts` emits `death` from two shapes: `SLAIN_SELF_RE`
  (`You have slain X!`) → `bySelf:true`, and `SLAIN_BY_RE` (`X has been slain by Y!`) →
  `bySelf:false, killer:Y`.
- `src/main/log/reducers.ts` `isCountedKill` drops only `killer` starting with `you`
  (de-dupe against the self shape). **Everything else is counted** — including other
  players' and other mobs' kills.
- `src/main/modules/kills.ts` folds these into a `KillMap` keyed by mob name with
  `{count, bestTier, firstTs, lastTs}`. **Per-kill timestamps do not survive** — only first
  and last. A range query is impossible against this shape.

Post-epoch (≥ 2026-07-28 00:00 local) breakdown, measured:

| credit | count |
|---|---|
| `You have slain X!` (your killing blow) | 2999 |
| `X has been slain by <bound pet>` | 1111 |
| `X has been slain by <someone else>` | **954** |

"Bound pet" = a name learned from the pet-claim tell (`<Name> told you, '… Master.'`) or a
`has been charmed.` line — 88 distinct names over the log. Top non-pet killers are other
players (`Dranix` 188, `Kaner` 64, `Jenann` 40) and mobs killing other mobs.

**Validation**: self + bound-pet = **4110** credited kills against **4157** exp lines in the
same span — a 98.9% match. Third-party kills (954) are correctly excluded by that definition.
The residual is group-mate killing blows that still paid you party exp (499 party lines) minus
grey kills that paid nothing; state it as a strong correlation, never as an identity.

**Decision**: `RangeStats.kills` counts **credited kills only** = `bySelf` + bound-pet.
Report the two sub-counts separately (`killsSelf`, `killsPet`) with the pet half chipped
`inferred` (pet binding is learned from tells, not stated per kill). Expose
`killsWitnessed` (the third-party count) as a separate, dimmer number so a busy zone does
not silently inflate your farming rate. The existing `KillMap` is untouched — its "kills seen
in the world" semantics are correct for its own use (boss tiers, loot sourcing).

---

## 2. Zone intervals

`ZONE_RE = /^You have entered (.+?)\.$/` with `PSEUDO_ZONE_RE = /^an area where /i` rejected
(`parseWorld.ts:63-78`). 382 zone lines whole-log, **344 post-epoch**, over 6.1 days.

Zone intervals are cheap and already fully derivable: interval `i` runs
`[zoneLine[i].ts, zoneLine[i+1].ts)`, with the last interval open. Measured dwell for the
344 post-epoch intervals: top zones are `Nagafen's Lair` 14.8h, `The Plane of Hate` 14.3h,
`The Ruins of Old Guk` 13.1h, `The Ruins of Old Paineel` 12.8h, `Befallen` 12.7h.

**81 of the 344 intervals are shorter than 60 s** — zone-line bounces, instance re-entries
(the `(Awakened|Adaptive|Fused|Refined)` tier suffix and `- Solo/Group N` noise are stripped
by `zoneTier`). Rendering those as bands would be sub-pixel. See §6.2 for the merge rule.

The `character` module already tracks a *current* zone (`CharacterSnap.zone`) but keeps no
history. The combat engine's `zoneSessions` (world-model law 7) is capped at 20 finalized
sessions and carries combat aggregates, not a queryable timeline — not reusable here.

---

## 3. Data model

### 3.1 New parser event

`src/shared/logEvents.ts`:

```ts
/**
 * `You gain experience! (3.288%)` / `You gain party experience! (1.373%)`, and the
 * percent-LESS variants of both. The percentage is an INCREMENT of the CURRENT level's
 * bar (proven: Σ between consecutive dings ≈ 100), never a bar position.
 *
 * `pct` is UNDEFINED when the line stated none — never 0. In the real log every
 * percent-less line falls inside one contiguous at-the-cap window (level 50, no ding
 * for 34 h), i.e. the game prints a percentage only while a level bar exists.
 */
export interface ExpGainEvent extends LogEventBase {
  kind: 'expGain'
  /** stated level-bar percent gained; undefined when the line printed none. */
  pct?: number
  /** the `party experience` shape — a group-mate's kill paid you. */
  party: boolean
}
```

Added to the `LogEvent` union. Classifier `classifyExp` in `parseWorld.ts` (beside
`classifyLevel`), registered in the `CLASSIFIERS` array in `parser.ts:100-118`. Anchor the
regex: `/^You gain (party )?experience!(?: \(([\d.]+)%\))?$/` — start-anchored and
end-anchored so the 12 chat lines containing "experience" can never match.

### 3.2 New module: `progression`

**Recommendation: a NEW module, not an extension of `LevelingModule`.** Rationale:

1. **Different cap policy.** `LevelingSnap` is deliberately uncapped — 81 levels + 139 AA
   gains + ~175 spends over 6 days is ~5k rows/year and the AA identity (law 5) needs the
   whole history. The analytics series grows at ~1400 rows/day and MUST be capped. Mixing a
   drop-oldest ring into a snapshot whose contract is "everything, forever" is a semantic
   trap.
2. **Disjoint file ownership.** `leveling.ts` and `levelSeries.ts` stay byte-untouched, so
   the swap-series golden tests (`tests/levelingSwapWindows.test.mts`) are an unmodified
   regression gate.
3. The module transport already supports N modules per view; `LevelingView` simply calls
   `useModule` twice (both re-hydrate on `onCharacter`).

The `progression` module folds `expGain`, `death`, `zone`, `level`, `aaGain`, `petClaim`,
`charm`, `uncharm`, `loot`, `epoch`. It duplicates the tiny `level`/`aaGain` series so
`rangeStats` has ONE input (see §4) — ~220 rows over 6 days, negligible, and it does not
duplicate any *derivation* (the AA identity stays in `shared/aa.ts`).

### 3.3 Snapshot shape — COLUMNAR

`src/shared/types.ts`:

```ts
/** Parallel-array time series. COLUMNAR on purpose: structured-clone of N number arrays
 *  is dramatically cheaper than N row objects, and the range query is a binary search on
 *  a sorted `ts` column. Every array of a group has identical length; all `*Ts` columns
 *  are ascending (log order is time order — the feeder is a single seq stream). */
export interface ProgressionSnap {
  // --- experience samples ---
  expTs: number[]
  /** stated level-bar percent, or -1 when the line printed none (see expFlag bit 1). */
  expPct: number[]
  /** bitfield: 1 = no percentage stated, 2 = party experience. */
  expFlag: number[]

  // --- credited kills (yours + bound pet); third-party kills are NOT here ---
  killTs: number[]
  /** index into zoneName, or -1 before the first zone line. */
  killZone: number[]
  /** 0 = your killing blow, 1 = credited to a bound pet (INFERRED — pet binding is
   *  learned from `<Name> told you, '… Master.'` / charm lines, not stated per kill). */
  killCredit: number[]

  /** third-party kills seen in the world, timestamps only (for the dimmed context number). */
  witnessTs: number[]

  // --- loot events, timestamps only: an activity signal for the idle heuristic ---
  lootTs: number[]

  // --- zone intervals, ascending, contiguous, half-open [start, end) ---
  zoneStart: number[]
  /** 0 for the still-open final interval; consumers clamp to `lastTs`. */
  zoneEnd: number[]
  /** RAW display name (law 2: canonicalize at boundaries, display raw). */
  zoneName: string[]

  // --- tiny uncapped series, mirrored so rangeStats has one input ---
  levelTs: number[]
  levelValue: number[]
  aaGainTs: number[]
  aaGainAmount: number[]

  /** last event ts folded (clamps the open zone interval and an open selection). */
  lastTs: number
  /** RETENTION: oldest ts still represented. Samples before it were dropped by the cap. */
  windowStart: number
  /** how many samples the cap has dropped (0 until the cap bites). */
  dropped: number
}
```

Delta: the same shape with only the appended slices plus the updated `zoneEnd` of the
previously-open interval; the renderer concats each column. `windowStart`/`dropped`/`lastTs`
are replace-not-concat scalars. Because the cap drops from the FRONT, a delta must also carry
`dropFront: number` (how many leading entries the renderer should splice off each capped
column) so the two sides stay in step without re-sending everything.

### 3.4 Memory bound and cap strategy

Measured post-epoch rates over 6.1 days: 4157 exp + 4110 credited + 954 witnessed + 649 loot
+ 344 zone + 81 level + 139 AA ≈ **10.4k rows / 6.1 days ≈ 1.7k rows/day**. A year of the
same play is ~620k rows. Uncapped that is tens of MB over IPC — unacceptable.

**Cap (precedent: combat's 8k event ring / 20 zone sessions / <1 MB payload):**

- `EXP_CAP = 40_000`, `KILL_CAP = 40_000`, `WITNESS_CAP = 20_000`, `LOOT_CAP = 20_000`,
  each drop-oldest independently.
- `ZONE_CAP = 4_000` intervals (≈ 70 days at the observed rate) — zone bands are the
  cheapest and most valuable column; keep it generous.
- `levelTs` / `aaGainTs` are **uncapped** (≈ 5k rows/year; the chart needs every ding).

At the caps, the columnar payload is ~124k numbers + ~4k short strings ≈ **1.2 MB**
structured-clone — in line with the combat engine's own budget, and it covers ~24 days of
this user's play at today's intensity. `windowStart` is the honest label: the range-stats
panel and the zone-band strip both refuse to render a selection that starts before it, and
say why ("analytics cover play since <date> — older samples aged out"). Nothing is
persisted; the store is rebuilt from the log on every launch.

**Do NOT downsample or roll up into buckets.** A mixed-resolution store makes every range
query lie about its own precision, and the whole point of the feature is exact counts over a
user-chosen window. Drop-oldest with a stated retention floor is the honest bound.

---

## 4. The pure range-stats function

New file `src/shared/progressionStats.ts`. No React, no Electron, no I/O — a pure function
over the snapshot. This is the unit-testable core.

```ts
/** No exp / kill / loot event for longer than this ⇒ idle. See IDLE note below. */
export const IDLE_GAP_MS = 5 * 60_000

export interface ZoneRangeRow {
  /** RAW display name (law 2). */
  zone: string
  /** ms of the selection spent in this zone (Σ over every visit inside the range). */
  spanMs: number
  /** spanMs minus idleMs. */
  activeMs: number
  idleMs: number
  visits: number
  kills: number
  killsSelf: number
  killsPet: number
  /** Σ stated level-bar percent, /100. Excludes unstated samples. */
  levelEquiv: number
  /** exp lines whose percentage the log did not state (at cap). */
  expUnstated: number
  expSamples: number
  /** levelEquiv / (activeMs/3600000) — null when activeMs is 0. */
  levelsPerHourActive: number | null
  levelsPerHourWall: number | null
  killsPerHourActive: number | null
}

export interface ComboInterval {
  startTs: number
  endTs: number
  /** e.g. ['PAL','MNK','ENC'] — display order as stated. */
  classes: string[]
  /** the combo agent's own confidence flag; chipped `inferred` when true. */
  inferred: boolean
}

export interface RangeStats {
  t0: number
  t1: number
  durationMs: number
  activeMs: number
  idleMs: number
  /** number of idle gaps > IDLE_GAP_MS that intersect the range. */
  idleGaps: number
  idleThresholdMs: number

  kills: number
  killsSelf: number
  killsPet: number
  killsWitnessed: number

  expSamples: number
  expParty: number
  expUnstated: number
  /** Σ stated percent / 100 — "levels of progress", NOT experience points. */
  levelEquiv: number
  levelsPerHourActive: number | null
  levelsPerHourWall: number | null
  killsPerHourActive: number | null

  /** dings inside the range, in order. */
  levelUps: { ts: number; level: number }[]
  /** disjoint level runs — a loadout swap opens a NEW run, never a negative span
   *  (levelSeries.ts law: the level legitimately goes DOWN and the drop is unlogged). */
  levelRuns: { fromLevel: number; toLevel: number; startTs: number; endTs: number }[]

  /** Σ of the gain LINES in range. NOT the AA identity — a respec re-logs purchases and
   *  refunds nothing, so this over-reports re-earned points. Labeled at every surface,
   *  exactly like the existing "AA gained over time" caption. (law 5) */
  aaGained: number
  aaGainEvents: number

  zones: ZoneRangeRow[]
  combos: ComboInterval[]

  /** true when t0 < snapshot.windowStart — the panel must say the range is clipped. */
  clipped: boolean
}

export interface RangeStatsArgs {
  snap: ProgressionSnap
  range: { t0: number; t1: number }
  /** OPTIONAL seam — see §5. Absent ⇒ `combos: []`. */
  combo?: ComboSource
}

export function rangeStats(args: RangeStatsArgs): RangeStats
```

`RangeStatsArgs` is a single object on purpose: the repo's ESLint `max-params` is 4.

**Algorithm** (all O(log n + k)):

1. Binary-search each `*Ts` column for the `[t0, t1)` slice bounds.
2. Clip the zone intervals to the range (partial head/tail intervals count only their
   overlap); group rows by `idKey(zone)`, display the raw first-seen name.
3. Idle: build the merged, sorted activity-timestamp stream over `expTs ∪ killTs ∪ lootTs`
   inside `[t0-IDLE_GAP_MS, t1+IDLE_GAP_MS]` (the pad lets a gap that STRADDLES the boundary
   be measured, instead of a selection edge manufacturing activity). Every consecutive gap
   `> IDLE_GAP_MS` contributes `gap` to `idleMs` — the WHOLE gap, not `gap - threshold`
   (the threshold is a classifier, not a grace period; say so in the caption). Clip each
   idle gap to `[t0,t1]`, and split it at every zone boundary it crosses so per-zone idle
   sums to the range idle exactly.
4. `activeMs = durationMs - idleMs`, floored at 0.
5. Level runs: walk `levelValue` in range; a value below the previous one opens a new run
   (identical rule to `buildLevelSegments` in `levelSeries.ts` — reuse the semantics, not
   the code, since that file is renderer-side).

**Invariants worth asserting in tests** (frozen-numbers law — these are identities, not
today's counts):

- `Σ zones[].spanMs == durationMs` (a range is always fully covered by zone intervals once
  the pre-first-zone remainder gets its own `zone: 'unknown'` row).
- `Σ zones[].kills == kills`; `Σ zones[].expSamples == expSamples`.
- `Σ zones[].idleMs == idleMs`; `activeMs + idleMs == durationMs`.
- `levelEquiv` over a range bounded by two consecutive dings is within ±0.05 of 1.0.

### Idle heuristic — recommendation and what the log cannot say

**Recommend `IDLE_GAP_MS = 5 minutes.`** Measured inter-activity gap distribution over the
9869 post-epoch activity events (exp ∪ credited kill ∪ loot):

| p50 | p75 | p90 | p95 | p99 | max |
|---|---|---|---|---|---|
| 4 s | 25 s | 52 s | 87 s | 314 s | 13.7 h |

5 minutes sits just above p99 (314 s), so **fewer than 1% of ordinary between-pull gaps get
misread as idle**. Sensitivity over the whole post-epoch span (146.1 h wall):

| threshold | gaps | idle hours | % of span |
|---|---|---|---|
| 1 m | 791 | 118.1 | 81% |
| 3 m | 197 | 102.4 | 70% |
| **5 m** | **105** | **96.5** | **66%** |
| 10 m | 49 | 90.3 | 62% |
| 30 m | 16 | 83.3 | 57% |

The curve flattens hard after 5 m (5→10 m moves only 4 points of a 146 h span), which is the
signal that 5 m is past the noise and into real breaks.

**Label the heuristic literally, at the surface**: *"idle = no experience, kill, or loot
event for over 5 minutes"*. Not "AFK", not "away".

**Say what the log cannot say** (law 6 — this is a documented non-distinguishable):

- The log records EVENTS, not PRESENCE. There is no login/logout/camp/AFK line in this log
  family, so **sitting in a zone, medding, banking, crafting, travelling, being AFK, and
  having the game closed are all the same silence.** Idle time is *unproductive* time, never
  *absent* time — the panel must use the word "idle", never "AFK" or "offline".
- The threshold is a choice, not a fact. Surface `idleThresholdMs` in the panel caption so
  the number on screen is always accompanied by the rule that produced it.
- Non-combat activity is invisible: a 40-minute tradeskill session reads as pure idle.
- The idle attribution to a zone is exact (the zone line is a real event), but *why* you
  were idle there is not in the log at all.

---

## 5. The class-combo seam (owned by a separate agent)

We CONSUME the combo model; we do not design or infer it. Define the seam as a
**structural, optional interface** in `src/shared/progressionStats.ts` so this feature
compiles and ships before the combo work lands:

```ts
/** Implemented by the combo-inference module (separate plan). Structural — this file
 *  declares the shape it needs and never imports the combo implementation. */
export interface ComboSource {
  /** the loadout active at `ts`, or null when nothing is known at that instant. */
  comboAt(ts: number): ComboInterval | null
  /** every combo interval overlapping [t0,t1), clipped to it, ascending. */
  intervalsIn(t0: number, t1: number): ComboInterval[]
}
```

Contract:

- `rangeStats` calls `combo?.intervalsIn(t0, t1)` exactly once and stores the result
  verbatim in `RangeStats.combos`. It performs **zero** inference, merging, or gap-filling.
- `combo` absent (or `intervalsIn` returning `[]`) is a first-class state, not an error: the
  panel renders "class combo: not stated in this range" — never a guessed trio. The
  self `/who` row is the only line that states a loadout and there are 11 in 1.1M lines, so
  "unknown" is the COMMON case and must look deliberate.
- A `ComboInterval` with `inferred: true` renders with the existing `inferred` chip
  convention.
- When the combo agent's model has its own snapshot/module, the renderer builds the adapter
  in one place (`features/leveling/comboAdapter.ts`) and passes it down; `rangeStats` stays
  ignorant of transport.

**Wave hazard**: if the combo plan wants to own `src/shared/progressionStats.ts`, it must
not — that file is this feature's. The combo plan owns its own module + its own shared file
and exports something structurally assignable to `ComboSource`.

---

## 6. Renderer

Current state: `LevelingView.tsx` (409 lines) renders `AaOverTimePanel` (an `AreaChart` of
cumulative AA) and `LevelOverTimePanel` (a `LevelStepChart`). Both live in
`levelCharts.tsx` (131 lines) as bare inline SVG at a fixed `viewBox` of 720×150,
`preserveAspectRatio="none"`, no chart library.

### 6.1 A shared time domain (prerequisite — do this FIRST)

Today `AreaChart` computes `t0/t1` from its own points and `LevelStepChart` computes its own
(plus a 4% trailing pad). **The two charts are on different X domains.** Zone bands and a
drag selection that mean the same thing on both charts require ONE domain.

Introduce `ChartDomain { t0: number; t1: number }` computed once in `LevelingView` from
`min/max` across level, AA and progression timestamps (keeping the existing 4% trailing pad
so the current level still reads as a plateau), and pass it into both chart components as a
required prop. Both use it for `x()`; nothing else about the drawing changes. This is a
small, behavior-preserving refactor and it is the seam that everything else hangs off.

### 6.2 Zone bands

A `ZoneBands` component rendered inside each chart's SVG as a strip at the top (`y = 0`,
`height = 8`, above `padTop`), with the plot's `padTop` increased by 10 to make room.

- Input: `zoneStart/zoneEnd/zoneName` clipped to the domain, the open final interval clamped
  to `snap.lastTs`.
- **Merge consecutive same-zone intervals before drawing.** 81 of 344 real intervals are
  under 60 s and most are instance re-entry bounces of the same zone; merging by
  `idKey(zoneTier(name).base)` collapses them. After merging, drop bands narrower than 1 px
  from the DRAWING only (they remain in the data and in the stats rows) — a sliver band is
  visual noise that cannot be hovered or read.
- Color: a stable hash of the canonical zone name into a fixed palette (same approach as
  `CONSIDER_FACTION_COLOR`'s "our presentation choice, not something the game states"; the
  log carries no zone color). Keep the palette in `features/leveling/zoneBands.ts` so the
  band strip and the stats-table swatches agree.
- Legend: a dense wrapped row under the chart listing the top 8 zones by dwell in the visible
  domain (`swatch · name · duration`), `+N more` beyond that. This is the identification
  path that does NOT depend on hover, so it survives whatever the hover agent does.
- Do **not** add SVG `<title>` children to the bands — native tooltips would race the custom
  hover card the other agent is building. Flag it to the integrator and let one owner decide.

### 6.3 Drag-select

New hook `features/leveling/useChartSelection.ts`, modelled on the existing pointer handling
in `useTimelineViewport.ts` (pointer capture on the SVG, `dragRef`, clamped to bounds).

```ts
export interface ChartSelection { t0: number; t1: number }
export interface SelectionApi {
  /** committed selection, or null. */
  sel: ChartSelection | null
  /** live band while the pointer is down and past the threshold (for the ghost rect). */
  draft: ChartSelection | null
  /** TRUE from the moment the drag threshold is crossed until pointer-up. The hover
   *  tooltip MUST NOT render while this is true — the disambiguation contract. */
  dragging: boolean
  clear: () => void
  onPointerDown / onPointerMove / onPointerUp / onPointerCancel
}
```

**Disambiguation from hover (the coordination contract):**

- `DRAG_THRESHOLD_PX = 5`. Pointer-down records the origin and captures the pointer but sets
  NOTHING. `dragging` flips true only once `|clientX - originX| >= 5`. Below the threshold,
  pointer-up is a **click**, which CLEARS any committed selection.
- While `dragging` is true, the hover tooltip is suppressed. The hook exposes `dragging`;
  the hover component takes it as a prop (`suppressed`) and returns null. This is the single
  agreed seam — the hover agent must not read pointer state independently.
- Hover remains fully live when `dragging` is false, including over a committed selection
  band. The band is drawn with `pointerEvents: 'none'` so it never steals hover targets.
- `Escape` clears the selection (window keydown while a selection exists).
- Selection is clamped to the domain, normalized so `t0 < t1`, and a drag ending under
  `MIN_SELECTION_MS` (recommend 60 s) is discarded rather than committed — a 3-second range
  produces meaningless rates.
- The selection lives in `LevelingView` state and drives BOTH charts (draw the same band on
  each), so a drag on the AA chart and a drag on the level chart are the same selection.
  Only one is active at a time; a new drag on either chart replaces it.

Visual: `<rect>` at 0.14 opacity in the accent color with 1 px full-height edge rules at each
boundary, plus a small `formatTime`-labelled tick under each edge.

### 6.4 Stats panel

New files `features/leveling/RangeStatsPanel.tsx` + `features/leveling/rangeStatsRows.ts`
(pure row-shaping, unit-testable). Mounted by `LevelingView` below the chart column, only
when `sel != null`. MUI throughout (`Paper variant="outlined"`, `Stack`, `Chip`,
`Typography`) — same idiom as the existing panels.

Layout:

1. **Header row** — `formatDateTime(t0)` → `formatDateTime(t1)` · duration · a `Clear`
   `IconButton`. If `clipped`, a warning chip: "range starts before the analytics window".
2. **Hero row** (reuse the existing `HeroCard` idiom, 4 cards): levels/hr (active) · mobs
   killed · levels gained · level range covered.
3. **Chip row** — active vs idle (`2h 41m active · 38m idle`), the idle rule as a caption,
   the class combo (or "not stated in this range"), `killsWitnessed` dimmed, `aaGained` with
   its respec caption.
4. **Per-zone table** — dense rows, one per `ZoneRangeRow`, columns:
   swatch · zone · time (active/idle) · kills · levels · levels/hr · kills/hr. Sorted by
   `levelsPerHourActive` desc (the farming-efficiency question), with a secondary sort toggle
   on time. **Per the fixed-height-scroll-box law**: explicit height + its own
   `overflow: 'auto'`; the panel gets `flexGrow: 1, minHeight: 0`. Zone counts in a realistic
   range are < 20 rows, so no windowing is needed (`useWindowedRows` is for the 1000-row
   surfaces).

**Formatting law.** `lib/formatDate` for every timestamp (`formatDateTime` for the header,
`formatTime` for the axis ticks) — never epoch math, never UTC. Rates go through
`lib/formatRate`, which today only speaks `dps`/`hps`. Add TWO exports there (the "ONE
source" rule means extending that file, not writing a second formatter):

```ts
/** '1.42 lvl/hr' — a sub-1000 rate, so it must NOT go through formatNum
 *  (formatNum rounds anything under 1000 to an integer: 1.42 → '1'). */
export function formatLevelRate(n: number): string
/** '38.5 kills/hr' — same rule. */
export function formatKillRate(n: number): string
```

That `formatNum` rounding trap is real and will silently render every levels/hr as `1` if
missed. Durations use a local `fmtDuration(ms)` (`2h 41m` / `38m` / `45s`) — the existing
`fmtDelta` in `LevelingView.tsx` is close but formats `1.4h`, which is wrong for a range
readout; extract and widen it rather than adding a third.

**UI-conventions check**: chips convey STATE (`inferred`, `not stated`, `clipped`), never
methodology. The idle rule is a caption on the number it explains, not a how-it-works panel.

---

## 7. Fixtures

Per the fixture law: new extractor `tests/extract-progression-fixtures.mjs`, routed through
the shared `scrubKeep` (`tests/fixture-scrub.mjs`) — never a hand-copied span, never a
re-implemented drop list. Fixtures are committed (`!tests/fixtures/*.log`).

**KEEP set** (a superset of the leveling extractor's):

```js
/You gain (party )?experience!/           // the new event
/You have gained a level! Welcome to level \d+!$/
/gained \d+ ability point/
/You have gained the ability "/
/You have improved .+ \d+ at a cost of/
/^You have entered /                      // zone intervals (pseudo-zones included; the
                                          //   parser rejects them, and the fixture must
                                          //   prove it does)
/You have slain .+!$/                     // self kill credit
/ has been slain by .+!$/                 // pet + third-party credit
/told you, '.*Master\.'$/                 // pet binding — kept by the scrub's carve-out
/ has been charmed\.$/
/^--You have looted /                     // idle-heuristic activity signal
/^\[\d+ [A-Z]{3}(?:\/[A-Z]{3})*\] Primitive /  // self /who — combo seam evidence
```

(The extractor applies these AFTER `scrubKeep`, exactly like `extract-leveling-fixtures.mjs`.)

**Golden windows** (real line ranges, verified above):

| fixture | real span | what it pins |
|---|---|---|
| `wl40-farm-run.log` | 987818 – 1017315 (`Sun Aug 02 15:12` level 18 → `17:33` level 28) | the core case: 10 dings in 2h21m, dense exp% + kills. Σ percent per level ≈ 100; levels/hr; kills/hr. |
| `wl41-multizone.log` | a span crossing ≥ 3 `You have entered` lines with kills in each | per-zone rows, the `Σ zones[].spanMs == durationMs` identity, zone attribution of kills. |
| `wl42-idle-gap.log` | a span containing at least one > 5 min and one > 60 min activity gap | the idle classifier, gap clipping at the range edge, per-zone idle split. |
| `wl43-capped-no-pct.log` | 693485 – 707000 (`Fri Jul 31 17:51` onward) | `pct: undefined` handling: `expUnstated > 0`, `levelEquiv == 0`, `levelsPerHour == null` — and AA gains landing in the same window. **The regression that matters**: nothing may render `0.0%` or a fake rate here. |
| `wl44-swap-boundary.log` | 1020000 – 1024500 or the Aug 02 02:13 post-swap boundary | `levelRuns` splits at the drop; no negative level span; no fabricated "time to level" across the swap. |
| `wl45-kill-credit.log` | any span containing all three shapes (self / bound pet / third party) in one zone | `killsSelf + killsPet == kills`, `killsWitnessed` excluded from every rate. |

`wl41`/`wl42`/`wl45` line ranges must be picked by the executing agent with a fresh grep and
recorded in the extractor's comment block (the log grows; the other four are anchored to
lines that already exist).

**Tests** — `tests/progressionWindows.test.mts`, node:test + tsx, replaying each fixture
through the REAL `parseEvent` + `EpochDetector` + `ProgressionModule`, then calling
`rangeStats` with hand-read `[t0,t1]` bounds and asserting exact numbers. Plus a full-log
test guarded on the live log's existence (skips in CI, like the existing ones) that asserts
only IDENTITIES and floors — never today's counts (frozen-numbers law):

- `Σ zones[].kills == kills` over the whole span;
- `activeMs + idleMs == durationMs` for 20 random sub-ranges;
- `levelEquiv` between consecutive dings ∈ [0.9, 1.1] for every ding pair whose interval is
  free of unstated samples;
- `killsSelf + killsPet` within 5% of `expSamples` (the credit/exp correlation — a floor,
  not an equality).

A pure-unit test file `tests/rangeStats.test.mts` with SYNTHETIC snapshots covers the edge
cases fixtures can't reach cheaply: empty range, range entirely inside one idle gap, range
before `windowStart` (`clipped`), zero-duration range, `combo` absent, a single sample.

---

## 8. Wave plan

Three waves, disjoint file ownership. **The integrator sequences waves 2 and 3 against the
hover-tooltip plan (see the hazard below).**

### Wave 1 — main + shared + tests (no renderer)

Owns:
- `src/shared/logEvents.ts` (add `ExpGainEvent`, extend the union)
- `src/shared/types.ts` (add `ProgressionSnap` / `ProgressionDelta`)
- `src/shared/progressionStats.ts` (**new** — `rangeStats`, `RangeStats`, `ComboSource`,
  `IDLE_GAP_MS`)
- `src/main/log/parseWorld.ts` (add `classifyExp`)
- `src/main/log/parser.ts` (register the classifier in `CLASSIFIERS`)
- `src/main/modules/progression.ts` (**new**)
- `src/main/pipeline.ts` (construct + `registry.register`, after `killsModule`)
- `tests/extract-progression-fixtures.mjs` (**new**), `tests/fixtures/wl4*.log` (**new**)
- `tests/progressionWindows.test.mts`, `tests/rangeStats.test.mts` (**new**)

Verify: `npm run typecheck` · `npm run lint` (zero new ratchet entries — a new module and a
new pure file must be written under the measured thresholds: `complexity 12`, `max-depth 3`,
`max-lines 400`, `max-lines-per-function 100`, `max-params 4`) · `npm test` full suite.
Regression gate: `tests/levelingSwapWindows.test.mts` and `tests/goldenWindows.test.mts` must
be untouched and green — the new classifier only claims lines that previously produced
`{kind:'unknown'}`, so **no existing event count may change**. Baseline
`npm test 2>&1 | tail -40` before and diff after.

### Wave 2 — chart interaction (renderer)

Owns:
- `src/renderer/src/features/leveling/levelCharts.tsx` (shared `ChartDomain` prop, band
  strip mount point, selection rect)
- `src/renderer/src/features/leveling/zoneBands.ts` (**new** — merge + palette + legend rows)
- `src/renderer/src/features/leveling/useChartSelection.ts` (**new**)
- `src/renderer/src/features/leveling/LevelingView.tsx` (domain computation, second
  `useModule('progression')`, selection state, panel mount)

**First edit of the wave**: create a compiling stub
`features/leveling/RangeStatsPanel.tsx` (renders a Paper with the header row only) so the
import in `LevelingView.tsx` never points at a missing file — the keep-the-tree-buildable
law. Wave 3 re-reads and fills it.

### Wave 3 — stats panel (renderer, new files)

Owns:
- `src/renderer/src/features/leveling/RangeStatsPanel.tsx` (fills Wave 2's stub)
- `src/renderer/src/features/leveling/rangeStatsRows.ts` (**new** — pure row shaping)
- `src/renderer/src/lib/formatRate.ts` (add `formatLevelRate` / `formatKillRate`)
- `tests/rangeStatsRows.test.mts` (**new**)

Depends on Wave 1's `src/shared/progressionStats.ts` types. **Sequence: Wave 1 alone, then
Waves 2 and 3 in parallel.**

### Coordination hazard — FLAG FOR THE INTEGRATOR

> The separately-planned **hover-tooltip** work targets the SAME chart component
> (`features/leveling/levelCharts.tsx`) and almost certainly the same
> `LevelingView.tsx`. These two files must be owned by **exactly one wave at a time** —
> the concurrent-agents rule (re-read shared files immediately before each surgical edit)
> is not sufficient protection for two waves both restructuring the same SVG's props and
> pointer handlers.
>
> Recommended order: **land this plan's Wave 2 first** (it introduces the shared
> `ChartDomain` and the `dragging` flag the tooltip must respect), then hand
> `levelCharts.tsx` to the hover wave, which consumes `dragging` as a `suppressed` prop.
> The reverse order forces the hover agent to invent a domain and then have it replaced.
>
> Two further seams to arbitrate before either wave starts:
> 1. Who owns the SVG's `onPointerMove` — recommend `useChartSelection` owns the pointer
>    handlers and forwards the cursor position to the tooltip, rather than two independent
>    handlers on one element.
> 2. Whether zone bands carry native SVG `<title>` tooltips (this plan says no; the hover
>    plan may want the band identity inside its own card instead).

### Final verification (integrator, after the last wave)

`npm run typecheck` · `npm run lint` (with `EQ_LINT_NO_RATCHET=1 npx eslint .` checked for
new debt) · `npm test` · `npm run test:e2e` (main AND renderer changed). E2E addition: assert
the Leveling tab mounts with the zone-band strip present and NO stats panel until a
selection exists (mount/empty-state assertions are exactly what the harness is for).

---

## 9. Open questions / deliberate non-goals

- **Raw experience points are not knowable.** The log never prints an exp total, a
  to-next-level requirement, or a bar position. `levelEquiv` is the ceiling of what can be
  claimed. Do not add an "XP" number to any surface.
- **Party exp is flagged, not attributed.** `You gain party experience!` proves a group-mate's
  kill paid you; it does not name the mob, the killer, or your share. `expParty` is a count,
  nothing more.
- **Resizable selection edges** (drag a boundary to adjust) are deferred — v1 is
  drag-to-create, click-to-clear.
- **Persisting the last selection** across a tab switch is deferred; `viewKey` remounts the
  view anyway.
- **A user-configurable idle threshold** is deferred. `IDLE_GAP_MS` ships as a labeled
  constant; if it becomes a setting it needs a store migration in the same commit.
- **The 502 percent-less exp lines** are explained by the level cap with strong evidence, but
  that is our reading, not the log's words. Ship the neutral label; revisit if a
  percent-less line ever appears while the character is below cap (a full-log assertion
  could watch for exactly that).
