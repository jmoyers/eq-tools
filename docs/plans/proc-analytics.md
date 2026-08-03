# Proc analytics + counterfactual DPS attribution — design

Task: **procs per minute** (fight AND overall), across weapon / poison / buff-granted
procs; **rate modulation over time** (does some tracked state change the proc rate?); and
**counterfactual DPS attribution** ("how much DPS does X add") for Slay Undead, poisons,
Instrument of Nife and Spellblade.

Everything below is grounded in three sources, in this order of authority: the **real log**
(`eqlog_Primitive_freeport.txt`, 1,110,084 lines, read-only sweeps 2026-08-03), the
**committed spell DB**, and **eqlwiki.com**. Where the three disagree the log wins and the
disagreement is written down.

---

## 0. Findings that change the brief

Two names in the brief were wrong, and one whole mechanic turned out to be measurable:

| Brief said | Reality (verified) |
|---|---|
| "Instrument of Knife" | **Instrument of Nife** — Paladin L15 *self-buff*, `Permanent`, `Add Melee Proc: Condemnation of Nife`. Its landing/fade messages are UNIQUE in the DB (exactly one spell each), so its up/down span is unambiguous. |
| "Spellblade is part of the new stance system" | Spellblade is an **invocation**, not a stance. Wiki (`eqlwiki.com/index.php/Spellblade`, and the `Stances & Invocations` page): it converts your **#1 spell gem into a weapon proc**, costing ~40% mana / 20% endurance per proc. Classes BST/PAL/RNG/SHD, granted at level 1. |
| "9 stances + 9 invocations" | **Confirmed, and both rosters are complete in this log.** |

**Stances (9)** — `You assume an? <X> stance.`
`defensive 212 · balanced 118 · berserker 83 · mage hunter 44 · striker 35 · channeler 11 ·
ranged 1` plus `offensive` and `evasive`, which a naive `You assume a ` grep MISSES because
the line reads *"You assume **an** offensive stance."*. The shipped parser
(`parseCasts.ts:68`, `/^You assume an? (.+?) stance\.$/`) already handles the article — the
AGENTS.md quick-reference line `You assume a X stance.` is the thing that is imprecise, not
the code.

**Invocations (9)** — `You begin reciting the <X> invocation.`
`inversion 1018 · recovery 530 · overchannel 488 · spellblade 265 · divine 134 ·
inviolable 19 · empowering 15 · arcane mastery 14 · unyielding 6`.
Note the wiki spells it **"Over Channel"** (two words); the log prints **`overchannel`**.
Any wiki-driven label table must map one to the other. `arcane mastery` really is two words.

**Neither stances nor invocations exist in `spells.json`** (1,926 entries, classic-era
`Template:Spellpage` scrape). They are abilities. There is no message, duration or effect
string for them anywhere in the committed data. That is the single most important
constraint on this whole feature.

### 0.1 What a proc actually looks like in this log

A proc is a **spell effect line with no own-cast line behind it**. Probe (read-only, 12s
cast-attribution window, rank-normalized names):

```
                          proc    cast     proc damage
Smiting Strike            9633       0       1,437,553
Lifetap Strike            1814       0          52,861
Condemnation of Nife      1096       0         230,829
Vampiric Embrace           586       0          18,851
Dismiss Undead             359       9          54,151
Discordant Mind            352     561         147,080
Siphon Life                293     255          39,083
Ignite                     148       0           6,419
Lifedraw                   126      28          11,937
Dismiss Summoned            23       0           3,425
Asp Venom Strike            15       0             795
```

Two populations, and the split is the design:

* **Pure procs** (`cast = 0`): `Smiting Strike`, `Lifetap Strike`, `Condemnation of Nife`,
  `Vampiric Embrace`, `Ignite`, `Dismiss Summoned`, `Asp Venom Strike`. None of these
  exists in `spells.json` either (checked individually) — they are EQ-Legends proc effects.
* **Mixed spells** — a real spell you also cast by hand, which ALSO fires cast-less. And the
  cast-less half is not scattered:

```
Discordant Mind   spellblade:352          (352 of 352 — exclusive)
Siphon Life       spellblade:293          (293 of 293 — exclusive)
Lifedraw          spellblade:96  (none):30
Vampiric Embrace  spellblade:376  recovery:96  inversion:47  …
Smiting Strike    inversion:6054  spellblade:1597  recovery:1496  overchannel:318  …
```

**That is Spellblade, visible in the log with no ambiguity at all.** Discordant Mind and
Siphon Life are the player's gem-#1 spells; every single cast-less firing of either happened
while the `spellblade` invocation was active. `Smiting Strike` by contrast fires under every
invocation, so it is a weapon/gear proc and has nothing to do with Spellblade.

This gives the feature an honest, log-derived detector — and it gives the correlation engine
a case where the correlation is 100%, which is exactly the case where the UI must still say
"correlated", not "caused by".

### 0.2 Item lines that are NOT procs

`Your Djarn's Amethyst Ring (Exaltation) shimmers briefly.` (5,027) and
`Your Idol of the Underking feels alive with power.` (2,248) look like procs and are not.
Every sampled occurrence is immediately followed by `You begin casting <Spell>.` — they are
**clicky activations**. They are deliberately out of scope for v1 and the doc says why, so
nobody "adds the missing item procs" later.

