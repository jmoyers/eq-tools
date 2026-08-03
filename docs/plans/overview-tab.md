# Overview tab — design

Status: DESIGN ONLY. Nothing in `src/` is modified by this document.
Scope: the at-a-glance landing surface — current DPS (with a link down to Combat),
the mob you're fighting and its drops, your zone, and a recent-drops feed with
quest items highlighted. Maps and class-combo are OUT of scope; seams for them are
named at the end and nothing else.

Every claim below is grounded in the code as it exists today; file paths are absolute
where the wave briefs need them and repo-relative in prose.

---

## 0. The one decision

**Overview is a RENDERER-SIDE COMPOSITION over existing module snapshots + the combat
engine's pull-snapshot. It is NOT a new `EqModule`.**

The only main-process change in the entire feature is one additive, read-only field on
`CombatSnapshot` (`currentTarget`), because the fact the product owner asked for — "the
mob you're currently fighting" — lives inside the combat engine's `Encounter` and has no
public door today.

### Why not a module

| Requirement | Where the state already lives | Owner |
|---|---|---|
| Current DPS | `CombatSnapshot.selected` (`SegmentView.outDps`), `segments` | `CombatEngine` (`src/main/combat/engine.ts`) |
| Current mob | `Encounter.lastOutTarget` (`src/main/combat/encounter.ts:98`) | `CombatEngine` |
| Its drops | `lookupMob(name)` → `MobKnowledge` (7,866-mob catalog + own-loot + quests + wiki fallback) | `src/main/mobLookup.ts`, exposed as `IPC.mobsLookup` |
| Current zone | `CharacterSnap.zone` | `CharacterModule` (`src/main/modules/character.ts`) |
| Recent drops | `LootSnap = LootEvent[]` | `LootModule` (`src/main/modules/loot.ts`) |
| Quest-item highlight | `questItemNames` (posky, local+instant) + `ItemKnowledge` via `IPC.itemsLookup` | `features/loot/lootItemData.ts`, `src/main/itemLookup.ts` |

An `OverviewModule` would have to **re-fold the same events** into a second copy of state
that four existing owners already hold — the exact "aggregates lie; derive from identities"
failure mode (law 5), and a guaranteed source of drift (two zone trackers, two loot rings).

Worse, it *cannot* answer requirement 1 or 2 at all. `CombatEngine` is deliberately **not**
registered with `ModuleRegistry` — `src/main/modules/types.ts:15-20` documents it as the one
intentional transport exception (pull `combat:snapshot` + `combat:activity` nudge). A module
subscribed to the bus would have to re-implement encounter segmentation, attribution and
naming to know what fight is open and who you're swinging at. That is the whole engine.

So the composition is:

```
OverviewView
  ├── useOverviewCombat()   → window.eq.getCombatSnapshot({timeline:false, maxSegments:1})
  │                           (pull + `combat:activity` nudge — the SAME transport useCombat uses)
  ├── useModule('character')→ { character, zone }         (delta transport)
  ├── useModule('loot')     → LootEvent[]                 (delta transport)
  ├── useModule('consider') → ConsiderRow[]  (OPTIONAL — paint-instantly seed for the mob card)
  ├── window.eq.lookupMob(name)   → MobKnowledge          (cache-first, local-first, never rejects)
  └── window.eq.lookupItem(name)  → ItemKnowledge         (via the existing useNotablePickups hook)
```

Zero new state. Zero new IPC channels. One new snapshot field.

### Cost check (why a second combat poller is free)

`ViewContent` in `src/renderer/src/App.tsx` renders exactly one feature view at a time —
`{view === 'combat' && <CombatView/>}`. So Overview and Combat are never mounted together
and there is never a second concurrent `combat:snapshot` poller. Overview's poll is also
strictly cheaper than the Combat tab's: `timeline: false` skips `buildTimeline()`, and
`maxSegments: 1` caps the finalized-summary array (the current encounter and the zone
summary are always included regardless — `engine.ts:82-92`).

---

## 1. Data model

### 1.1 The one main-side addition — `CombatSnapshot.currentTarget`

Law 6 states the live-fight naming rule: *a LIVE fight is named after the CURRENT target
(most recent outgoing target — the mob in front of you)*; on finalize it switches to the
largest target. That rule is implemented by `encounterName(e, live)`
(`src/main/combat/encounter.ts:229-237`) reading `Encounter.lastOutTarget`, which is
stamped in `src/main/combat/routing.ts:128`.

The renderer can see the *composed* name today (`SegmentSummary.name` /
`SegmentView.name` for the `kind: 'current'` entry) but that string is
`` `${lastOutTarget}${suffix}` `` — it carries a `+N` suffix. Regex-stripping a mob name back
out of a display string to feed it to `lookupMob` is exactly the kind of parse-your-own-output
hack this repo avoids (and `+N` handling already caused a special case in the e2e's search
step, `tests/e2e/combat-dashboard.e2e.mts:432`). So: expose the fact, not the sentence.

