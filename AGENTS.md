# AGENTS.md — EQ Legends Companion

Distilled operating manual. Per-task history lives in `git log` (messages are
detailed); this file holds only repeatable rules and load-bearing design.

## What this is

Electron (electron-vite) + TS + React + MUI desktop app that tails the
**EverQuest Legends** log in real time: an Overview landing tab (default
view — DPS w/ inline drill, live curve, current mob, zone, leveling rate +
next-level ETA, class loadout, recent drops/kills), Plane of Sky quest
tracking, loot, inventory reconcile, leveling/AA analytics (zone bands,
drag-select range stats), a Maps tab (Brewall/default rendering, POI
search, label declutter, floor slicing), class-combo inference with user
corrections, proc analytics (PPM + state attribution), raid targets, buffs
simulation, alerts with sounds + rank-upgrade intelligence, a Details-style
DPS meter with drill-down/timeline (drilled by default, pet nested), and
floating overlay meters. Committed knowledge DBs: mobs (7.9k), items
(11.2k), spells (1.9k), classes, zones. First stable release v0.2.0
(2026-08-03). Layout: `src/main` (Node), `src/preload`, `src/renderer`,
`src/shared`, `tests/`, `scripts/`.

- Repo: `C:\Users\jmoye\everquest-companion` (public: github.com/jmoyers/everquest-companion).
- Game log: `C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest
  Legends\Logs\eqlog_<Char>_<server>.txt` — but the path is auto-discovered +
  Settings-overridable now; NEVER hardcode, route through
  `config.ts effectiveEqRoot()/eqLogsDir()`.
- Active dev character: `Primitive@freeport`. The log is LIVE and growing.

## Operating model (how work happens here — this works, keep it)