### 0.3 Instrument of Nife, the honest-limits case

```
A brilliant blue aura surrounds your weapon.   97      (msgCastOnYou, unique to this spell)
The brilliant blue aura fades.                  1      (msgWearsOff,  unique to this spell)
Condemnation of Nife procs             1,096  →  230,829 damage, flat 193 per proc
  … while the aura was observed UP: 1,084     … while observed DOWN: 12
Your melee swing attempts: aura up 261,505  ·  aura down 289
```

The buff is up essentially always. **Tier A (direct) gives an exact answer; Tier B
(counterfactual) is impossible** — 289 swings is not a control group. This asymmetry is not
a defect to engineer around; it is the result, and the model must be able to report it.

---

## 1. World-model position

* **Law 1 (messages over inference).** Every count in this feature comes from a line the
  game printed. The one derived judgement — "this spell effect had no cast behind it,
  therefore it procced" — is a labeled inference with a stated window, and it is never
  allowed to name a *source* ("your Instrument of Nife did that"), only a *co-occurrence*.
* **Law 5 (aggregates lie).** PPM is absent, never `0`, below the sample floors. The
  counterfactual reports **medians with IQR and both n's**, never a bare mean, and reports
  `insufficient-sample` as a first-class verdict rather than a small number.
* **Law 6 (say what the log cannot say).** A whole section, below, and it is load-bearing:
  the log carries **no per-hit marker for any stance or invocation bonus**. Offensive stance
  is +100% melee damage per the wiki and prints nothing.
* **Law 8 (damage-free events are first-class).** Everything here is an ADDITIVE index over
  damage already counted, or a count with no amount. **Not one damage total moves.** That is
  the regression tripwire for every wave.
* **Fight | Overall scope law.** PPM and direct attribution are computed for BOTH scopes
  from the same `Agg` (which is exactly why the Task #64 ledger lives there — a zone session
  inherits it frozen, for free). The **counterfactual is Overall-only**, because a single
  pull has no inactive sample; a fight-scope selection reports `not-applicable`, never a
  number derived from one window.

---

## 2. Data model

### 2.1 New shared file — `src/shared/procAnalytics.ts`

A NEW file, not an extension of `shared/combat.ts`. Two other in-flight plans
(`graph-hover-tooltips`, `overview-tab`) both edit `shared/combat.ts`; a new file removes a
three-way contention and follows the shipped precedent (`shared/poisons.ts` split out of
`logEvents.ts`, `buffTypes.ts` split out of `types.ts`).