```ts
// src/shared/combat.ts (NEW)

/**
 * The mob you are presently swinging at — the LIVE half of world-model law 6's fight
 * naming rule, exposed as a FACT rather than as the composed encounter name.
 *
 * Present only while an encounter is OPEN and at least one outgoing hit has landed in it
 * (`Encounter.lastOutTarget` is undefined before the first one). It is deliberately not
 * derived from `SegmentSummary.name`: that string is `<target>+N`, and a mob lookup needs
 * the raw name (law 2 — canonicalize at boundaries, display raw).
 */
export interface CurrentTarget {
  /** RAW display name of the most recent outgoing-damage target. */
  name: string
  /** How many OTHER distinct targets this encounter has engaged (the name's '+N'). */
  others: number
  /** epoch ms of the encounter's last attributed damage — freshness for the UI's wording. */
  lastTs: number
}

export interface CombatSnapshot {
  // …existing fields unchanged…
  /** The mob in front of you, while a fight is open. Absent between pulls (law 1). */
  currentTarget?: CurrentTarget
}
```

Engine side (`src/main/combat/engine.ts`), a public accessor beside the existing
`charmedPetNames()` / `petDisplayNames()` doors, wired into `snapshot()`:

```ts
/**
 * The mob in front of you (law 6, LIVE half). Undefined when no encounter is open or when
 * the open encounter has not yet landed an outgoing hit — never a guess, never the largest
 * target (that is the FINALIZED naming rule and would relabel a live pull retroactively).
 */
currentTarget(): CurrentTarget | undefined {
  const e = this.st.current
  if (!e?.lastOutTarget) return undefined
  return { name: e.lastOutTarget, others: Math.max(0, e.agg.targets.size - 1), lastTs: e.lastTs }
}
```

`snapshot()` adds `currentTarget: this.currentTarget()` after the existing `evalClosure()`
call, so a fight that just closed on elapsed time correctly reports nothing.

Additive and optional ⇒ no store migration (nothing here is persisted), no wire-compat
concern (the snapshot is rebuilt every pull), and every existing consumer is untouched.