- **Roles: Fable plans, Opus does — and that includes SUBAGENT dispatch
  (user rule, 2026-08-03).** The main session (Fable) is the integrator /
  designer / thinker: it diagnoses, designs, writes precise briefs,
  dispatches parallel Opus executor agents with DISJOINT file ownership,
  reviews their reports, runs the verification gauntlet, and commits per
  wave. Design/planning work — data models, API surfaces, plan review —
  is Fable's own job, never delegated to Opus planning agents; Opus
  subagents get concrete implementation briefs only (read-only
  research/fact-gathering subagents are fine). Executors do the work and report honestly — including
  when the brief is WRONG. An executor overturning the integrator's
  assumption with evidence is a feature, not insubordination (it has
  corrected real briefing errors: dispel attribution, venom stacking, the
  ratchet's item-category filter).
- **Work ships in WAVES.** 1–5 agents in parallel, then integrate → verify
  (typecheck + lint + full unit suite + e2e when main/renderer changed) →
  commit with a detailed message. Big projects (the lint campaign) are
  partitioned into disjoint waves with per-wave regression gates and run
  until done. The user gets a short "In flight / Settled" readout whenever
  a turn ends with agents still running.
- **Planner/integrator diagnoses against the REAL log first** (grep/sed, or a
  throwaway `scripts/_*.mts` replay via `npx tsx` — delete after). Executors
  get verified findings, not hypotheses. Never write to the game log.
- **Golden-window tests are the law** (`npm test`, node:test + tsx). Any
  "world model looks wrong" report becomes a fixture FIRST: extract the real
  log span (`tests/fixtures/*.log` via `tests/extract-*.mjs`), hand-read it,
  write the expected state, fix until green. Priming fixtures warm learned
  state (classifier/overlay) the way a full replay would.
- **Fixtures are COMMITTED and SCRUBBED.** `tests/fixtures/*.log` is tracked
  (a `!tests/fixtures/*.log` negation under the blanket `*.log` in
  .gitignore), so CI's `npm test` runs the FULL suite; before this they were
  ignored and CI was red — most fixture-backed tests `readFixture()`
  unguarded and threw ENOENT, only the combat/healing windows had
  `skip: fixture not present` guards. The repo is PUBLIC, so every extractor
  MUST route through the shared scrub `tests/fixture-scrub.mjs`
  (`scrubKeep`) — never re-implement a drop list, never hand-copy a raw log
  span into `fixtures/`. Scrub = DROP the line; NEVER rewrite it with a
  placeholder (a rewritten line still parses into a fake event and would
  pollute the golden expectation). It drops third-party chat/social: all
  quoted speech (`, '` — a whole-log sweep proved the only non-chat lines
  carrying it are mob growls, so mob speech goes too and nothing parses it),
  `/who` output, group join/leave/invite/leader lines, and social emotes.
  It KEEPS combat, casts, buff landings/wear-offs, loot, turn-ins, zone
  lines, level-ups, AA, charm/pet lines and system messages.
  **CARVE-OUT: the pet-claim tell** `<Name> told you, '… Master.'` IS a tell
  but is spoken by an NPC pet and is the ONLY binding signal for a summoned
  pet (law below), so it is kept verbatim — dropping it silently unbinds
  every pet in every combat fixture. The user's OWN `/who` row (Primitive)
  is likewise exempt: it is the only line stating the class loadout and
  `extract-leveling-fixtures.mjs` needs it. Bystanders' NAMES survive in
  mechanical lines (kill credit, fizzle/interrupt, third-person buff-landing
  emotes) — those are load-bearing (own-cast gating, buff classification,
  entity retirement) and carry no one's words.
- **Headless app test** (`npm run test:e2e`, playwright-core `_electron`): drives
  the REAL app end-to-end against the live log and asserts what the user SEES
  (`tests/e2e/combat-dashboard.e2e.mts`). Use it for anything a fixture replay
  can't see — layout, mount/empty states, hydration. `EQ_E2E=1` (src/main/e2e.ts)
  is the whole test mode: NO window is ever shown (main window is already
  `show:false`; overlays skip `showInactive`), the single-instance lock is
  skipped (runs beside the user's dev app), and the 'e2e' channel puts
  `userData` in a temp dir before electron-store loads (src/main/channel.ts) —
  so it's invisible while the user plays. Builds
  into `out-e2e/` (ABSOLUTE `--outDir`: a relative one resolves against each
  section's root and buries the renderer in `src/renderer/`) so it never races
  the dev watcher's `out/`. Assertions are floors/identities; DOM + screenshot
  land in `tests/e2e/artifacts/` on failure (hidden-window screenshots are
  best-effort — an idle window may not composite).
- **Frozen numbers rot**: the live log grows, so full-log assertions must be
  identities (`earned == allocated + unspent`), monotonic floors, or
  anchor-independent invariants — never `== <today's count>`.
- **Regression gates**: model refactors prove untouched dimensions
  byte-identical (taxonomy added categories; total damage stayed exact).
  Run baseline before changing, diff after.
- **Concurrent agents**: disjoint file ownership; re-read shared files
  (index.ts, ipc.ts, types.ts, preload, App.tsx) immediately before each
  surgical edit. errors.log noise from mid-edit HMR is normal — judge by
  final typecheck/tests and check timestamps before blaming current code.
- **PATH-SCOPED COMMITS (integrator law, learned the hard way 2026-08-03).**
  While waves overlap, the integrator stages EXPLICIT file lists from the
  finished agent's report — never `git add <dir>` and never `git add
  tests/fixtures`. Broad adds swept in-flight files three times in one day
  (another agent's fixtures; half of a preload edit, leaving HEAD unable to
  typecheck in isolation; a view importing untracked files, leaving HEAD
  unbuildable from a clean checkout). After any commit touching shared hot
  files, sanity-check that HEAD is self-consistent. A follow-up commit says
  "completes <sha>" when it repairs one of these.
- **Mid-flight course changes go BY MESSAGE to the owning agent** (owner
  amendments, hazards discovered by a sibling wave) — never by dispatching a
  second agent into owned files, and never by the integrator editing them.
- **During parallel waves, red is ambient; final reports are the truth.**
  Executors report other agents' failures SEPARATELY from their own (whose
  file, what error). eslint's cache lies after cross-agent deletes — errors
  at line numbers past a file's length mean `rm -rf
  node_modules/.cache/eslint`, not code. A throwaway `scripts/_*.mts` left
  behind breaks `typecheck:node` for everyone: delete before reporting.
- **Plans go stale while agents fly.** Line ranges, counts and tables in a
  design doc describe the log/tree at planning time — executors re-derive
  them fresh and treat every measured claim as re-checkable. The session's
  scoreboard: ~20 briefing errors overturned by executor measurement, zero
  overturned briefs that turned out right. Reward the overturn, then encode
  what it taught.
- **KEEP THE TREE BUILDABLE (user rule, 2026-08-03): the dev app must not
  stay down.** Transient seconds-long HMR breakage is fine; MINUTES is not.
  Concretely: create any file you import (even an empty stub) BEFORE writing
  the import — a scrape/codegen that produces a data file the code needs gets
  a stub first and overwrites it when done (this exact miss took the app down
  for the length of a mob-page crawl); sequence multi-file changes so
  `npm run dev` keeps compiling between edits; if you must break main's build,
  fix it in your very next edit, not at wave end.
- Commits: integrator commits per wave, detailed messages,
  `Co-Authored-By: Claude`. Keep `npm run dev` (watch) running — main edits
  auto-relaunch, renderer edits HMR.

## Toolchain gotchas

- Node/git/gh NOT on PATH in fresh shells: prepend `C:\Program Files\nodejs`,
  `C:\Program Files\git\bin`, `C:\Program Files\GitHub CLI`.
- Backticked EQ names (`Innoruuk\`s Chosen`) break inline `node -e` — use
  temp script files.
- Errors harness: main+renderer errors append to `<userData>/errors.log` AND
  dev stdout, grep `[everquest-companion:error]` (source tags:
  `main:uncaughtException`, `renderer:ErrorBoundary`, …). `<userData>` is
  PER CHANNEL (below) — a dev-app error is in
  `%APPDATA%\everquest-companion-dev\errors.log`, the installed app's in
  `%APPDATA%\everquest-companion\errors.log`. Info logs use the
  `[everquest-companion]` prefix. ErrorBoundary prevents blank windows. Check
  it first when anything's weird.
- `npm run typecheck` (node+web) before done. Data JSONs (spells, overlay
  baseline) are ES-imported so electron-vite INLINES them — a path-relative
  readFile would miss in `out/main/`.
- TS: discriminated unions with union-typed tags need a single-guard
  narrowing (`if (ev.t !== 'dmg') return`); `@shared/*` value imports need
  the renderer `resolve.alias` in electron.vite.config.ts. Node-tested
  pure modules use RELATIVE value imports (type-only may keep the alias) —
  the mobSearch.ts precedent, now repo-wide.
- Vite 5 inlines JSON as PRETTY-PRINTED object literals unless
  `json: { stringify: true }` — measured 1.56× bundle bloat on items.json
  before the flag. Keep it set for the main bundle.
- Blink scrollbars: setting the STANDARD props (`scrollbar-width`/
  `scrollbar-color`) switches to native Fluent bars and SILENTLY IGNORES
  every `::-webkit-scrollbar-*` rule — the two are mutually exclusive.
  The themed inset scrollbar lives in theme.ts + overlay.html (values
  must move together; the overlay is MUI-free and can't import tokens).
- `flexWrap` converts content overflow into HEIGHT — a "compact bar"
  contract means `nowrap` + one shrinkable/ellipsizing group for
  world-supplied text (tooltips keep the facts); controls never shrink.
- Chromium `navigator.clipboard` needs a permission this app denies
  wholesale — clipboard writes route over IPC to main's clipboard API.
- MediaWiki: anonymous `eilimit` caps at 500; >50 pageids per revisions
  batch returns HTTP 200 with ZERO pages and no warning — BATCH=50 is
  measured, not tunable.

## Linting (ESLint 9 flat config + the ratchet)

`npm run lint` gates CI in BOTH build.yml jobs, right after typecheck. Full
rationale lives in the header of `eslint.config.mjs` — read it before touching a
threshold. The short version:

- **Two layers.** Correctness: typescript-eslint `strictTypeChecked` +
  `stylisticTypeChecked`, type-aware through TS's project service (which resolves
  every file through the same two tsconfigs `npm run typecheck` builds — lint and
  typecheck can never see different file sets), plus react-hooks for the
  renderer. Factoring: `complexity 12`, `max-depth 3`, `max-lines 400`,
  `max-lines-per-function 100`, `max-params 4` (line counts skip blanks AND
  comments — this repo comments heavily on purpose; the metric is code mass).
- **Those five numbers were MEASURED, not guessed.** `npm run lint:measure` re-runs
  ESLint with the rules pinned to `max: 0` so every site reports its actual metric,
  and prints the distribution + a threshold sweep (raw output:
  `scripts/lint-measure.txt`). Each threshold sits between p95 and p99 of the real
  tree. Never change one without re-running it — including `max-depth`, which is 3
  rather than the obvious 4 *because* the data showed 4 would catch three sites in
  the whole repo.
- **THE RATCHET ONLY SHRINKS.** `eslint.ratchet.mjs` is a GENERATED per-file
  rule-off block listing exactly today's violations, so lint is green with zero
  source changes. It is a debt register, not a permission slip. A wave DELETES the
  entries it fixed and re-runs `npm run lint` to prove the deletion was earned.
  **Adding an entry is the integrator's call, never an executor's**, and
  regenerating wholesale (`npm run lint:ratchet`) to make a red build green
  silently widens it and defeats the whole design. `EQ_LINT_NO_RATCHET=1 npx
  eslint .` shows the true state.
- **Refactor-wave law.** `lint-worklist.md` (generated beside the ratchet)
  partitions the inventory into five disjoint waves — A `src/main/combat/**`,
  B `src/main/**` rest, C `src/renderer/src/features/combat/**`, D renderer rest +
  overlay, E `src/shared` + `src/preload` + `scripts` + `tests` — so agents can
  run in parallel on non-overlapping files. Every wave is
  **BEHAVIOR-PRESERVING ONLY**: no fixes, no feature changes, no "while I was in
  here". Full `npm run typecheck` + `npm test` after each wave, and the engine
  waves (A and C) additionally need the byte-identical regression gate — baseline
  the damage totals before, diff after, they must match exactly (World-model law
  8's tripwire). Keep the tree buildable throughout (see Operating model).

## Architecture

```
scan (live:false) + Tailer (live:true, byte-offset handoff — LOSSLESS seam)
   └► parseEvent (ONE pass, seq-numbered) ─► LogBus
        ├► derived events: bus.emitDerived queues, drains AFTER the primary
        │  event (no re-entrancy). Producers: buffs (buffExpired), epoch.
        ├► ModuleRegistry ─► EqModule { id, reset(), onEvent(ev, live),
        │    onTick?(now), snapshot()→{seq,state}, flushDelta()→delta|null }
        │  Live deltas push `module:delta` (throttled); replay is silent.
        │  A 1s wall-clock tick drives time-based logic while the log idles.
        │  Modules incl. `progression` (columnar exp/kill/zone analytics,
        │  capped w/ windowStart honesty, recent-kills ring) and `combo`
        │  (registered FIRST; evidence → candidate-set slots → fuzzy
        │  intervals; corrections TIME-keyed in the store, v3 migration).
        └► CombatEngine (pull-snapshot variant: `combat:snapshot` IPC +
           throttled `combat:activity` nudge; per-encounter event ring for
           the timeline; cached finalized summaries; capped payloads;
           session state timeline + proc detection/PPM/attribution —
           procDetect/procWindows/procViews, all law-8 additive)
Maps: src/main/maps (pack discovery/per-layer cross-pack merge/LRU/search,
Electron-free w/ injected roots) over shared/maps types + shared/zones
(THE zone-knowledge table); renderer features/maps (canvas geometry, DOM
labels w/ collision declutter, floor slicing). Pure fns + goldens all over.
Renderer: useModule(id, applyDelta) — hydrate, seq-dedupe deltas, re-hydrate
on `log:character`. Overlay = second renderer entry (overlay.html) with a
minimal `eqOverlay` bridge (transparent alwaysOnTop, click-through pin).
```

- **Character epochs**: character-scoped state (leveling/AA, loot, kills,
  turnins, buffs live-state) resets at the epoch boundary — anchored at
  OFFICIAL LAUNCH 2026-07-28 (`epochDetector.ts`; the user's beta character
  shared this log file pre-launch). Do NOT use level regression (loadout
  swaps legitimately change level). Game-knowledge (mined durations,
  message overlay) persists across epochs.
- **Spell DB**: `src/main/data/spells.json` (~1.9k spells from eqlwiki
  `Template:Spellpage`: durations, cast/wear-off messages, illusion flag,
  Beneficial/Detrimental) + `messageOverlay.baseline.json` + per-user
  learned overlay (VERIFIED / SHARED / CONTRADICTS-WIKI verdicts mined from
  the log; overlay wins over wiki). Injected via rulesets `ParserConfig`.
- **Alerts**: declarative JSON `AlertDef` in electron-store; triggers =
  primitives (event kind + `where` match, raw regex, app signal) or
  composites `{any|all}` (same-event semantics only). Module evaluates
  live-only with cooldowns; renderer plays sounds. Sound packs live in
  `resources/soundpacks` + userData; the ONE shipped default (Alan Rickman,
  `src/main/data/defaultPacks.ts`) is gitignored audio and SELF-PROVISIONS
  at startup from its pinned registry tag — seeded + suggested alert defs
  reference its derived soundIds. App signals (bossDefeat, questComplete)
  fire from single always-mounted detectors.

### Electron trust boundary (do not weaken)

- ONE `WEB_PREFERENCES()` in `src/main/windows.ts` (module-private, beside the only
  code that creates a BrowserWindow) builds the webPreferences for EVERY window
  (main + all five overlays) — never inline a second opinion. contextIsolation
  on; nodeIntegration (+InWorker/+InSubFrames), webviewTag,
  allowRunningInsecureContent, experimentalFeatures, enableBlinkFeatures,
  navigateOnDragDrop, spellcheck all off; webSecurity on. Stated explicitly even
  where they match Electron's default — the default is someone else's decision.
- `sandbox:false` is a PACKAGING blocker, not a choice: both preloads
  `require("./chunks/ipc-<hash>.js")` (rollup hoists the shared `shared/ipc.ts`
  out of the two-entry preload build), and a sandboxed preload's `require`
  resolves only `electron` + a tiny polyfill set. MEASURED: flipping it makes
  `npm run test:e2e` time out with `[main:preload-error] module not found:
  ./chunks/ipc-….js` and no `window.eq` at all. Nothing in the preloads needs
  Node, so `sandbox:true` (and `app.enableSandbox()`) unlocks the moment
  electron.vite.config.ts emits each preload as ONE self-contained file.
- Navigation/window-open/webview policy is installed ONCE from
  `app.on('web-contents-created')` (hardenWebContents), never per window: a
  window added later must not be able to miss it. `will-navigate` allows only the
  bundled renderer dir (or, in dev, the electron-vite server's ORIGIN — the
  server's own URL, so 5173/5174 both work); `setWindowOpenHandler` is
  deny-always and hands ONLY an allowlisted https host to `shell.openExternal`.
  **That allowlist is the boundary, not a formality**: link URLs are built from
  WIKI PAGE TITLES (`shared/wiki.ts`), and an unvalidated openExternal would let
  one ask the OS to run `file:///…exe`. Widen `EXTERNAL_LINK_ALLOWLIST`
  (security.ts) deliberately or not at all. All permissions are denied wholesale
  (this app needs none); pure policy lives in `src/main/security.ts` and is
  pinned by `tests/security.test.mts` (no Electron, never skips).
- Renderer-supplied strings that reach `join()` are validated AT THE IPC
  HANDLER (`sounds:getData`'s packId → `isSafePackId`), not trusted because
  today's only caller is the app's own UI.

## World-model laws (hard-won; do not relearn these)

1. **Messages over inference.** Applications, targets, expiry come from
   explicit chat lines (cast-on-you/other, wears-off, "Your illusion
   fades.", "slows down.", resists). Estimates are display-only countdowns.
   Anything inferred is LABELED inferred — never silently guess.
2. **Names are dirty; canonicalize at boundaries, display raw.**
   Case-insensitive keys (`idKey`) everywhere (lifecycle lines lowercase
   articles; damage lines capitalize). Strip spell rank suffixes (casts say
   `Swift Like the Wind I`, fades are rank-less) and item ` +N` variants at
   COUNTING boundaries only. Strip leading a/an/the for boss matching.
   OUR OWN labels are dirty too: `WorldModel.label()` appends a
   spawn-generation ` (N)` suffix ("the 14th capturer this session") that
   rides `currentTarget` into lookups — `mobKey` strips it; it is display
   flavor, never identity. The suffix appears in NO log line.
3. **Shared messages are the norm.** 123 wears-off families ("Your speed
   returns to normal." = 9 hastes), generic illusion landings ("You feel
   different."). Parser carries candidate lists; the MODEL resolves against
   the active set / session cast history.
4. **Entities, not names; disposition, not identity.** Buffs are
   (spell, entity) instances; "pet" is NOT a data-model class (self renders
   first, others second — presentation only). Charm break keeps the entity
   + buffs (re-charm same name w/o death/zone = same entity). Single-pet
   invariant: new claim/charm retires the prior pet. Zoning: self +
   summoned pet keep buffs; charmed pets/hostiles are left behind (censor).
   Deaths retire. **Unobservable fades censor, never pollute stats.**
   Own-cast gating: never track buffs we didn't cast (10s cast window or a
   Quick Buff burst).
5. **Aggregates lie; derive from identities.** AA earned = net allocation
   (latest purchase per ability+rank, cost-0 auto-grants excluded) +
   unspent (last authoritative "You now have" − later spends); sum-of-gains
   double-counts respec refunds. Durations: DB authoritative, else
   recency-weighted MAX (median biases low via censored samples).
6. **Say what the log cannot say** (documented non-distinguishables — never
   invent): main/off-hand; double/triple attack (same-second rounds
   heuristic only); ground pickups (NO line exists — the loot family is the
   only item-acquisition line); self-buff fades (only wears-off emotes);
   mob HP. Fight NAMING (Task #54): a LIVE fight is named after the CURRENT
   target (most recent outgoing target — the mob in front of you); on FINALIZE
   it switches to the LARGEST target ("most damage absorbed", a labeled proxy).
   Both keep the '+N' others suffix. `encounterName(e, live)`.
7. **Encounters close on evidence**: all engaged instances dead (+~5s
   linger); live CC (mez lines) holds fights open indefinitely; ~60s idle
   fallback for fled mobs. DPS = damage/(lastHit−firstHit); active-time
   DPS is the secondary stat. A zone change FINALIZES the live zone aggregate
   into a capped HISTORY (Task #54; last 20 sessions — frozen agg + timing +
   memoized summary, NO per-event rings, ~0.6MB full-log) instead of discarding
   it, so a past zone's overall meter stays selectable; the snapshot exposes
   `zoneSessions` (live first, id 'zone'; finalized 'zs<n>') and buildSelected
   accepts a session id. Selector rows (main + overlay) carry disambiguation
   timing: start clock (formatDate) · coarse live-updating age · duration.
8. **Miss/resist are first-class, damage-free** (Task #51 v2): a miss
   (avoided melee swing) and a resist (fully-resisted spell) attach to the
   fresh encounter + zone aggregate with the SAME attribution as damage
   (you/pet/incoming; hostile-mob-vs-mob resists dropped) but carry NO
   amount — so every damage total stays byte-identical (the tripwire, per
   source: `Σ category.total == source.total`). They enter the timeline
   ring as hollow/red ticks (miss -> "Melee" lane; resist -> the spell's own
   lane, so an always-resisted mez shows a 0-hit / N-resist lane). Rates:
   melee hit% = hits/(hits+misses) [hits counts ALL landed incl. spells —
   the per-category melee row isolates pure melee]; resist% =
   resists/(spell+dot casts + resists), surfaced at source / category /
   per-spell rows. A miss/resist NEVER opens or extends an encounter (only
   damage/CC does), so instants before the first hit go to the zone
   aggregate only. Ring cap 5k→8k (misses ~2× the density; sole marathon
   fight peaks 5259 instants — fits with zero drop-oldest; ≤60 rings
   retained, <1MB). Timeline zoom/pan is renderer-side view-window state
   (wheel = cursor-anchored zoom, shift-wheel/drag = pan, Fit = reset,
   starts fit); windowed by visible time range so the SVG stays cheap.
9. **One time base per chart.** A curve's vertices, markers, axis and hover
   inverse all read ONE `{t0, t1, bucketMs}`; samples anchor at bucket
   centres; live windows advance in whole buckets. Mixing an index-fraction
   vertex mapping with a time-fraction marker mapping stretched markers a
   full bucket at the right edge, and a wall-clock window length made them
   swim against a still curve every tick (fixed 5a9dbc2). Canvas is never
   the answer to arithmetic disagreement. Chart interaction seam: hover
   binds pointermove/pointerleave ONLY and bails when `ev.buttons !== 0`;
   drag interactions own pointerdown/up/cancel; a `suppressed` prop ties
   them without shared state.
10. **Revisable intervals JOIN AT READ; nothing stamps their ids.** Combo
   intervals (fuzzy, retroactively re-labeled by a later /who or a user
   correction) are queried by timestamp (`comboAt`/`groupByCombo`); an id
   stamped onto a boss kill goes stale with no reconciliation path.
   Persisted corrections key on TIME; interval ids are recompute-unstable
   and never leave the renderer.
11. **Exclusivity gates are RATE-AWARE.** "Never fired without X" requires
   the inactive exposure to PREDICT evidence (>= 3 expected firings at the
   lane's own active rate), never a flat swing floor — 289 swings deny
   Instrument of Nife what 225 earn Spellblade, and that asymmetry is the
   point. Direct observation beats the model (a lane that DID fire inactive
   is never "under-sampled"). States active for the same firings declare
   co-exclusivity — two rows never silently claim one body of evidence.
12. **Cross-source name RENAMES are knowledge, never fuzzy.** The log, the
   mob catalog and the map stems disagree by NAME (The Ruins of Old
   Paineel = The Hole), not spelling. `shared/zones.ts` is the ONE
   hand-authored, evidence-verified artifact (short names, aliases,
   `catalogZonesFor`); closest-match would conflate genuinely distinct
   zones, and an anti-fuzzy tripwire pins two near-name rosters disjoint.
   A new gap gets a VERIFIED row, never a matcher.

## Log-format quick reference (all validated against the real log)

- Melee verbs CONJUGATE — match first person ("You slash") AND third
  ("slashes"); missing `smite`/`cleave` once hid 22% of all damage. Paren
  modifiers are COMPOUND: `(Riposte Slay Undead)`.
- Zone: `You have entered X.` — REJECT pseudo-zones ("an area where
  levitation…"); instance tier suffix `(Awakened|Adaptive|Fused|Refined)`
  = d1–d4, `- Solo/Group N` noise stripped.
- Loot family (sole item-into-inventory lines): dashed
  `--You have looted X from Y's corpse.--`; currency (`…stored it in your
  currency`, NO period); sold (`…sold it for <money|free>.`). Dragon
  Hoard / depot / combine variants exist and are NOT yet parsed.
- AA: gains `…gained N ability point(s)! You now have M` (M = UNSPENT);
  spends in TWO formats (quoted rank-1 / `improved X <rank>`); cost-0 =
  auto-grants; respecs re-log purchases; no refund line exists.
- Resists (`resist` event, Task #51 v2): THREE shapes — `<target> resisted
  your <Spell>!` (caster=you), `<target> resisted <caster>'s <Spell>!`
  (caster=name; test YOUR form FIRST — 712 spell names contain `'s`, e.g.
  Denon's), `You resist[ed] <mob>'s <Spell>!` (incoming). Spell keeps rank
  suffix for display, rank-normalized (spellCanonKey) for keys. Full-log
  sweep: 5747 (you 1749 / pet 390-by-name but ~2019 once charmed mobs
  resolve / other-mob 1695 dropped / incoming 1913). Misses: `tries to … but
  misses!` family (miss/dodge/parry/riposte/block/absorb).
- Stances: two mutually exclusive groups — 9 stances (`You assume a/an X
  stance.` — the article conjugates: "an offensive stance") and 9
  invocations (`You begin reciting the X invocation`);
  "begin to change your …" lines are flavor, not state.
- Quick Buff AA: `You activate Quick Buff.` → burst of landing emotes, NO
  cast lines. Permanent Illusion AA (ownership learned from its purchase
  line): illusion self-buffs permanent; ONE illusion per entity;
  `Your illusion fades.` is the shared remover.
- Summoned pets have random proper names (Vebarn, Garer…); bind via
  owner-only tells `<Name> told you, '… Master.'`; they persist across
  zones (charmed pets do not). A pet-claim tell from a name EVER seen
  charmed re-arms the charmed set, never the permanent one — one charmed
  mob's tell must not credit its kills to you forever (`everCharmed`).
- Exp: `You gain (party )?experience!( (N.NN%))?` — the percent is an
  INCREMENT of the current level bar (sums to ~100 between dings);
  unstated ⇒ at the cap, modeled `pct: undefined` never 0. The exp line
  PRECEDES its kill line, same second (4,887/4,909) — joins consume the
  pending exp line at the next credited kill, never search forward.
- Self `/who` row (keyed on the tailed character's name via
  `ParserConfig.characterName`, never a constant) states the loadout;
  skill-ups `You have become better at <Skill>! (n)`; item activations
  `Your <item> shimmers briefly.` / `feels alive with power.` are CLICKY
  emotes, not procs — a castBegin within ~2.5s of one is clicky-sourced
  and is NOT class evidence. Wiki skill names ≠ client skill names
  (`1 Hand Slashing` vs `1H Slashing`) — classes.json carries the alias
  table measured from the log.
- Feign death has NO failure line (1.14M lines: only the success emote).
  An alert cannot fire on the absence of a line — the group ships hidden.
- `LogEvent.raw` INCLUDES the `[timestamp] ` prefix: a `^`-anchored raw
  alert regex silently never matches — anchor on `\] ` (tripwire test).
- WorldModel labels append a spawn-generation ` (N)` suffix that appears
  in NO log line (law 2) — `mobKey` strips it.

## Data sources

- **Scraper etiquette (LAW)**: every scraping script must run at a
  respectful rate limit (delay between requests), honor backoffs
  (429/5xx → exponential retry, obey Retry-After), and be re-runnable +
  idempotent (cache hits skip the network; partial runs resume, never
  duplicate output). Applies to scripts/scrape-*, itemLookup, and any
  future fetcher.

- eqlwiki.com MediaWiki API (helper: `scripts/sources/eqlegends.ts`).
  Scrapers (output committed): `scrape:posky` (quest-item cells: iterate
  `<li>` items — `<br>`-splitting once dropped trailing unhinted items),
  `scrape:bosses` (curated list incl. efreeti spawn-chain "Other:" bosses),
  `scrape:spells`, `gen:message-overlay`, `gen:icon`.
- Item knowledge: `itemLookup.ts` — local-first (posky) → wiki
  `{{Itempage}}` (`statsblock` flags / `relatedquests` / `notes`), userData
  cache with negative caching, live-loot background prefetch.
- **Downloaded images are cached PERMANENTLY** (`src/main/imageCache.ts`):
  no image the app fetches may ever be fetched twice. Item icons are served
  from `eqimg://item/<id>` — a `protocol.handle` on the DEFAULT session
  (registered in whenReady; `registerSchemesAsPrivileged` runs at index.ts
  module scope, before ready), backed by `<userData>/image-cache/item-<id>.png`.
  No window uses a custom `partition`, so the one handler covers the main
  window and every overlay. Disk hit ⇒ zero network; miss ⇒ ONE polite fetch
  (shared UA, in-flight dedupe so N windows can't double-request), written
  ATOMICALLY (temp file + rename — a torn PNG under a no-TTL cache would be
  permanent) and only if the bytes actually sniff as an image. NEGATIVES ARE
  NEVER CACHED: a 404/offline/timeout responds 404, the `<img onError>` hides
  the icon, and the next load retries. No TTL, no eviction — wiki file ids are
  immutable. `itemIconUrl()` (ItemWindow.tsx) is the single renderer entry
  point; the upstream eqlwiki URL is spelled out only in imageCache.ts.
  A SECOND route on the same handler, `eqimg://url/<encodeURIComponent(url)>`,
  covers images the renderer holds as absolute URLs — today the 29 boss
  portraits in `bosses.json`. `bosses.json` keeps the REAL wiki URLs (scraped
  data stays diffable against the wiki); the wrapping is the app's concern and
  happens at render time via `cachedImageUrl()` (`renderer/src/lib/imageUrl.ts`,
  used by BossView). Its security boundary is a STRICT host allowlist —
  `wiki.project1999.com` + `eqlwiki.com`, matched by EXACT `new URL().hostname`
  equality after decoding, https only, no credentials, default port; anything
  else 404s having touched the network zero times (never substring/endsWith:
  `wiki.project1999.com.evil.com` must fail). Entry name = `url-<sha256[0:24] of
  the normalized URL>.<sniffed ext>` — hash because arbitrary URL text can't
  safely be a filename, sniffed extension because the URL lies (p1999 serves
  `.PNG` that is a png, `.jpg` that is a jpeg); a read probes the four known
  extensions (bounded constant, O(1), and the dir stays human-browsable).
  Normalization folds `:443` and drops the fragment, so one image is one entry.
  **`img-src` does NOT list `https:`** (index.html + overlay.html carry exactly
  `'self' data: eqimg:`): that is what makes "every downloaded image is cached"
  structurally true instead of a convention — a future raw `<img https://…>`
  fails visibly in dev instead of silently bypassing the cache. Widening the CSP
  back is never the fix; wrap the URL through the `url` route instead.
- Sound packs: og-packs registry (index: peonping.github.io/registry) —
  browse/install any of ~350 packs in-app. The single shipped default
  (`alan-rickman`, pinned tag) is GITIGNORED audio, self-provisioned via the
  same installPack path (one tarball GET, retried with backoff, additive:
  never removes or re-downloads an installed pack). The synthesized `default`
  chime pack is DELETED (generator + assets, Task #57) — it is not listed,
  generated, or shipped anywhere; peon/sc_marine are no longer provisioned but
  remain registry-installable. Alerts pointing at any retired pack are rewritten
  onto the analogous alan-rickman line by a ONE-TIME, version-stamped store
  migration (`migrateAlertSounds` in data/defaultPacks.ts, run from
  `getAlerts()`), so an upgrading user's alerts never go silently mute. Every
  picker pre-selects alan-rickman (`fallbackPack`), never `packs[0]`.

## UI conventions

- **State, never process**: no methodology captions, no script references,
  no how-it-works panels. Chips convey state (db/observed, permanent,
  inferred, casting…, ~ambiguous).
- Search: input echoes instantly; filter on `useDeferredValue`; lowercase
  `searchKey` computed once per data change; long fixed-height lists
  windowed via `lib/useWindowedRows`, variable-height cap+paginate. These
  surfaces are RENDER-bound (<1ms compute) — no workers/DBs.
- Formatting: rates `21.7k dps` / `2.3M dps` (word 'dps' after number, k/M
  scaling); totals keep k/M with NO unit word. ONE source: `lib/formatRate`
  (`formatRate`/`formatNum`) — every meter/overlay/drill-down/tooltip uses it,
  NO `/s` anywhere (Task #54 sweep). Dates/times through `lib/formatDate`
  (user-local; never UTC or epoch-day math). Tier chips via `lib/tierChip`
  (dark fg on tier bg, WCAG AA).
- **A growing list lives in a FIXED-height scroll box.** The combat log was
  `flex: 0 0 auto` + `minHeight`, so it sized to its 150-line content, couldn't
  shrink, and squeezed the whole dashboard to 0px (the tab read as "just a
  scrolling combat log"; the app's content area is `overflow:auto`, so
  `height:100%` clamps nothing). Any append-only panel gets an explicit height +
  its own `overflow:auto`; the panel that must survive gets `flexGrow:1` +
  `minHeight:0`. Verified by the headless e2e harness, which measures it.
- **Hydration is a state, and the UI must show it.** During the startup replay
  every snapshot describes the PAST (an hours-old fight is `current`).
  `CombatSnapshot.hydrating` (engine: true until `setLive()`) gates a quiet
  "Reading log…" placeholder in CombatView + the overlay meter — never a
  churning fake-live meter. Task #56.
- **Fight vs Overall is an explicit SCOPE, never an automatic switch.** A
  `Fight | Overall` toggle (sibling of Dashboard/Timeline, Outgoing/Incoming;
  persisted `eq.combat.scope`) drives one filter — `scopeOptions()` in
  dashboardData.ts, shared by the main view AND every overlay kind, so a fight
  meter can never show zone data. Fight scope keeps the LAST fight on screen
  between pulls (auto-swapping to the zone aggregate was rejected: it moved the
  ground under you mid-session) but LABELS it honestly — head row reads
  "Current fight (live)" only while a pull is open, else "Last fight — <name>",
  and a locked overlay (no selector) tags its header `· LAST`. The head row's
  VALUE stays the `__live__` sentinel so it re-resolves each tick. No fights at
  all ⇒ quiet empty state, never borrowed zone data. `liveFallback` is GONE.
- Celebrations (confetti/sound) fire EXACTLY ONCE on live transitions;
  hydration seeds a silent baseline; manual actions never celebrate.

## Shipping

- CI (`.github/workflows/build.yml`) runs `npm test` — the FULL golden-window
  suite, since `tests/fixtures/*.log` is now committed (see Operating model).
  Only the full-log tests still skip there (the real game log isn't in CI).
- CI: **publish on tags ONLY** (reworked 2026-08-03; the per-push `-main.<run>`
  prerelease spam is gone — it filled Releases with lexically-mis-sorted
  auto-builds). Push to main → typecheck/test/build, installer as CI artifact,
  nothing published. Tag `v*` → the one publish path: a full release whose
  version is STAMPED FROM THE TAG in CI (package.json is never committed with
  it, and can't drift from the tag — the old "bump after tagging" rule is
  dead). Release process: `git tag vX.Y.Z && git push origin vX.Y.Z`. Semver,
  increment per release; first stable is v0.1.0.
- **RELEASE CADENCE: tag only when the user asks, or at a clearly STABLE
  point** — features verified end-to-end, the gauntlet green, no waves in
  flight. Commits land on main continuously; a tag is a deliberate act,
  never an automatic one and never mid-wave. When in doubt, don't tag —
  the next stable point is never far.
- **main.yml BRIDGE (do not remove)**: every install to date polls the 'main'
  channel feed. A stable release natively writes only latest.yml, so the tag
  job uploads a copy as main.yml on the same release — semver puts `X.Y.Z`
  above `X.Y.Z-main.N`, so old main-channel installs step up to stables
  instead of stalling forever. Azure Trusted Signing wiring is inert
  until 6 `AZURE_*` repo secrets exist (account `jmoyers-eqtools` — an
  EXTERNAL Azure resource name, deliberately not renamed; endpoint
  `https://eus.codesigning.azure.net/`; identity validation pending).
- **`npm ci` DOES NOT INSTALL ELECTRON'S BINARY ANY MORE.** `.npmrc` sets
  `ignore-scripts=true` (no dependency's install hook executes — the npm
  compromise vector), so after any `npm ci` / `npm install` you MUST run
  `npm run deps:electron` or dev/dist fails on a missing Electron binary.
  It is the ONE package in the tree that needs its hook (esbuild's is
  redundant — its binary ships in `@esbuild/win32-x64`; everything else
  declares only `prepare`/`prepack`, which npm never runs for registry
  tarballs). Both CI jobs do it as an explicit step. Explicit `npm run <x>`
  is unaffected by the flag; only lifecycle hooks are.
- **build.yml is TWO JOBS and that is a security boundary**: `build` (non-tag
  refs, `contents: read`) and `release` (tag refs, `contents: write`). Token
  permissions are per-job and static, so one job covering both paths had to
  hold write on every push to main. Keep the two preludes in sync; never
  merge them back into one job. All `uses:` are pinned to commit SHAs (a
  `@v4` tag is mutable) — re-resolve with
  `gh api repos/<o>/<a>/git/ref/tags/<t> --jq .object.sha` when bumping.
  Tagged releases also publish `SHA256SUMS.txt` alongside the installer.
- **Unsigned build ⇒ the GitHub account IS the trust root.** electron-updater
  verifies the sha512 from the feed (so a tampered *download* fails), but with
  no Authenticode publisher it cannot verify *who* built the release. Anyone
  who can publish a release here can ship a silent, per-user, no-UAC update to
  every install. Azure signing closes this (`verifyUpdateCodeSignature` turns
  on for signed Windows builds); until then, tag/release access is the control.
  See `SECURITY.md`, which states this plainly to users.
### Installer architecture

- Build chain: `npm run dist` = `electron-vite build` → electron-builder
  NSIS (`electron-builder.yml`). **Per-user install is load-bearing**:
  `oneClick:true, perMachine:false` installs to `%LOCALAPPDATA%\Programs`
  with NO UAC ever — which is what lets electron-updater silently
  self-install and relaunch (the Discord model). Never flip perMachine.
- **Add/Remove Programs**: the entry lives at
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<UUIDv5(appId)>`
  (`d1172923-5a3d-5d6c-812f-04090617a582` today) — the key is named by GUID, not
  by product name, so grep by DisplayName. app-builder-lib's
  `registryAddInstallInfo` writes it UNCONDITIONALLY (right after file
  extraction in `installSection.nsh`); nothing in electron-builder.yml gates it,
  and a fresh install of a current build registers correctly (sandbox-verified).
  It writes InstallLocation only to `HKCU\Software\<guid>`, NOT to the uninstall
  key, so Settings showed a blank location — `build/installer.nsh`
  (`customInstall`, auto-included from buildResources) mirrors it. That file is
  included at the TOP of the generated .nsi, BEFORE multiUser.nsh defines
  `UNINSTALL_REGISTRY_KEY`; spell the path out from `UNINSTALL_APP_KEY` (a `-D`
  define, always present) — using the not-yet-defined one compiles fine but
  yields an installer that dies instantly with 0xC0000005.
- **An installed app with files but NO uninstall entry is a RACE, not a build
  bug.** The uninstaller does `RMDir /r $INSTDIR` first and `DeleteRegKey` LAST,
  and an NSIS uninstaller launched without `_?=` relaunches itself from %TEMP%
  and the process you waited on exits IMMEDIATELY. So tier-1's
  `Uninstall*.exe /S` + an immediate reinstall lets the detached tail delete the
  keys the reinstall just wrote. Never reinstall after an uninstall without
  POLLING for the install dir and the uninstall key to disappear.
- **Uninstall asks before discarding user data.** `deleteAppDataOnUninstall`
  stays `false`; the ONLY deletion path is `customUnInstall` in
  `build/installer.nsh`, which prompts "Keep your settings and history?"
  (Yes = default = keep) and only on No does `RMDir /r "$APPDATA\everquest-companion"`.
  A `/S` uninstall NEVER prompts and ALWAYS preserves — that is the contract the
  sandbox harness and every scripted uninstall rely on. It must never widen to
  `%APPDATA%\eq-tools` (the pre-rename backup the one-time seed reads) or
  `%APPDATA%\everquest-companion-dev` (the running dev app). Gotcha: `${Silent}`
  is USELESS for that test — oneClick's `un.onInit` calls `SetSilent silent`
  after its own confirm dialog, so the section always sees silent; detect the real
  `/S` from `${GetParameters}`/`${GetOptions}` instead.
- Exe branding: `signAndEditExecutable:true` needs the winCodeSign cache;
  its archive fails to extract on Windows without symlink privilege — run
  `scripts/seed-wincodesign.ps1` once per machine (extracts skipping two
  macOS dylib symlinks). Icon generated by `gen:icon` → `build/icon.ico`.
- Publish: `publish: github jmoyers/everquest-companion`; artifacts
  `everquest-companion-Setup-<version>.exe` + `.blockmap` (differential updates) +
  `latest*.yml` channel feeds under `release/<version>/`. Unsigned for now
  (SmartScreen "More info → Run anyway" in README); Azure signing turns on
  via repo secrets only — CI args are already conditional.
- Auto-update: electron-updater in `src/main/updater.ts` — channel from
  store ('main' default → allowPrerelease+channel main; 'stable' →
  latest); check at +10s then 30min; toast → quitAndInstall(silent,
  relaunch); dev-guarded on `app.isPackaged` EXCEPT channel IPC (settings
  UI needs it in dev). Single-instance lock makes the relaunch clean.
- First-run self-sufficiency: the default sound pack self-provisions from
  its pinned registry tag (gitignored, so installers ship without it); spell
  DB/overlay baseline are inlined in the main bundle; EQ dir resolves via
  env → registry → drive-sweep with the Settings-gear override; zero logs
  anywhere → quiet empty state, never an error.

### Product identity + channel isolation (Task #58)

- ONE name everywhere: `everquest-companion` (package.json `name`, appId
  `com.jmoyers.everquest-companion`, installer
  `everquest-companion-Setup-<version>.exe`, install dir
  `%LOCALAPPDATA%\Programs\everquest-companion`, store file
  `everquest-companion-progress.json`, log prefixes
  `[everquest-companion]` / `[everquest-companion:error]`, scraper UAs).
  The DISPLAY name stays "EQ Legends Companion" (productName, shortcut,
  exe). `eq-tools` survives ONLY as the legacy-migration source in
  `channel.ts`/`store.ts` and in git history. NSIS install dir + the
  updater cache dir derive from package.json `name` (electron-builder
  `APP_PACKAGE_NAME` = `appInfo.name`), NOT productName — that's why the
  harness paths changed with the rename.
- Channels are decided in `src/main/channel.ts`, the FIRST import of
  index.ts (it must run before electron-store is constructed at module
  scope). Nothing else in the tree hardcodes a userData path — soundpacks,
  errors.log, item/registry caches and the learned overlay all resolve
  through `app.getPath('userData')`, so redirecting the root redirects
  everything:

  | channel | when | userData |
  |---|---|---|
  | prod | `app.isPackaged` | `%APPDATA%\everquest-companion` |
  | dev | not packaged | `%APPDATA%\everquest-companion-dev` |
  | e2e | `EQ_E2E=1` | temp dir (`EQ_E2E_USER_DATA` or `mkdtemp`) |

- Separate dirs ⇒ separate single-instance locks (Chromium keys
  ProcessSingleton off the user-data dir), so the installed app and the dev
  app genuinely run at the same time — verified with two Electron processes
  that both won `requestSingleInstanceLock()` on different dirs and where
  the second lost on a shared dir. Never "fix" a second instance quitting by
  weakening the lock; check the channel first.
- ONE-TIME SEED (prod + dev, never e2e): if the channel's dir does not exist
  and `%APPDATA%\eq-tools` does, an allowlist is COPIED
  (`eq-tools-progress.json` → `everquest-companion-progress.json`,
  `message-overlay.json`, `item-knowledge-cache.json`,
  `registry-cache.json`, `soundpacks/`) and a `migrated-from.json` stamp is
  written. Chromium caches / lockfile / errors.log are deliberately skipped.
  The old dir is never modified — it's the backup. Guard is "target dir
  absent", so it can't run twice; failures log and startup continues.
- **UPDATE CONTINUITY BREAK (conscious)**: changing appId + `name` means
  per-user NSIS sees a NEW app. An existing `eq-tools` install will NOT be
  upgraded in place and will NEVER chain-update to the renamed builds — it
  keeps polling its own feed and silently stays behind. Every existing user
  (this machine included) must uninstall the old app ONCE, then run the new
  installer; their state carries over via the seed above. Documented for
  users in README ("Already have an `eq-tools-Setup` build installed?").

### Settings migrations (persisted store schema)

- **LAW: any commit that changes a persisted shape ships a migration in the
  SAME commit.** Bump `CURRENT_SCHEMA_VERSION` in
  `src/main/storeMigrations.ts`, append a step to `MIGRATIONS`, add a fixture.
  That rule is the whole reason "an upgrade is clean, going back indefinitely"
  can be true: a store written by ANY past build must load in today's build,
  and auto-update means users jump many versions at once. `MIGRATIONS` is
  APPEND-ONLY — never renumber, edit a shipped step, or delete one.
- An explicit integer `schemaVersion` INSIDE the file, not app semver: CI
  stamps versions from tags and dev runs unstamped, so electron-store's
  semver-keyed `migrations` fire in surprising orders across channels. Absent
  ⇒ 1 (every pre-framework store), and the chain runs 1→2→…→CURRENT.
- Runs ONCE at startup from store.ts module scope, BEFORE `new Store()`, so no
  reader ever sees a pre-migration shape — and after channel.ts's one-time
  `eq-tools` seed (store.ts imports channel.ts first). Ad-hoc fixups in read
  paths are the anti-pattern it replaces: the flat `overlay` →
  `overlays.fight` fold moved out of `getOverlayConfig()` into migration 1→2.
  (`alertSoundMigration` predates the framework and keeps its own stamp — its
  "respect a user who re-points an alert" semantics aren't schema-shaped.)
- Migration 1→2 is REAL work, not a dormant no-op: it also recovers the
  top-level `progress` blob that commit 41831cc orphaned when it re-keyed
  progress by character (salvaged under the reserved id
  `legacy:pre-character` only when no real character exists — never guess an
  owner) and drops the dead `liveLoot` map.
- **Startup never dies here.** Unreadable ⇒ untouched, unstamped. Unparseable
  ⇒ QUARANTINED to `<name>.corrupt.json` and start fresh (conf leaves
  `clearInvalidConfig` false, so one truncated write otherwise throws on every
  read forever). A step that throws ⇒ keep what succeeded, stamp the last
  version that fully landed, retry next launch. Before the first write the
  original bytes are copied to `<name>.v<from>.backup.json`, once per source
  version (a later run never overwrites the pristine copy).
- **Downgrade (file newer than the build)**: log, back up, and leave the file
  ALONE — no down-migration, no reset, no stamping backwards. The old build
  runs best-effort, which is safe because every reader defaults on a missing
  key and electron-store rewrites the whole parsed object, so future keys
  survive round-trips. Verified by `tests/storeMigrations.test.mts`, which
  drives the pure runner + the file half with authored fixtures of the real
  historical shapes (no Electron, never skips).

### Installer testing strategy (three tiers)

1. **Local self-test** (any dev machine, no elevation): run the Setup exe
   `/S` → assert files under `%LOCALAPPDATA%\Programs\everquest-companion`, Start-menu
   shortcut, branded exe metadata; launch (since Task #58 the installed app
   has its OWN userData + lock, so it opens its own window BESIDE a running
   dev app — that's the PASS; it no longer just focuses dev);
   `Uninstall*.exe /S` → assert cleanup, appData preserved. Cheap smoke for
   every dist build.
2. **Windows Sandbox** — the REAL clean-machine test: disposable pristine VM,
   maps `release/` read-only + a results folder; LogonCommand silently
   installs, verifies files/shortcut/**Add-Remove-Programs registration**/
   process-start, AND asserts the fresh-machine experience (no EQ installed →
   app still boots to the zero-logs empty state), uninstalls, asserts files
   AND the uninstall key are gone, then writes PASS/FAIL to the mapped results
   dir. 19 checks; `arp-*` names each ARP field individually so a failure says
   exactly what was missing.
   **Invoke via `scripts/sandbox/run-installer-test.ps1`** (never the raw
   .wsb): it force-closes a stale VM (only ONE sandbox instance is allowed
   machine-wide — a leftover makes the next launch fail), refuses to boot
   without a CURRENT `everquest-companion-Setup-*.exe`, parks the VM window on
   the first NON-PRIMARY monitor at z-order bottom without stealing focus
   (`-Minimize` / single-monitor → minimized), force-kills the client when the
   results land (an in-guest shutdown pops a modal on the host desktop), and
   exits 0/1. The user games on the primary monitor — keep it clear.
   Harness invariants: it is ASCII-only (the guest's PS 5.1 reads a BOM-less
   .ps1 as ANSI), always writes a verdict from a `finally` (a silent exit is
   indistinguishable from a hung VM), and POLLS after uninstall instead of
   trusting `Start-Process -Wait`. Requires the `Containers-DisposableClientVM`
   Windows feature (one elevated enable + reboot; on this machine the first
   enable half-applied — if `WindowsSandbox.exe` is missing while DISM says
   Enabled, disable+re-enable elevated and reboot again).
3. **Docker servercore** (`scripts/docker/`) — headless file-level
   fallback: silent install + file/ARP-registry verification only (no GUI
   launch test); throws on the first failure. Use when Sandbox isn't
   available.

Always test the CURRENT `npm run dist` output, not a stale release/ exe —
a clean-machine pass on an old build proves nothing about today's
first-run provisioning.
- Overlay: Electron suffices for windowed/borderless EQ; exclusive
  fullscreen cannot be overlaid by anything (native-helper escape hatch:
  feed it the same snapshot IPC). Two spawnable KINDS (Task #54) — 'fight'
  (current-fight meter + FIGHT selector) and 'overall' (zone meter + ZONE-
  session selector) — one overlay.html bundle, kind read from `?kind=` on the
  URL; each has its own persisted config (`store overlays.<kind>`) and can run
  simultaneously. All overlay IPC channels take the kind as their first arg;
  `onOverlayState` payload is `{kind, open}`. Interactive mode adds a dense
  selector + a mini drill-down (bar→flat skill list, back-chevron); locked mode
  stays fully click-through but RENDERS the persisted drill read-only. The
  drill persists per kind in `overlays.<kind>.drill` (config IS the drill
  state — no renderer mirror; stale ids render level 1 without clearing).
  FIVE kinds now: fight/overall (damage), heal-fight/heal-overall, events.
  Each kind's selector is SCOPE-FILTERED (`scopeOptions`) and never crosses
  over. Selectors are the custom `OverlaySelect` (no native `<select>`: its
  OS popup ignores the theme) — the overlay bundle stays MUI-free by law.
  Default geometry is one uniform size for every kind, docked bottom-right
  and stacking upward with column wrap (`overlayLayout.ts`); PERSISTED bounds
  always win.

## Cloud (feedback backend + future web) — state as of 2026-08-04

- **AWS**: dedicated sub-account `eqcompanion` **001634075447** (org
  management = the `jmoyers` account 383185690517), region **us-east-1**.
  CLI: profile `eqc` in `~/.aws/config` assumes
  `OrganizationAccountAccessRole` via source profile `windows-desktop-eqc`
  (an IAM user whose key the OWNER manages; a least-privilege inline
  policy limiting it to that one AssumeRole was recommended and handed to
  the owner). Terraform + AWS CLI are installed (winget; terraform.exe
  under `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Hashicorp.Terraform_*`).
- **Terraform**: root `infra/`, state in s3 bucket
  `eqcompanion-tf-state-dae027bf` (versioned, BPA) + lock table
  `eqcompanion-tf-lock`. Deploys are MANUAL from this machine with
  `AWS_PROFILE=eqc`; CI only fmt/validate/bundle. `terraform apply` of the
  30-resource stack was launched 2026-08-04 (owner-approved) — VERIFY it
  completed before assuming resources exist.
- **Store is Aurora DSQL** (owner: "I hate dynamodb"), not DynamoDB:
  schema in `infra/schema.sql`, applied by `triage-feedback migrate`
  (never yet run against a live cluster — it stops on and prints a bad
  statement). Ingest connects as a DB role holding **INSERT ON report and
  nothing else**; IAM tokens, zero passwords. DSQL laws: no FKs/triggers/
  PLpgSQL, fixed Repeatable Read + OCC (retry only SQLSTATE 40001),
  3,000-row txn cap (bounds every sweep), one DDL per txn,
  `CREATE INDEX ASYNC`, jsonb young + unindexable (we use text).
- **F2: DEPLOYED AND LIVE (2026-08-04).** Applied (29+1 resources; Lambda
  runs UNRESERVED concurrency — the fresh sub-account's limit of 10 made
  reserving 5 illegal ("below minimum unreserved"); request a quota bump
  then restore `-var lambda_reserved_concurrency=5`). Schema migrated
  (14+3), kill switch OPEN, the three constants filled in net.ts
  (api pcy0z3xjp9…/v1/feedback · bucket eqcompanion-logs-6c58f5cc ·
  us-east-1). LIVE-VERIFIED: submit 201 + ULID, idempotent replay 200
  same id, oversize 413. Two DSQL live findings now encoded: grants on
  the system-owned `public` schema are unsupported (table-level grants
  suffice; schema.sql fixed) and `statement_timeout` cannot be SET
  (node-postgres sends it when configured — use client-side
  query_timeout only; db.ts fixed). REMAINING: 429/503/403/expired-
  presign negatives + a real log-upload round trip + the owner clicking
  the SNS confirmation email. Telemetry A2 rides the next apply.
- **Local dev story**: `scripts/dev-feedback-server.mts` (wave in flight
  at write time) — same contract, same shared validator, failure knobs;
  the app reaches it via `EQ_FEEDBACK_URL`, honored ONLY behind
  `!app.isPackaged` (the lawful exception to the no-override rule —
  packaged builds must prove the env var does nothing).
- **Usage analytics**: opt-OUT (owner decision over the integrator's
  opt-in recommendation) but NOTHING transmits before the first-run
  notice renders; allowlist schema; separate rotatable analyticsId;
  payload viewer + TELEMETRY.md. Plan: docs/plans/usage-analytics.md.
  A1 (client, dark) + A2 (infra) not yet built.

## Known open items

- **TOOLCHAIN WAVE (security, owner-flagged 2026-08-04)**: Electron 33 is
  EOL (Chromium 130, ~13 majors behind; 17 open advisories, most
  foreclosed by the trust boundary — the honest residual is Chromium
  image decoders fed by wiki-fetched icons). The wave: electron 33→43
  PAIRED WITH electron-builder 25→26 (they travel together), and
  vite 5→7 PAIRED WITH electron-vite 2→5 (lower urgency, dev-server
  only). Gate with full e2e + the Windows Sandbox tier. Also stale after
  onnxruntime-node landed: .npmrc's audited-hooks comment (it declares a
  postinstall — verified NOT needed on win32-x64, binaries ship in the
  tarball), electron-builder.yml's 'no native modules' comment, and the
  installer ships ~150MB of other-platform onnx binaries (trim via
  asarUnpack filters).

- **Feedback loop (the next big feature)**: fully planned + reviewed in
  `docs/plans/feedback-triage.md` — in-app reports, scrubbed log-window
  uploads, **Terraform** infra (owner decision: HCL, us-east-1, dedicated
  AWS sub-account, alarms to jmoyers+eqc@gmail.com), agentic triage CLI.
  Wave F1 ships dark (no endpoint) and needs no cloud; F2 (deploy) needs
  the owner to create the sub-account. Targeted at the v0.3.0 cycle.
- Azure signing: waiting on Microsoft identity validation → cert profile +
  app registration + repo secrets.
- Windows Sandbox: WORKING (last run 2026-08-03, PASS, gating v0.2.0) —
  `run-installer-test.ps1` is the standard pre-ship clean-machine gate.
- Design docs for every shipped 2026-08-03 feature live in `docs/plans/`
  — historical intent; the code + this file are the current truth, and
  several plan numbers were overturned by executor measurement (each
  overturn is recorded in the relevant commit message).
- Startup could be TAIL-FIRST: attach the live tail immediately, then backfill
  history BACKWARDS into the model, so the meter is live in ~0s and deepens as
  the replay lands (today: ~6s of `hydrating` on this log, then live). Needs
  order-independent folding in every module — a real architecture change, not
  yet attempted. The `hydrating` flag makes today's replay honest meanwhile.
- Not yet parsed: Dragon Hoard / tradeskill depot / combine loot lines.
  Group-member combat tracking: future scope.