```ts
// ---- the active-state timeline ----------------------------------------------------

/** What kind of state a span describes. `disc` is deliberately ABSENT: this log's only
 *  "discipline" lines are `You have been granted the following discipline: <Poison>` —
 *  the poison grant list — not an activated combat discipline. There is no disc state
 *  to track, and inventing the kind would invite someone to fill it. */
export type StateKind = 'stance' | 'invocation' | 'coat' | 'buff'

/**
 * How we know a span's edge. This is law 1 made into a field: a span end is almost never
 * printed by the game.
 *   'observed'  — a line said so (`The poison dries from the blade.`, a wears-off message).
 *   'inferred'  — a mutually-exclusive sibling replaced it (a new stance commit ends the
 *                 previous stance; a re-cast of a permanent buff supersedes its own span).
 *   'censored'  — the boundary is unknowable: it was already active when the replay began,
 *                 or a zone/death/epoch/reset severed it. NEVER shown as an end time.
 *   'open'      — still active as of the last event.
 */
export type EdgeEvidence = 'observed' | 'inferred' | 'censored' | 'open'

export interface StateSpan {
  kind: StateKind
  /** canonical join key — lowercased, rank-stripped. */
  key: string
  /** display name, raw casing (law 2: canonicalize at boundaries, display raw). */
  name: string
  startTs: number
  /** absent while `endEvidence === 'open'`. */
  endTs?: number
  startEvidence: EdgeEvidence
  endEvidence: EdgeEvidence
}

// ---- proc rates --------------------------------------------------------------------

export type ProcOrigin =
  | 'poison'  // a rogue Strike emote — ALREADY modeled by Task #64, reused not duplicated
  | 'spell'   // a spell-effect line with no own cast behind it
  | 'slay'    // the `(Slay Undead)` melee paren modifier — a proc that rides a swing

/**
 * THREE denominators, all carried, none hidden. They answer different questions and the
 * UI shows at least two, because collapsing them is how a proc meter starts lying:
 *   ppmActive     — the headline. Procs per minute of ACTIVE combat time.
 *   ppmWall       — procs per minute of wall clock, for the "how often does this happen
 *                   while I play" question.
 *   per100Swings  — the only MECHANICALLY correct figure for a chance-on-hit proc.
 * Every one is ABSENT (undefined), never 0, below its sample floor — `1 proc in a 2-second
 * pull` is not `30 ppm` (law 5).
 */
export interface ProcRateView {
  count: number
  ppmActive?: number
  ppmWall?: number
  /** YOUR melee swing attempts in this segment: melee+slay hits + misses. The mechanical
   *  denominator. Main-hand vs off-hand and double/triple attack remain undistinguishable
   *  (law 6), so this is swings-as-logged, and the field name says so. */
  swings: number
  per100Swings?: number
}

/**
 * ONE proc lane, unified across origins. Extends the shipped `ProcLane` shape so the Procs
 * tab's existing rows keep rendering unchanged.
 */
export interface ProcLaneView {
  name: string
  count: number
  origin: ProcOrigin
  /** true when the LABEL is uncertain (shared emote, shared dispel tier) — the shipped
   *  `~` treatment. The COUNT is always exact. */
  ambiguous?: boolean
  rate: ProcRateView

  // ---- TIER A: DIRECT attribution. MEASURED, not estimated. -----------------------
  /** Damage these proc lines carried. Already inside the segment's `outTotal`. */
  directDamage: number
  /** Healing these proc lines carried (`You healed X for N hit points by Lifetap Strike.`). */
  directHeal: number
  /** directDamage as a % of the segment's outgoing total. */
  pctOfOut: number
  /** directDamage / activeSec — "this proc's share of your DPS". EXACT for 'spell' and
   *  'poison' lanes. For a 'slay' lane it is the damage of swings that PROCCED, which is
   *  NOT the same as the damage the proc ADDED — see `marginalDamage`. */
  dpsContribution: number
  /**
   * SLAY-ONLY, and an ESTIMATE with its assumption written into the type: a Slay Undead
   * swing would have landed anyway for something. This is
   *   slayTotal − slayHits × (mean melee hit in this segment)
   * i.e. the excess over an ordinary swing. Absent for every other origin, where the
   * proc's whole damage IS the marginal damage.
   */
  marginalDamage?: number

  /** Co-occurrence with tracked states. CORRELATION. See ProcLink. */
  linked: ProcLink[]
}

/**
 * How often a lane fired while a given state was active. THIS IS NOT CAUSATION and the type
 * is shaped so a consumer cannot pretend otherwise: it carries both counts and the
 * inactive-side EXPOSURE, because "never fired without it" is only evidence if there was a
 * meaningful chance to fire without it.
 */
export interface ProcLink {
  kind: StateKind
  key: string
  name: string
  withCount: number
  withoutCount: number
  /** withCount / (withCount + withoutCount), 0..1. */
  concentration: number
  /** YOUR swing attempts logged while the state was INACTIVE in this segment. The
   *  denominator of the claim "it never fired without it". */
  inactiveSwings: number
  /**
   * 'exclusive'    — withoutCount === 0 AND inactiveSwings >= MIN_INACTIVE_SWINGS.
   * 'correlated'   — concentration >= 0.8 with both sides sampled.
   * 'weak'         — sampled both sides, concentration < 0.8.
   * 'inconclusive' — the inactive side was never meaningfully sampled. The DEFAULT, and
   *                  the answer for Instrument of Nife (289 inactive swings in 1.1M lines).
   */
  strength: 'exclusive' | 'correlated' | 'weak' | 'inconclusive'
}

// ---- TIER B: the counterfactual ----------------------------------------------------

/**
 * The FOUR verdicts. Exactly four, and none of them may be rendered as another — the same
 * discipline the shipped `SlowHeadline` enforces for time-to-slow:
 *   'measured'            — Tier A only. An exact number; no comparison was needed.
 *   'estimate'            — Tier B cleared every gate. Rendered `~`, as a RANGE, with its
 *                           confounds printed beside it.
 *   'insufficient-sample' — the gates failed. Says WHICH side is short, and how short.
 *   'not-observable'      — the effect has no per-hit marker AND no exclusive proc lane.
 *                           Every stance, and most invocations. The honest answer is a
 *                           sentence, not a number.
 */
export type AttributionVerdict = 'measured' | 'estimate' | 'insufficient-sample' | 'not-observable'

export interface MarginalEstimate {
  nActive: number
  nInactive: number
  /** MEDIAN outgoing DPS per eligible window, active vs inactive. Median, not mean: one
   *  8-minute boss window must not set the headline (the SlowRollup precedent). */
  medDpsActive: number
  medDpsInactive: number
  iqrActive: [number, number]
  iqrInactive: [number, number]
  deltaDps: number
  deltaPct: number
  /** The same comparison on PROC damage alone, and on damage-per-swing alone. Reported
   *  SEPARATELY on purpose: for spellblade the real log shows dmg/swing flat (26.2 vs 26.3)
   *  while proc damage/min is up ~40% (727.8 vs 518.5). Averaging those two into one
   *  headline would hide the entire mechanism. */
  medProcDpsActive: number
  medProcDpsInactive: number
  medDmgPerSwingActive: number
  medDmgPerSwingInactive: number
}

export interface EffectAttribution {
  kind: StateKind
  key: string
  name: string
  verdict: AttributionVerdict
  /** Tier A. `lanes` names the proc lanes rolled in, so the number is auditable. */
  direct: { damage: number; heal: number; hits: number; dpsContribution: number; lanes: string[] }
  /** Tier B. Present ONLY when verdict === 'estimate'. */
  marginal?: MarginalEstimate
  /** DECLARED, never corrected. See §5.4. */
  confounds: string[]
  /** Why it is insufficient / not observable, in the words the UI prints. */
  note?: string
}

export interface AttributionReport {
  /** the zone-session id this describes. */
  sessionId: string
  windowSec: number
  windowsTotal: number
  windowsEligible: number
  effects: EffectAttribution[]
}
```

