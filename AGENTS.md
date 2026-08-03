# AGENTS.md — EQ Legends Companion

Distilled operating manual. Per-task history lives in `git log` (messages are
detailed); this file holds only repeatable rules and load-bearing design.

## What this is

Electron (electron-vite) + TS + React + MUI desktop app that tails the
**EverQuest Legends** log in real time: Plane of Sky quest tracking, loot,
inventory reconcile, leveling/AA, raid targets, buffs simulation, alerts with
sounds, a Details-style DPS meter with drill-down/timeline, and floating
overlay meters. Layout: `src/main` (Node), `src/preload`, `src/renderer`,
`src/shared`, `tests/`, `scripts/`.

- Repo: `C:\Users\jmoye\everquest-companion` (public: github.com/jmoyers/everquest-companion).
- Game log: `C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest
  Legends\Logs\eqlog_<Char>_<server>.txt` — but the path is auto-discovered +
  Settings-overridable now; NEVER hardcode, route through
  `config.ts effectiveEqRoot()/eqLogsDir()`.
- Active dev character: `Primitive@freeport`. The log is LIVE and growing.

## Operating model (how work happens here)

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
  the renderer `resolve.alias` in electron.vite.config.ts.

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
        └► CombatEngine (pull-snapshot variant: `combat:snapshot` IPC +
           throttled `combat:activity` nudge; per-encounter event ring for
           the timeline; cached finalized summaries; capped payloads)
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
   ring as hollow/red ticks (miss → "Melee" lane; resist → the spell's own
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
- Stances: two mutually exclusive groups — 9 stances (`You assume a X
  stance.`) and 9 invocations (`You begin reciting the X invocation`);
  "begin to change your …" lines are flavor, not state.
- Quick Buff AA: `You activate Quick Buff.` → burst of landing emotes, NO
  cast lines. Permanent Illusion AA (ownership learned from its purchase
  line): illusion self-buffs permanent; ONE illusion per entity;
  `Your illusion fades.` is the shared remover.
- Summoned pets have random proper names (Vebarn, Garer…); bind via
  owner-only tells `<Name> told you, '… Master.'`; they persist across
  zones (charmed pets do not).

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
- **main.yml BRIDGE (do not remove)**: every install to date polls the 'main'
  channel feed. A stable release natively writes only latest.yml, so the tag
  job uploads a copy as main.yml on the same release — semver puts `X.Y.Z`
  above `X.Y.Z-main.N`, so old main-channel installs step up to stables
  instead of stalling forever. Azure Trusted Signing wiring is inert
  until 6 `AZURE_*` repo secrets exist (account `jmoyers-eqtools` — an
  EXTERNAL Azure resource name, deliberately not renamed; endpoint
  `https://eus.codesigning.azure.net/`; identity validation pending).
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

## Known open items

- Azure signing: waiting on Microsoft identity validation → cert profile +
  app registration + repo secrets.
- Windows Sandbox: WORKING (revalidated 2026-08-02, 17/17 PASS incl.
  Add/Remove-Programs registration + clean uninstall) —
  `run-installer-test.ps1` is the standard pre-ship clean-machine gate.
- Startup could be TAIL-FIRST: attach the live tail immediately, then backfill
  history BACKWARDS into the model, so the meter is live in ~0s and deepens as
  the replay lands (today: ~6s of `hydrating` on this log, then live). Needs
  order-independent folding in every module — a real architecture change, not
  yet attempted. The `hydrating` flag makes today's replay honest meanwhile.
- Not yet parsed: Dragon Hoard / tradeskill depot / combine loot lines.
  Group-member combat tracking: future scope.