**Regression gate (law 8's tripwire):** this touches `engine.ts snapshot()`. Baseline the
damage totals before the change and diff after — they must be byte-identical. Nothing in
this accessor mutates state.

### 1.2 Renderer view models (`features/overview/overviewData.ts`, pure)

```ts
/** One row of the recent-drops feed. Built from a LootEvent joined with what we know. */
export interface DropRow {
  /** stable React key — `${ts}|${key}|${i}` (two identical loots can share a timestamp). */
  id: string
  ts: number
  /** RAW item name exactly as looted, `+N` intact (law 2 — display raw). */
  item: string
  /** `itemCountKey(item)` — the counting/knowledge key, `+N` stripped, lowercased. */
  key: string
  /** the corpse it came off, when the line named one. */
  source?: string
  zone?: string
  /** stack size when the line named one; undefined = 1. */
  count?: number
  /** currency / hoard / depot / sold / combined, when the line routed it. */
  disposition?: LootDisposition
  /** Plane of Sky turn-in item — LOCAL, instant, offline (`questItemNames`). */
  posky: boolean
  /** async item knowledge; absent until the probe lands. NEVER filled in to mean "checked". */
  knowledge?: ItemKnowledge
  /** the ONE highlight predicate — see `isHighlighted` below. */
  highlighted: boolean
}

/** How many rows the feed renders. */
export const DROP_FEED_CAP = 25
```

```ts
/**
 * THE highlight rule, in one place.
 *
 *   posky            → a Plane of Sky turn-in item. Local, instant, offline, certain.
 *   notable knowledge→ lore / QUEST ITEM flag / used by a known quest
 *                      (`isNotableKnowledge`, shared/itemKnowledge.ts — the same predicate
 *                       the loot tab's pickups strip and the main-side event feed use).
 *   MINUS tradeskill-only → an item whose stats block says QUEST ITEM but which no quest
 *                      anywhere uses is a recipe component (`isTradeskillOnly`). Every bone
 *                      chip and spider leg in the game trips the flag; highlighting them
 *                      drowns the one coin that actually starts a quest. The row still
 *                      SHOWS — only the highlight is withheld. This mirrors the events
 *                      overlay (unconditional filter) and the loot strip (default-off
 *                      toggle) without inventing a third rule.
 */
export function isHighlighted(posky: boolean, k?: ItemKnowledge): boolean {
  if (posky) return true
  if (!k) return false
  return isNotableKnowledge(k) && !isTradeskillOnly(k)
}
```

`buildDropRows(history: LootEvent[], knowledgeByKey: Map<string, ItemKnowledge>): DropRow[]`
— take the last `DROP_FEED_CAP` events (the loot module serves oldest→newest), reverse to
newest-first, join `questItemNames` + `knowledgeByKey`. Pure, single pass, node-testable.

**Import discipline:** `overviewData.ts` is unit-tested by `node --import tsx --test`, which
has no `@shared` alias. Its VALUE imports (`isNotableKnowledge`) must be relative
(`../../../../shared/itemKnowledge`); type-only imports may keep the alias (they're erased).
This is the exact precedent `features/mobs/mobSearch.ts:33` documents.

### 1.3 Current-target view model

```ts
export interface CurrentMobState {
  /** the mob, or undefined when no fight is open / nothing has been hit yet. */
  target?: CurrentTarget
  /** true while the fight naming it is still OPEN (`segments.some(s => s.kind === 'current')`). */
  live: boolean
  /** drops etc. Absent until the lookup lands — never a fabricated record (law 1). */
  knowledge?: MobKnowledge
  loading: boolean
}
```

---

## 2. Public API surface (the library-first view)

Everything the feature adds, in one table. Nothing else changes shape.

| Surface | Kind | Where |
|---|---|---|
| `CurrentTarget` | type | `src/shared/combat.ts` |
| `CombatSnapshot.currentTarget?: CurrentTarget` | field (additive, optional) | `src/shared/combat.ts` |
| `CombatEngine.currentTarget()` | method | `src/main/combat/engine.ts` |
| `View` gains `'overview'`; `KNOWN_VIEWS` gains it | union | `src/renderer/src/appViews.ts` |
| `CombatFocus` | type | `src/renderer/src/features/combat/combatFocus.ts` (NEW) |
| `useCombat().focusFight(f: CombatFocus)` | method on the hook's return | `src/renderer/src/features/combat/useCombat.ts` |
| `CombatView` props `{ focus?, focusNonce?, onFocusConsumed? }` | props | `src/renderer/src/features/combat/CombatView.tsx` |
| `features/overview/*` | new dir | see §6 |

**No new IPC channels.** `IPC.getCombatSnapshot`, `IPC.getModuleSnapshot`, `IPC.onModuleDelta`,
`IPC.onCombatActivity`, `IPC.itemsLookup`, `IPC.mobsLookup` all already exist and are already
on the preload bridge (`src/preload/index.ts`).

---

## 3. Requirement-by-requirement

### 3.1 Current DPS, less detail, links down to Combat

**Data.** One poll of `window.eq.getCombatSnapshot({ combinePets: false, timeline: false,
maxSegments: 1 })` — no `selectedId`, so `resolveSelectedId()` (`engine.ts:108`) returns the
default: the open fight, else the most recent finalized fight. That is *by construction* the
same subject the Combat tab's Fight-scope head row shows.

**Labelling — reuse, don't re-derive.** `fightScopeOptions(snap.segments)` from
`features/combat/dashboardData.ts:545` already produces the honest head-row wording:
`'Current fight (live)'` while a pull is open, `` `Last fight — ${name}` `` between pulls.
Overview uses `head.label` verbatim. This is law: `scopeOptions()` is "the ONE place a scope
decides what may be listed", and a second copy of the live/last wording would be exactly the
drift that rule exists to prevent.

**What it shows (deliberately less than the Combat tab):**
- head-row label (above),
- one headline number: `formatRate(seg.outDps)` — `21.7k dps`,
- one supporting line: `formatNum(seg.outTotal)` total · `durationSec` · `formatRate(seg.activeDps)` active,
- top **3** source rows only (name + `formatRate(row.dps)` + a bar), from `seg.entities`.

No scope toggle, no fight selector, no drill-down, no timeline, no Outgoing/Incoming switch,
no combat log. If the user wants any of those, that is what the link is for.

**Empty state.** No fights at all ⇒ `snap.selected === null` ⇒ the same honest quiet state
the Combat tab shows, never borrowed zone data (`ScopeEmptyPane` precedent, `CombatView.tsx:140`).

**The link down.** See §5.

### 3.2 Current mob and its drops

**Identity.** `snap.currentTarget` (§1.1). `live = snap.segments.some(s => s.kind === 'current')`.
Between pulls the card reads "Last target — X" rather than pretending you're still fighting,
the same honesty rule the fight head row follows.

**Drops.** `window.eq.lookupMob(target.name)` → `MobKnowledge`. Main is local-first three
times over before it ever considers the network (`src/main/mobLookup.ts:8-28`): the committed
7,866-entry catalog (`data/eqlegends/mobs.json`, the definitive drop table), your own loot
history (`MobLootIndex`, `dropsSeen`), and the quest catalog's `relatedNpcs`. The live wiki
lookup is the fallback only, behind a serialized 150ms-spaced queue with Retry-After
cooldowns and a persistent cache. `lookupMob` never rejects.

**Seed for instant paint.** If the mob is in the `consider` module's ring
(`useModule('consider')`), that row's `knowledge` is already enriched — use it as the initial
value while the refresh lands. Exactly what `MobTarget.seed` does for `MobPage`
(`features/mobs/mobTarget.ts:36`, `MobPage.tsx:62`).

**Rendering.** Card shows: mob name (+`others > 0` ⇒ `+N` chip), `levelText` / `zone` when the
source states them, then the drop list — `dropsWiki` leading, each row annotated with
`dropsSeen` ("seen by you: 3× · last Aug 1"), capped at ~8 rows with a "+N more" that routes
to the Mobs tab's `MobPage` (see §5). Reuse `features/mobs/MobDropRow.tsx`'s `DropRow` if it
composes cleanly; if it drags in the item drill-down machinery, render a leaner local row and
leave `MobPage` as the full surface. **Do not fork the empty states** — the three distinct
facts `MobPage.DropsEmptyState` distinguishes (still looking up / no wiki page / page lists no
loot / offline) are law-1 requirements, not decoration.

**RATE-LIMIT RISK — read this before implementing.** `lastOutTarget` is re-stamped on *every*
outgoing hit (`routing.ts:128`), so in a multi-mob pull it flips between mobs several times a
second. A naive `useEffect(..., [target.name])` would issue a `lookupMob` per swing. Required
mitigations, all three:
1. **Key on the canonical name**, not the raw one: `name.trim().toLowerCase()` (equivalent to
   main's `mobKey` for this purpose — `mobLookupParse.ts:59` additionally folds backtick
   variants and whitespace runs; moving `mobKey` to `src/shared/` is a clean future seam, not
   part of this work).
2. **Debounce ~750ms** on key change, so mid-pull target flapping resolves to one lookup.
3. **Memoize per key for the component's life** in a `useRef<Map<string, MobKnowledge>>`, the
   same `requested`-set discipline `useNotablePickups.ts:54` uses.

Scraper etiquette is a LAW here (AGENTS.md → Data sources), and a card that re-asks on every
swing would violate it even though the catalog answers most calls offline.

### 3.3 Current zone

Lives in **`CharacterModule`** (`src/main/modules/character.ts`), fed by the `zone` LogEvent
(`You have entered X.`), with pseudo-zone rejection and instance-tier suffix handling done at
parse time in `src/main/log/parseWorld.ts` (`ZONE_RE`, `zoneTier`). Exposed as
`CharacterSnap { character, zone }` over the ordinary module transport:

```ts
const who = useModule<CharacterSnap, CharacterDelta>('character', (s, d) => ({ ...s, ...d }))
```

`CombatSnapshot.zone` is the engine's own copy of the same fact — same source, but the
character module is the designated "who am I / where am I" owner and comes with delta pushes
rather than a poll. Use the module.

**Display the RAW zone string** (law 2). The instance-tier decoder `zoneTier()` lives in
`src/main/log/parseWorld.ts` and is main-only; the renderer must not import from `src/main`,
and must not re-implement it. A tier chip on the zone is a clean follow-up that starts by
moving `zoneTier`/`TIER_LABELS` into `src/shared/` — explicitly **not** done here.

### 3.4 Recent drops feed with quest items highlighted

**The existing feature this mirrors.** The "event log" the owner referred to is
`src/renderer/src/overlay/EventLogOverlay.tsx` — the `'events'` **overlay kind**, backed by
the main-side `EventFeedModule` (`src/main/modules/eventFeed.ts`). Note carefully: *it is an
overlay window, not a tab.* Its loot rows are LIVE-ONLY by design (the module returns early
when `live` is false, `eventFeed.ts:95`) so opening it never spams hours of replayed history.

**Overview's feed is deliberately different, and that difference is the point.** The Overview
is a landing surface you open *after* the app has read your log; a feed that is empty until
something happens next would be a blank card. So Overview reads the **`loot` module**, whose
snapshot IS the full history, and renders the newest `DROP_FEED_CAP` rows. It is a *recent
drops* list (history, newest-first), not a live event stream. Both are honest; they answer
different questions, and neither duplicates the other's state.

**Events.** `useModule<LootSnap, LootDelta>('loot', (s, d) => [...s, ...d.appended])`. The
loot family is the sole item-into-inventory line family (law 6) — dashed loot lines, currency,
sold, combined — and `LootEvent` already carries `disposition`, `count`, `created`, `zone`.

Note `useProgress()` (`features/posky/useProgress.ts`) already owns a loot subscription and
`LootView` reads its `lootHistory` rather than holding a second copy. If `useProgress` is
cheap to mount here, prefer it for the same reason; otherwise a direct `useModule('loot')` is
fine — `useModule` is idempotent per subscriber and the snapshot is served from memory.

**How many to keep.** Render 25 (`DROP_FEED_CAP`). Rationale: it is a glance surface; the
Loot tab is the ledger. It is also comfortably inside `useNotablePickups`' `PROBE_LIMIT = 40`
*distinct* items, so every rendered row's knowledge is guaranteed to be probed — no row can
sit permanently un-highlighted for lack of a lookup.

**Highlight source (two, layered):**
1. **`questItemNames`** (`features/loot/lootItemData.ts`) — the posky dataset's turn-in items,
   keyed by `itemCountKey` so `Sphinx Claw +1` still recognizes. Local, synchronous, offline,
   available on the very first render.
2. **`ItemKnowledge`** via `useNotablePickups(history, EMPTY_SET)` — returns `byKey`, a live
   map of `itemCountKey → ItemKnowledge` built by bounded, memoized, cache-first
   `window.eq.lookupItem` probes. This is the same hook the Loot tab uses, so the Overview and
   the Loot tab can never disagree about what is notable.

The combined predicate is `isHighlighted()` (§1.2). A row whose probe hasn't landed renders
un-highlighted and *upgrades in place* when it does — never a flicker of a wrong claim, and
never a "we checked, it's nothing" implication for an item we haven't checked.

**Icons.** `knowledge?.iconId` ⇒ `itemIconUrl(iconId)` from `src/renderer/src/lib/ItemWindow.tsx:55`,
which returns `eqimg://item/<id>`. That is the ONE renderer entry point for item icons; it is
served by `src/main/imageCache.ts` from a permanent on-disk cache. **Never write a raw
`https://` `<img src>`** — `img-src` in `index.html` is exactly `'self' data: eqimg:` precisely
so that mistake fails visibly. Keep the `<img onError>` hide: a negative is never cached, so
the next load retries. Icons are absent for posky-only knowledge (`iconId` comes from the wiki
item page) — render the row without one, do not fabricate a placeholder id.

**Hover.** Reuse `lib/KnownItemTooltip.tsx` (the EQ-style item window) exactly as
`NotablePickupsStrip` does; clicking a row can open `features/loot/ItemDetailDialog` or route
to the Loot tab. Pick one and state it in the wave brief; routing to Loot is preferred —
Overview is a glance.

---

## 4. Hydration

`CombatSnapshot.hydrating` is true until the Tailer's live handoff (`EngineState.setLive()`).
During that window every snapshot describes the PAST — an hours-old fight is `current` and a
mob you killed at lunch is `currentTarget`. AGENTS.md ("Hydration is a state, and the UI must
show it") makes the quiet placeholder mandatory, and `CombatView`'s `HydratingPanel`
(`CombatView.tsx:43`) is the reference implementation (`data-testid="combat-hydrating"`,
`<CircularProgress size={13}>` + "Reading log…" + skeleton rows).

**Gate:** the **Now** row — DPS card, current-mob card, zone chip — renders
`<OverviewHydrating/>` while `snap?.hydrating ?? true` (null snapshot reads the same way:
"we're not ready"). The **recent-drops** card is NOT gated: it is explicitly a history
surface, the loot module's snapshot is complete and correct during replay, and a spinner over
a list of real past drops would be a lie in the other direction.

Reuse the same visual language and give it its own testid `overview-hydrating`.

---

## 5. Cross-tab navigation

### 5.1 How tabs work today

`src/renderer/src/App.tsx` holds `const [view, setView] = useState<View>(loadView)`. `View` is
the closed union in `appViews.ts`; `NavDrawer` takes `{view, onSelect}`; `ViewContent` is a
switch that mounts exactly one feature view; the choice is persisted to `localStorage['eq.view']`.

There is one existing deep-link precedent, Task #64's mob routing (`App.tsx:228-239`):

```ts
const [mobTarget, setMobTarget] = useState<MobTarget | null>(null)
const [mobNonce, setMobNonce] = useState(0)
const openMob = (t) => { setMobTarget(t); setMobNonce(n => n + 1); setView('mobs') }
```
…with `MobsView` applying the target in a `useEffect` keyed on the **nonce** (so asking for
the same mob twice opens it twice) and calling `onTargetConsumed()` so a stale target can't
re-open later. There is also a cross-*window* deep link (`AppFocus` / `IPC.focusView`) from the
overlays, whose `AppFocusView` union is deliberately closed.

### 5.2 The minimal navigation API

Mirror the mob pattern exactly. One new dependency-light file, symmetric with
`features/mobs/mobTarget.ts`:

```ts
// src/renderer/src/features/combat/combatFocus.ts  (NEW)

/**
 * "Open the Combat tab on this." The payload another tab hands the combat view.
 *
 * `selection` is a value the combat SELECTOR understands: the `LIVE_SELECTION` sentinel
 * ('__live__') for the fight scope's head row — which re-resolves every tick, so it follows
 * you from the open pull into the next one — or a concrete segment id ('e<n>' / 'zone' /
 * 'zs<n>'). Overview always sends the sentinel: its DPS card IS the head row, by construction
 * (both resolve through `fightScopeOptions`).
 */
export interface CombatFocus {
  scope: CombatScope       // type-only import from './dashboardData'
  selection: string
}
```

`App.tsx` gains, verbatim in the shape of the mob triple:

```ts
const [combatFocus, setCombatFocus] = useState<CombatFocus | null>(null)
const [combatNonce, setCombatNonce] = useState(0)
const openCombat = (f: CombatFocus): void => {
  setCombatFocus(f); setCombatNonce(n => n + 1); setView('combat')
}
```

`ViewContent` passes `{focus, focusNonce, onFocusConsumed}` to `CombatView`, which applies it
in a `useEffect` keyed on the nonce.

`useCombat` gains one method on its return object:

```ts
/**
 * Jump to an explicit scope + selection (a deep link from another tab). Distinct from
 * `setScope`, which deliberately resets the selection to that scope's head row: here the
 * caller has already decided what it wants selected. The scope is persisted, exactly as a
 * manual scope change is — arriving via "see this fight in Combat" is a real scope choice.
 */
focusFight: (f: CombatFocus) => void
```

Implementation is three lines: `setScopeState(f.scope)`, `localStorage.setItem(SCOPE_KEY, f.scope)`,
`setSelection(f.selection)`.

**Why not just an initial value?** Because CombatView unmounts when you leave the tab, an
initial value would cover Overview→Combat — but the nonce path is what makes a *second*
link-down work while you're already on Combat, and future surfaces (the fight-search results,
an overlay row) will want that. The one-tick flash before the effect lands is invisible: the
first snapshot poll hasn't resolved yet either.

### 5.3 The three links Overview offers

| Affordance | Action |
|---|---|
| DPS card → "Open in Combat" | `openCombat({ scope: 'fight', selection: LIVE_SELECTION })` |
| Mob card → "+N more drops" / mob name | `openMob({ mob: target.name, seed: knowledge })` — the existing app-level router, unchanged |
| Drops feed → "All loot" | `setView('loot')` |

**On the event log:** there is no event-log *tab* to link to — it is the `'events'` overlay
kind. If a link is wanted, it is `void window.eq.toggleOverlay('events')` (already on the
preload bridge, `preload/index.ts:261`), which opens the floating window. Recommend a small
secondary affordance on the drops card, or nothing at all in v1; the *tab* destination for
"more drops" is Loot.

### 5.4 Should Overview be the default view?

Product-wise, "at-a-glance landing surface" says yes: `DEFAULT_VIEW = 'overview'`.

**This is a real regression risk and must be sequenced.** `tests/e2e/combat-dashboard.e2e.mts:553`
opens the app with a fresh `userData` (so `localStorage['eq.view']` is empty ⇒ `DEFAULT_VIEW`)
and immediately does `page.waitForSelector('[data-testid="segment-select"]')`. Flipping the
default lands the app on Overview and that wait times out — the whole e2e suite goes red.

**Sequencing rule: the `DEFAULT_VIEW` flip and the e2e's new "click Combat in the nav first"
step ship in the SAME commit (wave 3).** Waves 1–2 leave `DEFAULT_VIEW = 'combat'`.

Also required in `appViews.ts`: add `'overview'` to `KNOWN_VIEWS`, or `loadView()` silently
bounces every returning Overview user to the default (`appViews.ts:36`).

---

## 6. Renderer component structure

```
src/renderer/src/features/overview/
  OverviewView.tsx        default export; the grid, the hydration gate, the nav callbacks
  overviewData.ts         PURE: DropRow, DROP_FEED_CAP, isHighlighted, buildDropRows   (node-tested)
  useOverviewCombat.ts    the lite combat poll (snapshot + `combat:activity` nudge + 1s fallback)
  useCurrentMob.ts        currentTarget → MobKnowledge (debounce + per-key memo + consider seed)
  useRecentDrops.ts       loot module + useNotablePickups + questItemNames → DropRow[]
  DpsCard.tsx             head-row label, headline rate, top-3 sources, "Open in Combat"
  CurrentMobCard.tsx      identity, level/zone, drop list, "open mob page"
  RecentDropsCard.tsx     the FIXED-HEIGHT feed
  ZoneStrip.tsx           character + zone + in-combat state (thin; may fold into OverviewView)
```

### Conventions this feature is bound by (AGENTS.md "UI conventions" — law)

- **MUI**, like every sibling view (`Paper variant="outlined"`, `Stack`, `Chip`, `Typography`).
  The MUI-free rule applies only to the overlay bundle.
- **Formatting through the single sources.** Rates and totals via
  `lib/formatRate` (`formatRate` / `formatNum`) — the word `dps` after the number, k/M scaling,
  **no `/s` anywhere**. Dates/times via `lib/formatDate` (`formatDate` / `formatTime` /
  `formatDateTime`, user-local). No `toFixed` on a rate, no `toLocaleTimeString`, no epoch math.
- **A growing list lives in a FIXED-height scroll box.** The drops feed and the mob card's drop
  list each get an explicit height (~240–280px) plus their own `overflow: 'auto'`. The panel
  that must survive gets `flexGrow: 1` + `minHeight: 0`. This is the exact bug (Task #56) the
  e2e harness exists to catch, and it will catch it again.
- **State, never process.** Chips say `live` / `last` / `posky` / `lore`. No "we're looking this
  up on the wiki" narration beyond the one quiet "Looking up this mob…" the mob card inherits
  from `MobPage`'s precedent.
- **Layout.** A 2-column responsive grid, `gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'repeat(2, minmax(0,1fr))' }`,
  every child `minWidth: 0, minHeight: 0`, following `CombatView`'s `DashboardGrid`
  (`CombatView.tsx:96-112`) — `minmax(0, 1fr)` is the load-bearing part: it lets a track shrink
  below its content so no card can dictate the grid's size. The app content area is already
  `overflow: 'auto'` (`App.tsx:315`), so `height: '100%'` clamps nothing on its own.
- **Lint budget for new files.** No ratchet entries (adding one is the integrator's call, never
  an executor's): `max-lines 400`, `max-lines-per-function 100`, `complexity 12`, `max-depth 3`,
  `max-params 4`. Every component takes ONE object prop, as the siblings do.
- **`data-testid` on every asserted node** (see §8).

### Seams for later (named, not designed)

- **Adding a card = adding one file + one grid cell.** Each card owns its own hook and asks for
  its own data; `OverviewView` composes and routes. A `MapCard` or `ClassComboCard` needs no
  change to any other file — this is the whole reason the cards are separate components with
  separate hooks rather than one `useOverview()` god-hook.
- **Zone tier chip** ⇒ move `zoneTier` / `TIER_LABELS` from `src/main/log/parseWorld.ts` to
  `src/shared/` first (it is pure), then `lib/tierChip.ts` renders it. Not done here.
- **`mobKey` in `src/shared/`** ⇒ would let the renderer key mobs identically to main. Today the
  renderer's `trim().toLowerCase()` memo key is adequate because it only dedupes lookups.
- **A `nav` object** if a fourth destination appears. Three (`setView`, `openMob`, `openCombat`)
  do not justify an abstraction yet.

---

## 7. Wave plan

Disjoint file ownership per wave; the integrator commits per wave and runs the gauntlet
between them. "Keep the tree buildable" is in force throughout: create any file you import
before writing the import.

### Wave 1 — two agents, parallel, disjoint

**Agent 1A — main + shared: the `currentTarget` accessor.**
- Owns: `src/shared/combat.ts`, `src/main/combat/engine.ts`, `tests/combatCurrentTarget.test.mts` (new).
- Add `CurrentTarget`; add optional `currentTarget` to `CombatSnapshot`; add
  `CombatEngine.currentTarget()`; wire it into `snapshot()`.
- Test: drive the engine over a fixture with a multi-mob pull; assert
  `currentTarget.name` is the MOST RECENT outgoing target (not the largest), `others` equals
  distinct-targets − 1, and that it is `undefined` once the encounter finalizes. Extract the
  fixture through `tests/fixture-scrub.mjs` (`scrubKeep`) — never hand-copy a log span. If an
  existing combat fixture already contains a multi-mob pull, reuse it.
- **Regression gate:** baseline damage totals before, diff after — byte-identical.

**Agent 1B — renderer shell + navigation.**
- Owns: `src/renderer/src/appViews.ts`, `src/renderer/src/components/NavDrawer.tsx`,
  `src/renderer/src/App.tsx`, `src/renderer/src/features/combat/combatFocus.ts` (new),
  `src/renderer/src/features/combat/useCombat.ts`, `src/renderer/src/features/combat/CombatView.tsx`,
  `src/renderer/src/features/overview/OverviewView.tsx` (**stub only**).
- `appViews.ts`: add `'overview'` to `View` and `KNOWN_VIEWS`. **Leave `DEFAULT_VIEW = 'combat'`.**
- `NavDrawer`: add the Overview row FIRST in the list, with an icon
  (`DashboardIcon` / `SpaceDashboardIcon`), and add `data-testid={'nav-' + v}` to **every**
  `ListItemButton` (the e2e needs a stable nav handle; today there is none).
- `App.tsx`: `combatFocus` + `combatNonce` + `openCombat`; render `<OverviewView …/>` in
  `ViewContent`; thread the focus props into `<CombatView/>`.
- `combatFocus.ts`, `useCombat.focusFight`, `CombatView` focus props (§5.2).
- The **stub** `OverviewView.tsx` is a minimal MUI placeholder taking the real props, so main
  compiles from this agent's first edit onward. Wave 2 replaces it.
- Note for the agent: `App.tsx` and `CombatView.tsx` are shared-ish files — re-read immediately
  before each surgical edit (AGENTS.md, concurrent agents).

### Wave 2 — one or two agents over `features/overview/**` only

Nothing outside that directory is touched. Split only if the brief runs long:

**Agent 2A — data (`overviewData.ts`, `useOverviewCombat.ts`, `useCurrentMob.ts`, `useRecentDrops.ts`)**
plus `tests/overviewData.test.mts`. The integrator writes the exact exported signatures into
the brief (§1.2, §1.3) so 2B can code against them without waiting.

**Agent 2B — presentation (`OverviewView.tsx`, `DpsCard.tsx`, `CurrentMobCard.tsx`,
`RecentDropsCard.tsx`, `ZoneStrip.tsx`)**, consuming those signatures.

If run as one agent, same file set, same order (data first).

Hard requirements for the brief: the debounce+memo rule (§3.2), the fixed-height law (§6),
`formatRate`/`formatDate` only, `eqimg://` icons only, the hydration gate (§4), relative VALUE
imports in `overviewData.ts` (§1.2), and every `data-testid` in §8.

### Wave 3 — one agent: default view + e2e

- Owns: `src/renderer/src/appViews.ts` (`DEFAULT_VIEW = 'overview'` — the ONE line),
  `tests/e2e/overview.e2e.mts` (new), `tests/e2e/combat-dashboard.e2e.mts` (one added nav step),
  `package.json` (`test:e2e` script), `tests/e2e/appHarness.mts` (only if a shared helper is
  genuinely needed).
- `combat-dashboard.e2e.mts`: before the existing `waitForSelector('[data-testid="segment-select"]')`,
  click `[data-testid="nav-combat"]`. One added step — do **not** grow that file further;
  it is near the `max-lines 400` (code-lines) budget, which is why the Overview assertions go
  in their own file.
- `package.json`: `"test:e2e": "node --import tsx tests/e2e/combat-dashboard.e2e.mts && node --import tsx tests/e2e/overview.e2e.mts"`.

---

## 8. Verification

Per wave: `npm run typecheck` (node + web) → `npm run lint` (**must be green with ZERO new
ratchet entries**; check the true state with `EQ_LINT_NO_RATCHET=1 npx eslint .`) → `npm test`
(full golden-window suite) → `npm run test:e2e` when main or renderer changed. Wave 1A
additionally runs the byte-identical damage-total regression gate.

### `data-testid` contract (wave 2 must emit these; wave 3 asserts them)

`overview-grid`, `overview-hydrating`, `overview-dps`, `overview-dps-label`,
`overview-open-combat`, `overview-mob`, `overview-mob-name`, `overview-zone`,
`overview-drops`, `overview-drop-row`, `overview-drop-highlight`, plus `nav-<view>` on every
nav row (wave 1B).

### Recommended e2e assertions — `tests/e2e/overview.e2e.mts`

Floors and identities only; never "today's numbers" (frozen numbers rot).

1. **Land on Overview.** With a fresh `userData` the default view is Overview (post-wave-3);
   assert `[data-testid="overview-grid"]` mounts within the launch timeout.
2. **Hydration is shown, then completes.** Poll `snapshot(page)` until `!hydrating` (reuse
   `HYDRATE_TIMEOUT_MS`); assert `overview-hydrating` was observed at least once *or* the
   replay finished too fast to see — the exact convention `stepHydration` uses today.
3. **The grid has real height** — `rectOf('[data-testid="overview-grid"]').h >= 200`. The
   Task-#56 regression, re-asserted on the new surface.
4. **The DPS card states a rate or an honest empty state.** If `snap.selected!.outTotal > 0`
   then `overview-dps` matches `/\d.*dps/i` and contains **no** `/s`; else note it (a freshly
   zoned player legitimately has nothing).
5. **The head-row label agrees with the engine.** If `snap.segments.some(kind === 'current')`
   then `overview-dps-label` contains `live`; else it contains `Last fight`. Identity, not value.
6. **The zone is stated when known.** `snap.zone` set ⇒ `overview-zone` text is non-empty and
   contains it.
7. **The current mob agrees with the snapshot.** `snap.currentTarget` present ⇒
   `overview-mob-name` contains `snap.currentTarget.name`; absent ⇒ the card shows its quiet
   state and asserts no mob name. (Note this one runs against a live log; if no fight is open
   during the run, `note()` it rather than failing — the step-8 convention.)
8. **The drops feed is a BOUNDED scroll box** — `overview-drops` has `h > 0 && h <= 320`, and
   `scrollHeight >= clientHeight`. This is the fixed-height law, measured.
9. **THE LINK DOWN (the headline assertion).** Read the subject name from `overview-dps-label`,
   click `[data-testid="overview-open-combat"]`, then assert: `[data-testid="segment-select"]`
   exists (we are on Combat), the scope toggle's **first** button is selected (Fight scope),
   and `selectorText(page)` contains the same subject the Overview showed. That is
   "navigate + select the same fight", proven end to end.
10. **Round trip.** Click `[data-testid="nav-overview"]`; `overview-grid` is back and the page
    does not scroll (`pageOverflow(page)` → `doc === 0 && content === 0`).
11. **No renderer console errors** across the whole run.

### Unit test — `tests/overviewData.test.mts`

Pure, no Electron, never skips. Cover: `buildDropRows` caps at `DROP_FEED_CAP` and orders
newest-first; a posky item highlights with **no** knowledge present; a lore item highlights
once its knowledge lands; a QUEST-ITEM-flagged tradeskill-only component does **not** highlight
but **is** still rendered; `+N` variants resolve through `itemCountKey`; a row with no
knowledge yet is un-highlighted rather than absent.

---

## 9. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| `DEFAULT_VIEW` flip breaks the existing e2e's first selector wait | HIGH — reddens the whole suite | Flip and the e2e nav step land in the SAME commit (wave 3); waves 1–2 keep `'combat'` |
| `lookupMob` storm — `lastOutTarget` flips per swing in a multi-mob pull | HIGH — violates the scraper-etiquette LAW for uncatalogued mobs | Canonical-key + 750ms debounce + per-key memo (§3.2). Call it out explicitly in the wave-2 brief |
| Adding `'overview'` to `View` but not `KNOWN_VIEWS` | MED — silent bounce to default for returning users | Both edits in `appViews.ts`, wave 1B; covered by e2e step 10 |
| The drops feed grows and eats the page | MED — the exact Task #56 bug | Fixed height + own `overflow:auto`; e2e step 8 measures it |
| A second `combat:snapshot` poller | LOW | `ViewContent` mounts one view at a time; Overview's poll is strictly cheaper (`timeline:false, maxSegments:1`) |
| Duplicating the live/last wording instead of reusing `fightScopeOptions` | MED — drift against the Combat tab | Reuse `head.label` verbatim; e2e step 5 asserts the identity |
| Re-deriving the mob name from `SegmentSummary.name` by stripping `+N` | MED — brittle, and unnecessary | That is why `currentTarget` exists (§1.1) |
| Renderer importing `zoneTier` from `src/main` | MED — layering violation | Display raw zone; the move to `src/shared` is a named future seam |
| `overviewData.ts` using `@shared/*` VALUE imports | LOW but blocks the unit test | Relative VALUE imports; type-only imports keep the alias (`mobSearch.ts:33` precedent) |
| New files needing ratchet entries | MED — the ratchet ONLY shrinks | Executors must not add entries; keep files inside the five factoring budgets |
| Growing `combat-dashboard.e2e.mts` past `max-lines 400` | LOW | Overview assertions go in their own file; only a one-line nav step is added |
| A raw `https://` item icon | LOW — fails visibly in dev | `itemIconUrl()` / `eqimg://` only; CSP is the enforcement |