### 2.2 Surgical additions to `src/shared/combat.ts`

Three field additions on `ProcsView` and one import. Nothing existing changes shape, so
every shipped consumer (`ProcsBody`, `formatProcsText`, the overlays, the golden tests)
keeps compiling untouched.

```ts
  /** Every proc lane — poison Strikes, spell procs, Slay Undead — with rates and Tier-A
   *  attribution. The shipped `strikes` / `poisonDamage` / `dispels` arrays are UNCHANGED
   *  and stay the poison tab's source; `lanes` is the superset view. */
  lanes: ProcLaneView[]
  /** All lanes together — the "procs per minute" headline. */
  overall: ProcRateView
  /** State spans overlapping this segment, for the ledger and the link joins. */
  states: StateSpan[]
  /** TIER B. Present only for a ZONE-session selection (`kind === 'zone'`): a single fight
   *  has no inactive sample, and offering a per-fight counterfactual would be an invitation
   *  to read noise as an effect. */
  attribution?: AttributionReport
```

**Deliberately NOT added:** a `SnapshotOpts.attribution` flag and a `CombatSnapshot.attribution`
field. See §6.

---

## 3. The active-state timeline — where it lives

**Recommendation: inside the combat engine**, as a new module
`src/main/combat/stateTimeline.ts` with its ring on `EngineState`. Not a new shared service,
not the buffs module.

Why:

1. **Three of the four kinds are already there.** `EngineState` owns `stance`, `invocation`
   (`state.ts:78-79`) and the two-slot coat state (`coatUtility` / `coatCombat`,
   `state.ts:86-87`); `Encounter.stanceSpans` is already a span list. A new service would
   fork state that has one owner today, and forked state drifts.
2. **The buff kind needs no new plumbing.** The engine ALREADY ingests `buffApply` — Task
   #64 routes dispel landings through it (`ingest.ts:206`). Adding `buffWearOff` is one more
   `case` in the same switch.
3. **`BuffsModule` is the wrong home and cannot be the home.** It is a `ModuleRegistry`
   module reached only via `registry.snapshot(moduleId)`; there is no cross-module read path
   and inventing one is a bigger architecture change than this feature earns. Its semantics
   are also different on purpose — it exists to MINE DURATIONS under own-cast gating and
   censoring, which is a different question from "was this on at time T", and it cannot see
   stances or coats at all.
4. **The only consumer is the combat snapshot.** One owner, one payload, one IPC.

**Do not merge `Encounter.stanceSpans` into the new ring in this feature.** It is consumed
by `TimelineView.stanceSpans` and sits inside the byte-identical regression surface; the new
ring is session-level and additive. Two lists, one shared writer (`applyStance`).

### 3.1 Span semantics per kind

| kind | opens on | closes on | end evidence |
|---|---|---|---|
| `stance` | `stanceChange` | the next `stanceChange` | `inferred` — the game never prints "your stance ends" |
| `invocation` | `invocationChange` | the next `invocationChange` | `inferred`, same reason |
| `coat` (utility) | `poisonCoat` group=utility | `poisonDry` group=utility → `observed`; a replacing coat → `inferred` | both occur in the real log, in the same second (`01:06:44/47`, `01:16:26/29`) |
| `coat` (combat) | `poisonCoat` group=combat | `poisonDry` group=combat clears the WHOLE stack → `inferred` | law 6: the dry line cannot say which venom expired. Mirrors the shipped `routeDry` exactly. |
| `buff` | `buffApply` whose candidate set ∩ `PROC_BUFF_CATALOG` ≠ ∅, `target: 'self'` | that spell's `buffWearOff` → `observed`; a re-apply → `inferred` | 97 applies vs 1 fade in the real log: ends are overwhelmingly unobserved, and the model must say so rather than invent them |

**Boundaries.** `zone` — stance/invocation/coat SURVIVE (the engine already treats them as
session-scoped, and the wiki says poisons last until class swap or death); self buffs survive
too (law 4). `epoch` / `reset` / `playerDeath` — every open span is closed `censored`, never
`observed`. A span that was already open when the replay began starts `censored`.

### 3.2 The proc-buff catalog — `src/shared/procBuffs.ts` (new)

A **curated** table, not the whole spell DB. Feeding 1,926 spells into a span tracker would
flood the model with irrelevant states and make every correlation meaningless. The gate is
the same one `DISPEL_FAMILY` applies to dispels, and for the same reason.

v1 entry, copied verbatim from `spells.json` (never invented):

```ts
{ name: 'Instrument of Nife', classes: 'Paladin 15',
  applyMsg: 'A brilliant blue aura surrounds your weapon.',
  wearOffMsg: 'The brilliant blue aura fades.',
  grantsProc: 'Condemnation of Nife' }   // wiki: "Add Melee Proc: Condemnation of Nife"
```

Both messages are **unique in the DB** (verified: exactly one candidate each), so the span
is unambiguous. `grantsProc` is a wiki-sourced HINT used to pre-seed a `ProcLink` label —
it is never used to *attribute* a proc; the link's strength still comes from the observed
co-occurrence counts.

### 3.3 Query API (pure, in `stateTimeline.ts`)

```ts
noteState(st, kind, key, name, ts, startEvidence)   // opens; closes the exclusive sibling
closeState(st, kind, key, ts, endEvidence)
censorAll(st, ts)                                    // epoch / reset / player death
spansOverlapping(st, fromTs, toTs): StateSpan[]
activeAt(st, ts): StateSpan[]
overlapMs(span, fromTs, toTs): number
```

Ring cap `STATE_SPAN_CAP = 2_000`, drop-oldest, purely a memory bound: the whole 1.1M-line
log produces ~700 stance+invocation commits, 6 coats and 97 buff applies.

---

## 4. Proc detection + PPM

### 4.1 Detection

Three producers, folded on **ingest** — never from the timeline ring, which is capped,
truncated and absent entirely for zone sessions (the exact law the Task #64 ledger already
obeys).

1. **`poison`** — reuse `ProcAccum.strikes` verbatim. No new parsing, no duplicate counting.
   The unified `lanes` array projects the existing map.
2. **`spell`** — a new `procDetect.ts`. Maintain `recentCasts: Map<spellCanonKey, ts>` on
   `EngineState`, written from `castBegin`. An outgoing `damage` or `heal` event naming a
   spell counts as a PROC when no `castBegin` of that spell (rank-normalized via the existing
   `spellCanonKey`) was seen within `PROC_CAST_WINDOW_MS`.
   `PROC_CAST_WINDOW_MS = 12_000`, and the number is measured, not guessed: at 12s the
   partition is clean — every pure proc scores `cast = 0` and every hand-cast nuke
   (`Chaotic Feedback` 893, `Sanity Warp` 502, `Anarchy` 112, `Strike` 90) scores `proc = 0`.
   The residual mixed lanes (`Discordant Mind`, `Siphon Life`) are *genuinely* mixed — they
   are Spellblade firing the same spell the player also casts.
   Longest-DoT caveat: a DoT tick arriving >12s after its cast would misclassify. Mitigated
   by gating the detector to `dtype === 'spell'` and `heal` only — **never `dot`**, whose
   ticks are cast-detached by construction.
3. **`slay`** — `category === 'slay'` hits. Free: the compound `(Riposte Slay Undead)`
   modifier already parses (`taxonomy.ts:60`) and already has its own `DamageCategory`.

### 4.2 Active time — reuse, do not redefine

`SegmentView.activeSec` is the definition, used verbatim:

> `Encounter.activeMs` = Σ over consecutive **attributed damage** hits of
> `min(gap, ACTIVE_MS)` with `ACTIVE_MS = 3_000`; first hit adds 0
> (`routing.ts:162-165`). Zone: `zoneActiveSec = (zoneActiveMs + current.activeMs)/1000`
> (`lifecycle.ts:267`). The view clamps: `activeSec = min(durationSec, activeSec)`.

**A caveat that must be LABELED, not fixed:** `route()` accrues `activeMs` *before* the
incoming/outgoing split, so incoming damage extends active time too. A pull where you are
being beaten on while stunned accrues active seconds you did not swing in. Changing that
would move `activeDps` — a shipped number, and a byte-identical-regression violation. So the
tooltip says what it is: *"active time = the meter's definition — capped 3-second gaps
between attributed hits, incoming included."* The `per100Swings` figure exists precisely
because it has no such ambiguity.

### 4.3 Floors

```
MIN_ACTIVE_SEC   = 10     // below this, ppmActive and ppmWall are ABSENT, not 0
MIN_SWINGS       = 20     // below this, per100Swings is ABSENT
MIN_INACTIVE_SWINGS = 200 // below this, a ProcLink is 'inconclusive', never 'exclusive'
```

`ppmActive = count / (activeSec / 60)`, `ppmWall = count / (durationSec / 60)`,
`per100Swings = 100 * count / swings`.

`swings` = YOUR `melee` + `slay` hits + YOUR misses, accumulated on ingest into a new counter
on `Agg` (one integer; zone sessions inherit it frozen like everything else on `Agg`).

---

## 5. Counterfactual attribution — the algorithm

New pure module `src/main/combat/counterfactual.ts`. Zone-session scope only.

### 5.1 The window ledger (folded on ingest)

A `WindowAccum` on `Agg`, keyed by wall-clock minute (`floor(ts / 60_000)`):

```ts
interface Window {
  minute: number
  activeMs: number      // same capped-gap accrual as Encounter.activeMs
  swings: number        // your melee+slay hits + misses
  outDamage: number     // your outgoing total
  procDamage: number    // Σ directDamage of proc lanes in this window
  transitions: number   // state commits that landed INSIDE this window
  stateKeys: Set<string>// `${kind}:${key}` active at any point in the window
}
```

`WINDOW_MS = 60_000`. Chosen by measurement, not taste: on the real log, minute windows yield
**1,289 clean inversion windows vs 324 clean spellblade windows** — both sides of the biggest
comparison are comfortably sampled, which a 5-minute window would not achieve for the smaller
arm. Cost: a long zone session is a few hundred windows; the report is ~n_windows × n_states
arithmetic, trivially inside the 4×/sec snapshot budget.

### 5.2 Eligibility gates

A window is eligible **for a given state S** only when all hold:

1. **Purity** — `transitions === 0` for S's exclusive group, and S was active for the WHOLE
   window or inactive for the WHOLE window. A window containing a switch is **discarded, not
   split**: the boundary carries the 6-second reuse timer, the re-buff burst and the
   mid-window re-target, which is precisely the confound.
2. **Volume** — `swings >= 10` and `activeMs >= 20_000`. A minute spent standing still is
   not evidence about anything.

### 5.3 Statistic

Per eligible window, `dps_i = outDamage_i / (activeMs_i / 1000)`. Report **median + IQR** of
the active arm and the inactive arm, both `n`s, `deltaDps` and `deltaPct` — and separately
the same comparison on `procDamage` and on `outDamage / swings`.

**Sample gate:** report `verdict: 'estimate'` only when `nActive >= 20` **and**
`nInactive >= 20`. Otherwise `'insufficient-sample'`, with `note` naming which arm is short
and by how much. On the real log this is what protects Instrument of Nife: 261,505 swings up
vs 289 down produces zero eligible inactive windows, so the feature says *"no comparison is
possible — this buff was up for effectively the whole session"* and falls back to the exact
Tier-A number, which is the truth.

Renderer presents an estimate as a **range**, not a point: `~ +90 … +210 dps` derived from
the two IQRs, with the medians in a tooltip. A point estimate on a matched-window comparison
over uncontrolled content would be a precision claim the data does not support.

### 5.4 Confounds — declared, never corrected

`confounds: string[]`, built by comparing the two window sets:

* `zone-mix` — the arms span different zones; names them.
* `level-drift` — your level changed inside the span.
* `co-state` — another tracked state's active fraction differs by >20 percentage points
  between the arms (e.g. *"defensive stance was up in 62% of active windows but 31% of
  inactive ones"*).
* `not-interleaved` — the arms are temporally separated (all active windows precede all
  inactive ones). Gear, level and content all drift with time.
* `content-mix` — the distinct-mob-name overlap between the arms is below 50%.

**No adjustment is attempted.** Regression-adjusting an observational comparison over
uncontrolled EQ content would manufacture confidence. The UI prints the list.

### 5.5 `not-observable` — the answer for most of the roster

An effect gets `verdict: 'not-observable'` when it has **no per-hit marker and no exclusive
proc lane**. Per the wiki, that is 17 of the 18 stances and invocations — Offensive stance is
+100% melee damage and prints nothing; Berserker doubles attack speed and prints nothing;
Striker multiplies weapon-skill damage and prints nothing. Spellblade is the sole exception,
and only because it fires a *spell* whose own lines print.

The note the UI shows, verbatim:

> A stance that boosts base melee has no per-hit marker in the log. Nothing distinguishes a
> swing under Offensive from a swing under Balanced except the swing's number — and the mob,
> your level and your gear all changed too. The window comparison below is the closest
> honest answer, and it is an estimate.

Even for a `not-observable` effect the report still carries the matched-window comparison
when the gates pass — it is just labeled `estimate` with its confounds, never `measured`.

### 5.6 Slay Undead, worked

`(Slay Undead)` is not a separate damage line; it is a modifier on a swing that was going to
land anyway. So:

* `directDamage` = the `slay` category total → **"damage on swings that procced Slay Undead"**.
  That is the honest label, and it is NOT "damage Slay Undead added".
* `marginalDamage` = `slayTotal − slayHits × meanMeleeHit(segment)`, carried in its own
  field so the assumption travels with the number, and rendered `~` with the tooltip
  *"assumes a Slay swing would otherwise have landed for your mean melee hit this segment."*
* PPM: `slayHits` per active minute, and per 100 swings — the latter being the interesting
  one (it is a proc rate against undead, and it is 0 against everything else, which is itself
  a finding the segment scope surfaces).

---

## 6. Public API surface

**No new IPC channel. No new `SnapshotOpts` flag.** Two reasons, one architectural and one
practical:

* `combat.snapshot()` is the single engine door that calls `evalClosure()`. A second
  entry point means a second closure path, and closure correctness is the most expensive
  thing in this engine to get wrong.
* `SnapshotOpts` / `useCombat.ts` / `engine.ts` are all claimed by the in-flight
  `overview-tab` plan. Riding `ProcsView` — which `BreakdownCard` already receives and
  passes to `ProcsBody` — reaches the renderer with **zero contended edits**.

So the whole feature travels as additive fields on the existing `combat:snapshot` payload:

```
combat:snapshot  →  CombatSnapshot.selected.procs.{ lanes, overall, states, attribution? }
```

Payload cost: `lanes` is ~10 rows; `states` is the spans overlapping ONE segment (a fight has
2–4; a zone session a few dozen); `attribution` is one row per tracked state and is present
only for zone selections. All bounded, none ring-derived.

`buildProcsView` moves out of `segmentViews.ts` into a new `src/main/combat/procViews.ts`,
leaving `segmentViews.ts` with a one-line import change — which also drops its line count,
helping the (currently EMPTY) lint ratchet stay empty.

---

## 7. Renderer surface

**Extend the Procs tab** (`ProcsPanel.tsx`, reached from `BreakdownCard.tsx`'s second grid
cell). Nothing else.

**HARD BOUNDARY — do not touch:** `CombatTimeline.tsx`, `TimelineChart.tsx`,
`timelineGeometry.ts`, `useTimelineViewport.ts`, `dpsChart.ts`, `CombatDashboard.tsx`,
`CombatView.tsx`, `useCombat.ts`. The first six are the in-flight
`graph-hover-tooltips` plan's surface; the last two belong to `overview-tab`. **No new
`TimelineMarkerKind`, no new marker, no chart change.**

Sections added to `ProcsBody`, in the order the questions get asked:

1. **RATES** — a header line above the existing lists: `18 procs · 4.1 ppm · 3.6 per 100
   swings`, with `ppm` tooltipped as active-time-normalized and the caveat from §4.2.
2. Per-lane rows gain a right-hand rate: `Smiting Strike ×214 · 4.0 ppm · 3.5/100`. Below
   the floors the cell is blank, never `0.0`.
3. **CONTRIBUTION** — `Condemnation of Nife · 231k · 4.6% of out · 41 dps` with a
   `measured` chip. Slay Undead's row carries `~` and its marginal figure.
4. **EFFECTS** (Overall scope only, when `attribution` is present) — one row per tracked
   state with its verdict chip (`measured` / `~estimate` / `no sample` / `not observable`),
   the delta as a range for estimates, and the confound list as small disabled text.

**UI-law compliance.** Chips convey STATE (`measured`, `~estimate`, `no sample`,
`not observable`, `exclusive`, `correlated`) — never methodology. The *why* lives in
Tooltips, exactly as the shipped `SlowHeadline` / `SlowRolling` already do. New formatter
`formatPpm` goes in `lib/formatRate.ts` (the ONE formatting source), producing `4.1 ppm`
— word after number, k/M scaling, and **no `/min`**, matching the no-`/s` sweep.

**Copy-out**: extend the Procs copy path. `copyText.ts` is already 490 lines against a
400-code-line ceiling with an EMPTY ratchet, so the proc half must be **extracted** to a new
`procsCopy.ts` rather than grown. Same risk on `ProcsPanel.tsx` (247) — split a
`ProcRates.tsx` if it crosses.

---

## 8. What the log cannot say (write this into the code, not just here)

1. **No stance or invocation bonus has a per-hit marker.** Offensive stance is +100% melee
   damage per the wiki and prints exactly one line in its entire life: the commit.
2. **A proc line never names its source.** `Smiting Strike` says nothing about which weapon,
   buff or AA produced it. Every source attribution in this feature is co-occurrence.
3. **Costs are not logged.** Spellblade consumes ~40% mana / 20% endurance per proc (wiki);
   the log carries neither, so no efficiency or DPS-per-mana claim is possible.
4. **Main-hand vs off-hand and double/triple attack remain undistinguishable**, so a
   per-swing proc rate is per-swing-as-logged.
5. **A permanent buff's end is usually unobserved** — 97 applies, 1 fade. Spans end
   `inferred` or `censored`, never a fabricated expiry.
6. **Item "shimmers briefly" lines are activations, not procs** (every sampled one is
   followed by `You begin casting`). Out of scope, deliberately.
7. **`Condemnation of Nife` has no wiki page and no `spells.json` record.** Its damage is
   known only from the log (flat 193/proc, 1,096 procs). Its proc RATE per swing is
   log-derived and gear-dependent; the app must not present it as a game constant.

---

## 9. Fixtures

Every window extracted through `tests/extract-combat-fixtures.mjs` + the shared scrub
(`tests/fixture-scrub.mjs` `scrubKeep`) — never a hand copy, never a re-implemented drop list.

| fixture | window | goldens |
|---|---|---|
| `w38-proc-ppm.log` | a dense melee grind under ONE stable invocation with `Smiting Strike` + `Condemnation of Nife` firing, ≥3 pulls | exact lane counts; `activeSec`; `ppmActive`; `ppmWall`; `per100Swings`; and the **absent-rate case** (a sub-10s pull reports `undefined`, not `0`) |
| `w39-spellblade-switch.log` | a `You begin reciting the spellblade invocation.` commit with swinging on BOTH sides, containing cast-less `Discordant Mind` / `Siphon Life` after and none before | `StateSpan` edges (`observed` start, prior span `inferred` end); the gem-1 lane's `ProcLink.strength === 'exclusive'`; **the window containing the switch is DISCARDED by the purity gate** |
| `w40-nife-buff.log` | `A brilliant blue aura surrounds your weapon.` then melee + `Condemnation of Nife` procs, with a later re-apply | buff span opens `observed`; the re-apply supersedes with `endEvidence: 'inferred'`; Tier A returns an exact number; **Tier B returns `insufficient-sample`** — this fixture is the honesty test and the one most worth hand-reading |
| `w41-slay-undead.log` | an undead pull carrying both `(Slay Undead)` and `(Riposte Slay Undead)` | slay category total **byte-identical** to today (tripwire); slay PPM; `marginalDamage` with its stated assumption |
| `w36-poison-slow-timing.log` | **existing** | add PPM assertions to `tests/combatPoisonWindows.test.mts` — no new fixture; poison procs are already modeled |
| `w37-dispel-variants.log` | **existing** | negative case: a fight before any coat must report empty proc lanes AND absent rates |

**Regression gate, every wave** (law 8's tripwire): baseline the full-log damage totals and
`Σ category.total == source.total` per source BEFORE, diff AFTER — **byte-identical**. This
feature is entirely additive indexes over damage already counted; if a total moves, the wave
is wrong.

---

## 10. Wave plan

**Overlap hazard is real and is the main constraint.** Two in-flight plans claim files this
feature would naturally touch:

| file | claimed by | our resolution |
|---|---|---|
| `src/shared/combat.ts` | `graph-hover-tooltips` **and** `overview-tab` | new `shared/procAnalytics.ts` holds everything; only **4 field lines + 1 import** land in `combat.ts` |
| `src/main/combat/segmentViews.ts` | `graph-hover-tooltips` | `buildProcsView` MOVES to a new `procViews.ts`; **1 import + 1 call site** change here |
| `src/main/combat/engine.ts`, `routing.ts`, `encounter.ts` | `overview-tab` | **not touched at all** — every hook goes in `ingest.ts` (unclaimed), constants in the new modules |
| `CombatDashboard.tsx`, `CombatTimeline.tsx` | `graph-hover-tooltips` | **not touched** |
| `CombatView.tsx`, `useCombat.ts`, `preload/index.ts` | `overview-tab` | **not touched** — this is why the feature rides `ProcsView` instead of a new snapshot opt |

### Wave 0 — integrator, ~15 minutes, no agent

Land `src/shared/procAnalytics.ts` (types only) and the 4-line `ProcsView` extension in
`shared/combat.ts`, with `lanes`/`overall`/`states` **optional at first** so the tree stays
buildable while waves 1–2 fill them (KEEP THE TREE BUILDABLE — create the file before the
import). Tighten to required in wave 2.

### Wave 1 — 2 agents, fully disjoint

**Agent A — state timeline + proc detection (main).**
Owns (new): `src/main/combat/stateTimeline.ts`, `src/main/combat/procDetect.ts`,
`src/main/combat/procWindows.ts`, `src/shared/procBuffs.ts`.
Owns (edit): `src/main/combat/state.ts`, `src/main/combat/ingest.ts`,
`src/main/combat/aggregate.ts`, `src/main/combat/procRouting.ts`.
Delivers: `StateSpan` ring + query fns + edge-evidence rules; `recentCasts` + the cast-less
detector (`spell` origin, gated to `dtype 'spell'` and `heal`, never `dot`); the `swings`
counter; the `WindowAccum` on `Agg`; `castBegin` / `buffWearOff` cases in the ingest switch.
No view changes, no serialization.

**Agent B — fixtures + goldens.**
Owns: `tests/extract-combat-fixtures.mjs`, `tests/fixtures/w38…w41*.log`,
`tests/combatProcRates.test.mts` (new), additions to `tests/combatPoisonWindows.test.mts`.
Delivers: the four new scrubbed windows with **hand-read** expected values off the clock, and
the baseline damage-total snapshot for the regression gate.

### Wave 2 — 1 agent

**Agent C — counterfactual + serialization.**
Owns (new): `src/main/combat/counterfactual.ts`, `src/main/combat/procViews.ts`.
Owns (edit, surgical): `src/main/combat/segmentViews.ts` (1 import + 1 call).
Delivers: eligibility gates, median/IQR statistic, the four verdicts, the confound detector,
`ProcLaneView` / `AttributionReport` assembly. Needs A's ledger and B's goldens.
**Re-read `segmentViews.ts` immediately before the edit** — `graph-hover-tooltips` may have
landed there first.

### Wave 3 — 1 agent

**Agent D — renderer.**
Owns (edit): `src/renderer/src/features/combat/ProcsPanel.tsx`, `BreakdownCard.tsx`,
`copyText.ts`, `src/renderer/src/lib/formatRate.ts`.
Owns (new, as needed for the line ceiling): `procsCopy.ts`, `ProcRates.tsx`.
Delivers: RATES / CONTRIBUTION / EFFECTS sections, verdict chips, tooltips, `formatPpm`,
copy-out.
**Constraints in the brief, verbatim:** the timeline chart boundary above; the ratchet is
EMPTY and must stay empty (`max-lines 400` on code lines, `max-lines-per-function 100`,
`complexity 12`, `max-params 4`) — `copyText.ts` is already at 490 raw lines, so EXTRACT,
never grow; adding a ratchet entry is the integrator's call, never an executor's.

### Verification per wave

`npm run typecheck` → `npm run lint` (with `EQ_LINT_NO_RATCHET=1` to confirm the true state)
→ `npm test` (full golden suite) → the damage-total regression diff. Waves 1–2 touch the
engine, so the byte-identical gate is mandatory for both. Wave 3 changed the renderer, so
`npm run test:e2e` runs before the commit.
