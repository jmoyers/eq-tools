# AGENTS.md — working notes for the EQ Legends Companion

Hard-won context for anyone (human or agent) picking this up. Read this before
touching the log parsing or combat code.

## What this is

An Electron + TypeScript + React + MUI desktop app that reads the **EverQuest
Legends** combat log in real time. Features: Plane of Sky quest tracker, loot
history + drill-down, inventory reconciliation, per-character leveling + AA
tracking, raid-target (boss) progress, and a Details-style live DPS meter with
encounter history.

- **On disk:** `C:\Users\jmoye\eq-tools` (git repo, commit history is the changelog).
- **Scaffold:** electron-vite. `src/main` (Node), `src/preload` (bridge),
  `src/renderer` (React), `src/shared` (types shared across all three).
- **Game log:** `C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest Legends\Logs\eqlog_<Char>_<server>.txt`.
  Active char during development: `Primitive` on `freeport`.

## Toolchain gotchas (this machine)

- **Node/npm/git are not on PATH** in fresh harness shells (the parent env is
  cached). Prefix commands:
  - PowerShell: `$env:Path = "C:\Program Files\nodejs;$env:Path"; npm ...`
  - Bash: `export PATH="/c/Program Files/nodejs:$PATH"; npm ...`
  - Git: `C:\Program Files\git\bin\git.exe`.
- `npm install` prints `allow-scripts` warnings for electron/esbuild postinstall —
  **harmless**, the binaries are present.
- **electron-builder** can't extract `winCodeSign` on Windows without symlink
  privilege. We set `signAndEditExecutable: false` in `electron-builder.yml` so
  `npm run dist` builds the NSIS installer unsigned. Don't remove that without a
  cert.
- **Backticks in EQ names** (e.g. `Coercer T\`vala`) break `node -e "..."` /
  `bash -c` with double quotes. Write a temp `scripts/_x.mjs`/`.mts` file instead.

## Architecture / data flow

```
scan+tail ─► parseEvent ─► LogBus (one typed LogEvent stream, one seq counter)
  src/main/log/{scanHistory,Tailer,parser}.ts        src/main/log/bus.ts
        ├─► ModuleRegistry ─► EqModule[] (loot/turnins/kills/leveling/character)
        │       src/main/modules/*   own a state slice; push `module:delta`
        └─► CombatEngine.ingestEvent  src/main/combat/engine.ts
On character load: scanLog() STREAMS the file (1MB chunks, yields to the event
loop — never readFile a 68MB log into one string) and emits live:false onto the
bus; the Tailer continues live:true from `endOffset` (`startOffset` option) — this
handoff makes the scan→tail seam lossless; do not revert to `fromStart:false`
(starting at current EOF loses every line appended during the scan).
```

### The module framework (extension contract) — src/main/modules/

- `EqModule<Snap,Delta>` = { id, reset(), onEvent(ev,live), snapshot()→{seq,state},
  flushDelta()→{seq,delta}|null }. `ModuleRegistry` subscribes every module to the
  bus (registration order = delivery order) and owns the push loop: after LIVE
  events it schedules a trailing ~100ms flush; each non-null `flushDelta()` is sent
  as **`module:delta` `{moduleId,seq,delta}`**. During replay (live:false) modules
  fold silently — no deltas. `module:getSnapshot(id)` returns `snapshot()`. `seq` =
  last LogEvent seq the module consumed → renderer uses it for dupe/gap detection.
- Renderer: **`useModule(id, applyDelta)`** (src/renderer/src/lib) hydrates via
  getSnapshot, subscribes to module:delta filtered by id, applies in seq order
  (delta.seq ≤ known → skip), re-hydrates on `log:character`. This is the ONE
  transport for loot/turnins/kills/leveling/character — the old per-feature
  get*/on* channels were **removed**.
- **Combat is a documented transport variant**, NOT a registered module: it keeps
  its own `combat:snapshot` IPC + `combat:activity` throttled (≤1/250ms) nudge
  (fetch a fresh snapshot on ping; 1s fallback poll). See modules/types.ts header.
- Other pushes: `progress:changed` (quest complete / inventory reload → every view
  stays consistent), `inventory:autoReloaded` (chokidar watch on `*-Inventory.txt`
  auto-reloads + refreshes), `log:character` (state rebuilt on switch), `log:line`.
- Boss confetti + sound are TWO-TIERED (Task #24). Two pure detectors in
  features/bosses/bossStatus.ts, both fed by `useBossKills(targets, {onKill,
  onNewDefeat})`:
  - `bossKills()` — ANY roster-target kill (count↑), including a REPEAT at the
    same/lower tier → drives the canvas `Confetti` + card flash in BossView and the
    app-wide MUI Snackbar (App.tsx). This is `onKill`.
  - `newDefeats()` — the subset that's a first defeat at a NEW tier (prev count 0 or
    bestTier↑) → additionally fires the `bossDefeat` app-signal SOUND, and nothing
    more. This is `onNewDefeat` (App only). Repeat kills stay silent.
  The historical baseline is still seeded silently on first snapshot so load ≠
  confetti/sound. `onNewDefeat` passes the boss name as context to
  `fireAppSignal('bossDefeat', name)` so it lands in the alert's recent-fires
  history (see below).
- Reducers: src/main/log/reducers.ts is now just the pure kill core
  (`isCountedKill`, `recordKill`) the kills module reuses — the old monolithic
  reduceEvent/LogStore is gone.

### The Alerts extension (Task #18) — the first non-trivial EqModule

Triggered sounds: match something in the log (or an app signal) → play a sound.
This is the reference implementation of the extension contract for future agents.

- **`AlertsModule`** (src/main/modules/alerts.ts) is a normal registered EqModule.
  It evaluates `event`/`raw` triggers on **LIVE events only** (replay never fires),
  honors each alert's `enabled` + `cooldownMs`, and pushes fires as the standard
  `module:delta` payload `{ fired: Array<{alertId, ts, matchedText}> }`. `app`
  triggers are **renderer-evaluated** (they depend on derived boss state) — the
  module stores/serves their defs but never fires them.
- **AlertDef schema** (JSON-serializable, in `shared/types.ts`, persisted in
  electron-store under `alerts`):
  ```ts
  interface AlertDef {
    id: string; name: string; enabled: boolean
    trigger:
      | { type: 'event'; kind: LogEventKind; where?: Record<string,string> }
      | { type: 'raw'; regex: string }            // raw line, case-insensitive
      | { type: 'app'; signal: 'bossDefeat' }     // renderer-side signal
    sound: { packId: string; soundId: string }
    volume?: number       // 0..1, ×globalVolume (default 1)
    cooldownMs?: number   // default 2000
    note?: string         // freeform provenance (agent authorship, etc.)
  }
  ```
  `where` field matchers: each value is an **exact case-insensitive string** OR a
  `/regex/` string (leading+trailing slash → compiled `new RegExp(body, 'i')`).
  The field is looked up on the LogEvent by key (e.g. `{ mob: '/spirit/' }` on an
  `uncharm` event). An invalid regex degrades to no-match, never throws.
- **How an agent authors an alert** from a sentence like "alert me on charm
  breaks": pick a `trigger.kind` from the LogEvent kinds (see `LogEventKind` in
  shared/types.ts, mirrors `logEvents.ts` — e.g. `uncharm`, `death`, `loot`,
  `level`), pick a `sound` (`sounds:listPacks` → pack id + sound id), then write
  the def via the `alerts:save` IPC (`window.eq.saveAlert(def)`). Set a stable
  `id` and a `note` recording provenance. **Regex gotchas:** `raw` and `/regex/`
  fields are passed straight to `RegExp` — escape metacharacters (`\.`, `\(`,
  backticks in EQ names are literal so fine), and remember JSON strings need
  doubled backslashes (`"\\."`). Validate the `kind` against `LogEventKind`; an
  unknown kind simply never matches.
- **Sound packs**: a pack = a directory with `manifest.json`
  `{ id, name, sounds: { [soundId]: { file, label } } }` + audio files
  (`.wav`/`.mp3`/`.ogg`). Two sources, both surfaced by `sounds.ts` `listPacks()`:
  - **bundled** — `resources/soundpacks/<id>/` (shipped; asarUnpack'd in prod).
    The `default` pack is GENERATED by `scripts/gen-sounds.mts` (raw-PCM WAV
    synthesis, zero deps) — `victory` (original JRPG-ish fanfare; we do NOT ship
    copyrighted game audio), `warning`, `chime`, `horn`. Re-run
    `npx tsx scripts/gen-sounds.mts` to regenerate. Two IMPORTED voice packs also
    ship (Task #21, from github.com/PeonPing/og-packs, CC-BY-NC-4.0, recorded in
    each pack's `manifest.json` as a `license` field): `peon` (Orc Peon, 17 .wav)
    and `sc_marine` (StarCraft Marine, 16 .mp3). Their CESP source categories
    (task.complete / input.required / …) are preserved as label prefixes so the
    picker reads well (e.g. "Complete · Work complete."). The seeded `charm-break`
    alert points at `peon/error-notthatorc` ("Me not that kind of orc!").
  - **user** — `<userData>/soundpacks/<id>/` (on this machine
    `%AppData%\eq-tools\soundpacks`); a user drops their own files + manifest and
    it appears in the picker (user packs shadow bundled ones with the same id).
  `sounds:getData(packId, soundId)` returns `{ mime, dataBase64 }`; the renderer
  builds a **Blob URL** (CSP-safe — `media-src 'self' blob:` in index.html) and
  caches it (`features/alerts/soundCache.ts`).
- **Renderer**: `features/alerts/player.tsx` is **always mounted** in App.tsx. It
  (a) plays `module:delta` fires at `globalVolume × alert.volume` (skips if muted,
  overlapping plays allowed), and (b) exposes `fireAppSignal('bossDefeat')`. That
  signal is fired from App's single always-mounted `useBossKills` defeat callback
  — the same instant the snackbar/confetti fire — and `fireAppSignal` re-applies
  the alert cooldown, so even if BossView's own detector fires in the same tick it
  can't double-play (single-fire per defeat). `AlertsView` is the "Alerts" nav tab
  (global volume + mute, per-alert enable/volume/sound-picker/test/delete, add
  dialog). Prefs live in electron-store (`alertPrefs`), main-owned, `alertPrefs:get/set`.
- **Seeded once** (when the `alerts` store key is absent): `charm-break`
  (`event`/`uncharm` → `peon`/error-notthatorc) and `boss-defeat` (`app`/bossDefeat
  → default/victory). An empty list the user cleared is respected (not re-seeded).
  A "Reset to defaults" button (`alerts:reset` IPC → store `resetAlerts()`) restores
  this exact set behind a confirm dialog.
- **Recent fires + transparency (Task #22).** The `AlertsModule` holds a per-alert
  ring buffer (`AlertFireRecord[]`, last 20, newest last) — the single source of
  truth for the "recent fires" UI. It's fed by BOTH main-side event/raw fires
  (recorded in `onEvent`) AND renderer-evaluated `app` fires: the player calls
  `window.eq.appFired(alertId, context)` → main `alertsModule.appFired()` records it
  and `registry.flushNow()` pushes it over the SAME `module:delta` transport
  (appFired bumps the module seq so useModule doesn't reject the delta as a dupe).
  The ring is in `snapshot().state.history` (keyed by alert id) and survives
  flushDelta/character switch. `AlertsView` hydrates it via `useModule('alerts', …)`
  and shows an expandable, dense, monospace "recent fires" panel per alert (time +
  the matched line / signal context). Each alert row shows a compact trigger badge
  (`event:uncharm`, `raw:/regex/i`, `app:bossDefeat`). The add dialog is now
  add/EDIT — every alert incl. built-ins opens in it (name, trigger type/kind/where,
  raw regex with live validation, sound, volume, cooldown); built-ins are just
  stored defs with stable ids, no special casing.

### The Buffs extension (Task #19) — a log-mined buff-duration model

`BuffsModule` (src/main/modules/buffs.ts, a normal registered EqModule) tracks the
player's own buffs and learns each spell's duration from the log — no static spell
DB. Five NEW parser events feed it (all additive, all formerly `unknown` — proven
zero-regression on charm/cc/uncharm/death):

- `castBegin { spell }` — `You begin casting <S>.` / `You begin singing <S>.`
- `castFizzle { spell }` — `Your <S> spell fizzles!`
- `castInterrupted { spell }` — `Your <S> spell is interrupted.` **NB (log evidence):
  there is NO bare `Your spell is interrupted.` line — the shape always names the
  spell. `You regain your concentration and continue your casting.` is the OPPOSITE
  (a recovered cast) and is deliberately NOT parsed.**
- `buffFade { spell, target? }` — TARGETLESS `Your <S> spell has worn off.` (self) or
  `Your pet's <S> spell has worn off.` (`target:'pet'`). This is a pure fallthrough
  AFTER the `worn off OF <mob>` charm/cc handler — the two never overlap (no ` of `),
  so uncharm/cc emission is untouched. **In this Enchanter's real log EVERY targetless
  fade is the pet form** (the charmed pet is the main buff target) — so durations are
  effectively mined from pet buffs; both self and pet are the player's own casts.
- `playerDeath { killer? }` — `You have been slain by <X>!` (distinct from the
  third-person SLAIN_BY `<mob> has been slain by <x>!`, which needs `has`, not `have`).

**Mining model (unchanged, byte-for-byte, since Task #30):** `castBegin(S)` → pending;
a fizzle/interrupt of S clears it; otherwise the cast is treated as LANDED (for MINING)
when the next `castBegin` arrives OR 15s of log-time elapse (cast times are unknown —
the documented approximation; landed ts is the cast-BEGIN ts, cast seconds being
negligible vs minute-scale durations). Each landed cast pairs with the NEXT `buffFade`
of S → a duration sample. CENSORED (no sample) on recast-before-fade (a refresh —
restart the timer) or `playerDeath`-before-fade (death strips buffs + clears all
active). **Zone lines do NOT clear buffs** (EQ buffs persist through zoning). Per-spell
stats = n / median / p25 / p75 / min / max. The honest **buff discriminator**: only
spells that have EVER produced a `buffFade` are buffs — nukes/mez/charm emit `castBegin`
too but never fade, so they're excluded. Snapshot `{ active: ActiveBuff[], stats:
{spell: BuffStat} }`; the module ships its whole (small) snapshot as each delta.

**Optimistic landing + retraction (Task #30 — the latency fix).** The DISPLAY (`active`
map) no longer waits for the 15s confirmation. On `castBegin(S)`: if S already has a
CONFIRMED active entry, keep it and STAGE the refresh (don't move `startedTs` until
confirmed — so a refresh that fizzles leaves the prior buff intact); else if S ∈
`everFaded`, create a PROVISIONAL active entry (`provisional:true`, `startedTs=beganTs`)
immediately. A `castFizzle`/`castInterrupted` of S drops the provisional / abandons the
staged refresh. CONFIRMATION is exactly the mining land (next-cast / +15s / fade) — it
clears `provisional` and applies a staged refresh's `startedTs`. Mining semantics
(`open`/`samples`) are UNTOUCHED, so duration samples are identical (regression-gated:
with named-fades stripped, the new logic reproduces the pre-change stats byte-for-byte).
`ActiveBuff.provisional?` is additive; BuffsView dims provisional rows (dashed border +
"casting…" chip) until confirm.

**Wall-clock tick (Task #30 — the idle fix).** `EqModule.onTick?(nowMs)` is an optional
heartbeat; `ModuleRegistry.tick(nowMs)` calls every module's onTick then runs the normal
flush path (deltas only when dirty). `index.ts` starts a 1s `setInterval(registry.tick,
Date.now())` once the LIVE tail is running (never during replay), cleared on quit /
character switch. `BuffsModule.onTick` runs `maybeLandPendingByTime(now)`, so the 15s
confirmation fires in real time while the log is idle (standing still after a self-cast
now shows the buff, then confirms ~15s later). Log ts and `Date.now()` share the local
clock. **Restart currency:** after a scan, a stale pending cast from minutes ago (`now ≫
beganTs`) confirms on the FIRST live tick; a cast in the final 15s of the scanned log
appears provisionally in the snapshot immediately after scan.

**Named-target buff fades (Task #30 — the coverage fix).** In the parser worn-off
handler, a `Your <Spell> spell has worn off of <target>.` line whose spell is NEITHER a
charm NOR a cc spell now emits `buffFade { spell, target:<raw name> }` (previously it
fell through to `unknown` — hundreds of pet-buff fades on the charmed mob, e.g. "Swift
Like the Wind … worn off of an ice giant", were dropped). Charm→uncharm and cc→refresh
precedence is unchanged and regression-gated (charm/cc/uncharm counts identical on a
frozen log). The miner keys samples PER SPELL (per-spell-per-target pairing is a known
v1 simplification), so named-target fades feed the same buckets as self/pet fades.
`fadeTarget` can now hold a mob name; BuffsView shows self/'pet'/named-target chips.
(Frozen-log numbers when this landed: +563 named fades, buffFade 409→972.)

**Overdue display (Task #30):** BuffsView shows "overdue · any moment" (warning color)
instead of a bottomed-out countdown once elapsed > p75 with n≥2 (`isOverdue` in
buffs/format.ts).

**BuffsView** (`features/buffs/BuffsView.tsx`, "Buffs" nav tab, AutoFixHigh icon) shows
active buffs with a live elapsed/estimated-remaining bar (indeterminate + "unknown
duration" when n=0), ± p25–p75 spread, and n as a confidence hint; below, a dense
stats table sorted by n. Live via `useModule('buffs', …)`.

**Alert synergy:** a fade can drive a sound — author an alert with
`{ type:'event', kind:'buffFade', where:{ spell:'Clarity' } }` to be reminded the
moment a long class buff drops (the BuffsView caption points users at this). All five
new kinds are in `LogEventKind`, so any is alert-targetable.

**Entity-aware simulation (Task #32 — the who/what/when model).** Buffs now BIND to WHO
they're on: **self | summoned pet | charmed pet | hostile mob (debuff)**. The module
keeps a tiny entity state (charmedKey/summonedKey + an inferred pet fight-target) fed by
`charm`/`petClaim`/`uncharm`/`cc`/`death`/`zone`, conceptually parallel to the combat
WorldModel and SHARING its pure lifecycle rules via **`src/main/combat/entityRules.ts`**
(extracted this task: `PetKind` type, `isLeftBehindOnZone`, `deathCensors`,
`classifyFadeTarget`, `charmedPetDiesOnDeathLine`). world.ts re-exports `PetKind` and its
`zone()` survivor branch now calls `isLeftBehindOnZone` — a pure refactor, combat
regression-gated byte-for-byte (youOut/petOut/incoming/fights identical on a frozen log).
The buffs module does NOT touch the engine's live world instance (modules are independent
consumers) — it re-derives the small state it needs.

- **Censoring the unobservable-fade outlier class (rule #3).** An open cast is bound at
  LAND time to a target entity (`inferCastDisposition`: a known debuff → the inferred
  hostile target; else the live charmed pet, else summoned, else self). When that entity
  is RETIRED before the fade — **zone-left-behind** (charmed pet or hostile mob; a
  SUMMONED pet follows and survives) or **entity death** — the open cast is CENSORED (no
  duration sample), not paired into a bogus multi-hour duration. This killed the old
  **23.8h "Swift Like the Wind" outlier** (a charmed-pet buff whose real fade was never
  observed): Swift is now correctly a PET buff, max ≈7m. A final **`MAX_SAMPLE_MS` (3h)
  ceiling** drops any land→fade gap beyond any plausible EQ buff (the backstop for an
  orphaned open cast across a multi-day logoff with no intervening zone line in the
  scanned window — otherwise 200h+ pairings for Spirit Armor / Reckless Strength leak in).
- **Same-name twin safety.** The buffs model is NAME-keyed (no twin instances), so a
  `<charmedName> has been slain` line is twin-ambiguous. The shared
  `charmedPetDiesOnDeathLine` rule (mirroring world.ts death cases 2a/2b/2c) returns
  FALSE — a name-only slain line NEVER censors the pet's buffs; the pet is retired only by
  an explicit `uncharm` (charm-spell worn off) or a `zone`. Without this, a hostile
  same-named twin you kill (`bySelf`) would wrongly clear charm and misclassify every
  subsequent pet-buff fade as hostile.
- **Debuffs are a distinct class (rule #5).** Classification is a **PLURALITY VOTE** over
  a spell's observed fade dispositions (`dispTally`), NOT a sticky "ever hostile" flag: a
  real pet buff occasionally fades during a charm gap (would be mislabeled by a sticky
  rule) and a real debuff is hostile in the majority. `classOf`: hostile > friendly →
  `debuff`; self-plurality → `self`; else `pet`. **Rule 5(a) holds — a debuff never
  appears as self** (self requires a self plurality, which a majority-hostile spell can't
  have; validated: debuff∩self overlap = NONE). Frozen-log result: Languid Pace → DEBUFF
  (~52s slow), Tashani/Pacify/Soothe/Calm/Heat Blood → DEBUFF; Courage/Holy Armor → PET
  (~27m). Active **debuff targets are INFERRED** (castBegin has no target) from the pet's
  current fight target (last `cc`/`charm`) and surfaced with `inferredTarget:true` → the
  UI shows a "target: inferred" chip, NEVER a silent guess (rule 5c).
- **Types** (`shared/types.ts`): `BuffClass = 'self'|'pet'|'debuff'`; `BuffStat.cls`,
  `ActiveBuff.cls`/`.disposition`/`.inferredTarget` are additive. **(SUPERSEDED by Task #35:
  `BuffClass` is now `'buff'|'debuff'` — the 'self'/'pet' distinction became an entity BINDING,
  not a class. See the '#35 de-specialized' notes below.)**
- **BuffsView** rendered Active and Mined-durations in three class sections (Self / Pet buffs /
  Debuffs). **(SUPERSEDED by Task #35: the UI now groups by ENTITY — "Your buffs" first, then a
  group per bound entity — with a red accent per-row for debuffs.)**

**Out of scope (still):** an overlay window (later phase); a spell never yet observed
fading still won't show as active until its first fade classifies it as a buff (the
`everFaded` gate — a provisional entry is only created for known buffs); duration
samples are keyed per spell, not per (spell,target), so a buff on two named targets
shares one bucket; the entity model is name-keyed (no twin instances) — it deliberately
never censors a pet on a name-only death line (a genuine pet death reported ONLY as a
same-named slain line, with no uncharm, leaves buffs open until the next zone censors
them); the SELF group is empty on this Enchanter's log because every one of the player's
own casts targets the charmed pet (documented reality — see BuffFadeEvent). *(The SELF-
group-empty claim is SUPERSEDED by Task #33's emote learning — self casts now surface, see
below.)*

**Golden-window world model + buff rebuild (Task #33).** The user saw days-old "active"
buffs on long-dead pets while real self buffs were invisible. Fixed by six changes to the
buffs model, each pinned by a hand-verified golden-window test (`tests/`, `npm test`):

- **Rank canonicalization (finding #1).** Current-session casts are rank-suffixed —
  `You begin casting Swift Like the Wind I.` / `Shiftless Deeds IV` / `Allure VI` — but
  EVERY fade/fizzle/interrupt line DROPS the rank. 2,507/12,442 casts carry a Roman tail.
  `spellCanonKey()` (parser.ts) strips a trailing ` I`..` X` (word-bounded, end-of-name
  only) for the KEY; the display name keeps the suffix. VERIFIED SAFE: no fade line ever
  ends in a Roman numeral, and all 16 rank-tailed base spells are real spells whose
  identity has no Roman word (so stripping never merges two spells). This is what makes a
  ranked cast pair with its rank-less fade (W6).
- **Landing-emote cast-target discrimination (finding #2).** EQ prints a flavor line the
  instant a buff lands — self `You feel much faster.` or third-person `<pet> feels much
  faster.`. The parser emits a permissive `spellEmote {subject,text}` candidate (matched
  LAST in `classify()`, after every real family, so it never shadows combat/cast/charm).
  The buffs module RECOGNIZES a landing-emote TEXT once it's appeared adjacent (≤5s) to a
  cast ≥2× (the noise filter — coincidental DoT/weather flavor never recurs cleanly in a
  cast window), then trusts each cast's emote SUBJECT to bind that cast's target: a
  self-emote ⇒ SELF buff even while a charmed pet is live. NB a spell can be cast on BOTH
  self and pet (Swift Like the Wind is, in the real log), so there is NO global spell↔emote
  binding — the per-cast subject is the only honest discriminator; an emote-bound cast is
  never re-bound by a later pet claim (`emoteBound` flag). This is the direct fix for the
  user's invisible self buffs (W1).
- **Single-pet invariant (finding #3).** One pet at a time. A new `charm`/`petClaim`
  RETIRES the previous pet (charmed or summoned) — `retireEntity` censors EVERY
  pet-disposition open cast + pet-class active (single pet ⇒ every pet buff is on it). This
  kills the Gibober→Jenann succession bug (a 62-min bogus sample from an open cast that
  outlived its pet) (W3).
- **Entity retirement drops actives (finding #4).** A SUMMONED pet has a unique proper name
  (Xeneker/Gibober/Jenann) with no hostile twin, so a `<Name> has been slain by <other>!`
  line is unambiguously its death → retire + censor (fixed the "Intensify Death [Xeneker]
  287h" stale active). A pet buff cast BEFORE its pet's name is known (Intensify @19:52:31,
  Xeneker claimed @19:57:42) binds 'self', then `rebindPetBuffsToPet` re-binds it to the
  pet on the claim (within a 10-min window) so the pet's later death censors it (W2). The
  CHARMED-pet twin-ambiguity conservatism (name-only slain ⇒ keep) is unchanged.
- **Session gap (finding #5).** An event-time gap ≥ 30 min (`SESSION_GAP_MS`) ⇒ clear ALL
  actives (self + pets) + censor opens + retire pets at the boundary — a logout/AFK past
  any buff duration. Short relogs (< 30 min) keep state. Learned maps (everFaded / class /
  emote recognition) are PRESERVED across the gap (only live actives/entities clear) (W4).
- **Active hygiene cap (finding #6).** Any active with elapsed > max(2×p75 [n≥2], 90 min)
  auto-retires (censored) on every event + `onTick`. No hours-old rows; the "overdue · any
  moment" display is only for mildly-over-p75.

**Golden-window testing methodology (the deliverable the user mandated — follow it for any
future buffs/world-model change).** `tests/goldenWindows.test.mts` + `tests/fixtures/*.log`.
For each window: LOCATE a real span in `eqlog_Primitive_freeport.txt`, READ it line-by-line,
EXTRACT it verbatim (chat trimmed) via `tests/extract-fixtures.mjs` (committed — the user's
own log), then replay through the REAL parser + BuffsModule and assert the world model
(active buffs w/ target+class, mined stats). A golden window is a SLICE, so windows that
depend on learned state are PRIMED with an earlier real excerpt (`*-priming.log`) that warms
the classifier/everFaded/emote-recognition BEFORE the window — exactly what the full-log
replay does ahead of the live tail in production (`replayBuffs(lines, tick, {prime})`).
`tests/fullReplaySmoke.test.mts` replays the WHOLE log and asserts no active older than the
hygiene cap, no active bound to a retired entity, and rank-merged stat keys. `npm test` runs
all. This is additive-only to the parser (spellEmote is formerly-`unknown`; combat/charm/cc/
death counts unchanged — regression-checked); world.ts/combat engine untouched.

**Spell database + message-driven buff model (Task #34).** The user's self buffs were
invisible (cast via Quick Buff bursts that print NO "You begin casting" line) and mined
durations read LOW (median of pet-buff samples). Fixed with a scraped spell DB + a
message-driven apply/expiry model:

- **Scraper** `npm run scrape:spells` (`scripts/scrape-spells.ts`) enumerates every
  `Template:Spellpage` page (MediaWiki `list=embeddedin`, paged; raw wikitext cached under
  `scripts/sources/cache/spells`) and parses the template fields → **`src/main/data/spells.json`**
  (committed; 1926 spells — 46% w/ parsed durations, 84% w/ cast messages, 50% w/ wears-off,
  46 illusions). Duration parser handles "27 minutes"/"16 Min"/"2 Min 30 Sec" (compound sum)
  and level formulas ("4.4 minutes @L44 to 6.0 minutes @L60" → MAX per the user's "prior =
  max" directive). The JSON is **imported directly** in `src/main/data/spellDb.ts` (NOT
  readFileSync) so electron-vite INLINES it into the main bundle — a path-relative read would
  miss it in prod (`out/main/` has no copy). `SpellEntry`/`SpellDbFile` in `shared/types.ts`.
- **Derived lookup tables** (`spellDb.ts` `buildSpellDb`): `castOnYou`/`wearsOff`/
  `castOnOtherSuffix` each map a message → **candidate spell LIST** (many spells share a
  message — "You feel much faster." is Alacrity/Celerity/Quickness/Swift; rank variants share
  theirs). The cast-on-other suffix strips the wiki's "Someone " subject so a log line ending
  in "…looks tranquil." / "…'s face contorts…" matches by suffix, recovering the named target.
- **Parser injection via ParserConfig** (parser purity preserved): `installSpellDb(db)` (main
  startup, `rulesets.ts`) attaches the DB to the config; the parser emits, DB-gated & additive,
  `buffApply {spell,target,illusion,durationMs,candidates}` (msg_cast_on_you self / cast-on-other
  suffix), `buffWearOff {spell,target:'self'}` (msg_wears_off), and `aaActivate {name}`
  (`You activate <X>.`). With NO DB installed these never fire — existing tests/profiles are
  byte-for-byte unchanged (harness `replayBuffs` clears the DB; `replayBuffsWithDb` installs it).
- **BuffsModule** (`db` ctor arg): `buffApply` → immediate CONFIRMED `messageDriven` self/target
  active (covers Quick Buff bursts natively). AMBIGUOUS message resolved to the candidate the
  player actually **cast this session** (`castHistory` from castBegin); if none resolves, the
  apply is **skipped, never guessed**. An INSTANT spell (no duration, not illusion) or a
  **Detrimental self-apply** (incoming mob debuff) is skipped — the bar shows only real self
  buffs. A **self-heal-by-DB-buff** line (`You healed <you> … by Symbol of Pinzarn.`) also
  applies (its wiki landing msg is wrong). `buffWearOff` = AUTHORITATIVE removal (favored over
  estimate). **Estimator precedence:** DB duration (authoritative, `durationSource:'db'`) else
  the **recency-weighted MAX** of the last 5 samples (`'observed'`, never median). **Permanent
  Illusion** AA tracked from its `aaSpend` purchase event → a self-cast illusion after that ts
  is `permanent` (∞, exempt from hygiene sweep). Hygiene cap raised to `max(2×p75, 2×dbDuration,
  90min)`. `ActiveBuff.durationSource/permanent/messageDriven` + `BuffStat.dbDurationMs/
  estimateMs/estimatorSource` are additive. **Full-log final bar:** Illusion: Wood Elf (perm),
  Symbol of Pinzarn 27m, Group Resist Magic 18m, Boon of the Garou (perm), Valor 36m — the
  user's real self buffs, DB-timed. **Estimator wins** (old-median → new DB): Swift 3m→16m,
  Clarity 6m→27m, Valor 25m→54m, Symbol 32m→45m, Languid Pace 52s→3m.
- **Golden windows** (`tests/messageDrivenWindows.test.mts`, DB-enabled): **W7** the 20:29:44
  Quick Buff burst → Clarity/Valor/Symbol of Pinzarn/Swift active as SELF w/ DB durations, no
  cast lines (primed w/ a real Clarity cast so the ambiguous "cool breeze" msg resolves); **W8**
  "Your valor fades." removes an active Valor 25m in (< 54m DB, so message-driven not swept);
  **W9** post-purchase self Boon = permanent, same spell pet-cast = normal 6m. All W1–W6 stay
  green (their fixtures gained real emote/heal lines but replay DB-free).

**'pet' DE-SPECIALIZED — the (spell, entity) instance model (Task #35).** The user's directive:
"the whole special category for 'pet' is not supposed to be exceptional in the data model and
tracking — it's just supposed to PRIORITIZE showing you buffs you cast on self first, then
others second (pet is others)." So the model was corrected:

- **A buff INSTANCE is `(spell, targetEntity)`**, keyed by `(spellKey, entityKey)` where
  `entityKey` is `'self'` or a canonical entity-name key (a NUL joins them — can't appear in a
  name). `active`/`open` are keyed by this INSTANCE key, so the SAME spell coexists on the
  player AND the pet AND a mob as independent instances with independent timers. This REMOVED
  the old one-active-per-spell limitation (W9 now asserts a permanent self Boon and a normal pet
  Boon SIMULTANEOUSLY). **Do NOT reintroduce a 'pet' `BuffClass`** — `BuffClass` is now just
  `'buff' | 'debuff'`; who a buff is on is an ENTITY BINDING, not a class. **`ActiveBuff.self`**
  (on the player?) + **`.target`** (the bound entity's display name for non-self) drive the UI.
- **DELETED (not generalized):** the `'pet'` BuffClass; `petTargetKey` plumbing *inside buff
  records*; `rebindPetBuffsToPet` (the pet-specific retro-binding — a buff now binds to the
  entity the landing MESSAGE/emote named, or the live-pet/self inference at cast time; a cast
  with no message/emote and no live pet binds SELF, e.g. W2's Intensify — the property the user
  cared about, "no stale buff on a dead pet", still holds because nothing binds to the pet's key
  unless named). No pet-special branches in retirement/censor.
- **buff vs debuff is a SPELL property** (`classOf`): DB `spellType` (Detrimental → `debuff`,
  Beneficial → `buff`) is authoritative; only a spell ABSENT from the DB falls back to
  fade-disposition plurality. This KILLED the class-flip wart (Tashani/Shiftless toggling
  pet↔debuff as fades landed on different targets). A debuff is never a self buff (even if
  cast-timing bound it to the self key before its class was known, `buildActive` presents it as
  non-self/inferred-target). A message apply is GROUND TRUTH: it drops any cast-timing-inferred
  provisional of the same spell and binds the target the message named.
- **Entity lifecycle generalized (`retireEntity(entityKey)`):** retiring ANY entity censors
  every open cast + active INSTANCE bound to its key — the pet is just the entity currently
  claimed (charm/petClaim/uncharm/summoned-death/zone-left-behind/single-pet succession). Buffs
  on OTHER players / arbitrary mobs fall out free: bound to their entity, censored when it's
  retired. Per-spell duration MINING is unchanged (`recordFade` pairs the exact instance, else
  the oldest same-spell open cast — cast-timing can't always predict the fade's named target).
- **UI = PRIORITY, not taxonomy** (`BuffsView`/`format.ts`): "Your buffs" (self) render FIRST,
  then one group per bound entity sorted by recency (the current pet naturally tops it);
  `groupKey`/`groupLabel` do the grouping. Detrimental spells get a red accent (`classAccent`)
  wherever they appear. Provenance/permanent/message/inferred chips from #34 kept.
- **W10 (the user's verification standard):** the real Aug 1 21:01:50 window — fighting
  Cazic-Thule in The Plane of Fear, the pet phoboplasm charmed. `Cazic-Thule slows down.` is the
  msg_cast_on_other shared by the enchanter slows (Forlorn/Languid Pace/Shiftless/Tepid Deeds +
  an NPC Rejuvenation), AMBIGUOUS — resolved to **Shiftless Deeds** (cast twice seconds earlier,
  21:01:40/46) via cast history, bound BY MESSAGE to entity `Cazic-Thule` (`inferredTarget`
  UNSET). Full-log replay: **0 of 14 final actives are inferredTarget** — targets are
  message-bound, `inferred` is fallback-only. Final self bar (from #34) survives unchanged; pet
  (phoboplasm) buffs listed under the pet's name; debuffs on hostiles.

**Illusion exclusivity + observed-message overlay (Task #36).** The final self bar wrongly showed
MULTIPLE illusions at once (up to 8 on the full log) because the model never parsed the click-off
line and `You feel different.` resolved to different illusion candidates as independent
(spell,self) instances. Two fixes:

- **Illusion rules.** (a) The parser now emits a dedicated **`illusionFade { target:'self' }`**
  for the exact line `Your illusion fades.` — matched BEFORE the DB `buffWearOff` table (that line
  is the `msg_wears_off` for 27 distinct illusion spells incl. Boon of the Garou, so a
  wears-off match would remove an arbitrary FIRST candidate). The buffs module's handler calls
  `clearSelfIllusion()` — removes whichever illusion-flagged self buff is active (there is at most
  one), no spell name needed. (b) **Exclusivity (the user's rule): only ONE illusion per ENTITY at
  a time.** `applyMessageBuff`/`landPending`/the optimistic castBegin path call `clearIllusionsOn(
  entityKey, keepKey)` when the applied spell is illusion-flagged (`db.byKey.get(key)?.illusion`),
  removing any prior illusion active/open bound to that SAME entity. Per-entity, so a self
  illusion and a **pet** illusion (Boon-on-pet) coexist (W9 still passes). Full-log MAX
  simultaneous self illusions went **8 → 1**; final self illusion = **Boon of the Garou (perm)**,
  which matches the LAST illusion event in the log (`You feel... strange.` self-cast @22:08:02) —
  the illusion display now tracks the last illusion cast, replacing the prior one each time.
- **Observed-message overlay** (`src/main/data/messageOverlay.ts`, `MessageOverlayMiner`). The
  user's directive: "augment the spell database with our own method of verifying variations of the
  cast messages for everything we encounter." As the buffs module folds the log (replay AND live)
  it feeds every `castBegin` (anchor) + candidate message line (`buffApply`/`spellEmote` = landing,
  `buffWearOff`/`illusionFade`/`buffFade` = wears-off, plus un-catalogued **self-shaped** flavor
  lines the DB missed — gated by `looksLandingMessage`, which requires a `you`/`your` reference and
  rejects combat/system spam) into the miner, keyed by (messageText, spellKey). A message is
  associated to a cast ONLY when the anchor is **unambiguous** (exactly one distinct spell in the
  6s window) — this is what keeps VERIFIED verdicts trustworthy (a burst with 5 casts attributes
  to none). Per-message **verdict**: **VERIFIED** (one spell, n≥2), **SHARED** (multiple spells —
  e.g. `You feel different.` for every illusion; can't name a spell → resolve via cast history),
  **CONTRADICTS-WIKI** (observed self-landing line ≠ the spell's `msg_cast_on_you`, and doesn't
  match its `msg_cast_on_other` suffix either — e.g. `The symbol of Pinzarn/Transal flashes before
  your eyes.` vs the wiki's wrong `A mystic symbol flashes…`), **UNKNOWN** (n<2).
  - **Effective DB = spells.json + overlay, overlay WINS.** `deriveLandingCorrections()` → the
    VERIFIED/CONTRADICTS-WIKI self-landing corrections; `applyOverlayCorrections(db, corr)` layers
    them onto the parser's `castOnYou` table at startup (index.ts, BEFORE `installSpellDb`) so a
    self-landing line the wiki got wrong/omitted is recognized. **FUTURE AGENTS: consult the
    overlay before trusting a wiki cast message** — a SHARED verdict means the message can't name a
    spell on its own (cast-history resolution required); a CONTRADICTS-WIKI verdict means the
    wiki's `msg_*` for that spell is inaccurate.
  - **Persistence.** Committed **baseline** `src/main/data/messageOverlay.baseline.json` (generated
    by `npm run gen:message-overlay` from the full log; imported+inlined like spells.json so fresh
    installs start warm) + the user's **`<userData>/message-overlay.json`** (versioned; saved
    debounced ~60s on the tick + on quit; loaded at startup). Both seed the miner additively via
    the `BuffsModule(db, [baseline, userOverlay])` ctor. `src/main/data/overlayPersistence.ts` owns
    load/save; `OVERLAY_VERSION` guards a stale schema. Full-log overlay stats: **574 verified /
    1119 shared / 179 contradictions**.
  - **Auditability.** `BuffsSnap.overlay` ships in the snapshot; `BuffsView`'s collapsible
    "Message overlay (learned)" section is a dense read-only table (message · role · verdict · n ·
    spells+counts), contradictions/verified/shared first (UNKNOWN hidden).
- **Golden windows** (`tests/illusionOverlayWindows.test.mts`, +4 → 15 total): **W11** the real
  20:15:41→20:23:39 window — Wood Elf self illusion (generic msg + cast history), Boon on the pet,
  `Your illusion fades.` @20:23:39 clears the self illusion; asserts NEVER two self illusions and
  final self illusion count 0. **W11b** four illusions cast in sequence never pile up (exclusivity
  on apply). **W12a** `You feel different.` classified SHARED. **W12b** Symbol of Transal's real
  landing line recorded CONTRADICTS-WIKI (Pinzarn shares the inaccuracy but is cast-begun once;
  Transal is the repeatable proof). All W1–W10 stay green.

- The **combat engine lives in main** and is fed the full scan + live tail. The UI
  (`useCombat`) just polls `getCombatSnapshot(opts)` ~2×/sec. Earlier it lived in
  the renderer and **missed any charm that happened before the app opened** — the
  reason charmed pets weren't tracked. Don't move it back.
- Per-character state (progress, inventory, completed quests) is keyed by
  `name_server` in `electron-store`. Window bounds are persisted too.

## EQ Legends log formats (validated against the real log)

- Timestamp: `[Sat Aug 01 13:00:28 2026] <message>`.
- Loot (self): `--You have looted a <item> from <mob>'s corpse.--` (strip the
  `from … corpse` suffix; capture the mob).
- Zone: `You have entered <zone>.` — **instance tier is in the name**: base = D0,
  `(Awakened)` D1, `(Adaptive)` D2, `(Fused)` D3, `(Refined)` D4.
- Kill: `You have slain <mob>!` / `<mob> has been slain by <x>!`.
- Turn-in: `You offered N <item> to <NPC>.` … `You complete the trade with <NPC>.`
- Level: `You have gained a level! Welcome to level N!`
- AA gain: `You have gained N ability point(s)! You now have M ability point(s).`
  AA spend — TWO formats: `You have gained the ability "<X>" at a cost of N ability
  points.` (rank 1) and the dominant `You have improved <X> <rank> at a cost of N
  ability point(s).` ("You now have M" is **unspent**, not lifetime.)
  Gotchas (all validated): cost-0 spend lines are **auto-grants**, not purchases;
  **respecs re-log purchases** (same ability+rank re-bought, no refund line exists)
  so sum-of-costs ≠ net spent — headline "spent" must be `earned − unspent`.
- **Combat** (see `src/main/combat/parse.ts`):
  - Melee: `<A> <verb> <B> for N points of damage.` + optional `(Critical)` /
    `(Riposte)` / `(Slay Undead)` / `(Finishing Blow)` modifier. Verbs conjugate:
    first person `You slash/crush/smite/cleave…`, third person `slashes/cleaves…` —
    the regex must match BOTH (a `slashes?` pattern silently drops all first-person
    melee; this once hid 22% of all damage). `smite`/`cleave` are real EQL verbs.
  - Spell (typed): `<A> hit <B> for N points of <class> damage by <Spell>. (Critical)`.
  - DoT: `<B> has taken N damage from your <Spell>.` | `… from <Spell> by <caster>.`
    (`<B> has taken N damage by <Spell>.` with NO caster = someone else's DoT — skip.)
  - Damage shield out: `<B> is burned by YOUR flames for N points of non-melee damage.`
    Incoming DS: `YOU are burned by <mob>'s <element> for N points of non-melee damage!`
  - Mob nuke on you: `<mob> hit you for N points of magic damage by <Spell>.`
- **Entity-name casing**: lifecycle lines use lowercase articles (`a froglok…has
  been charmed.`) but sentence-start damage lines capitalize (`A froglok…hits`).
  All identity comparisons must use a canonical lowercase key (see `idKey()`),
  keeping display casing separately.
- **Charm lifecycle** (only the charmer sees these, so they're yours):
  - `<mob> has been charmed.` → pet on.
  - `Your <charm spell> spell has worn off of <mob>.` → pet off — charm spells ONLY
    (Charm/Beguile/Allure/Cajol…/Dictate/Agacerie…). **Enthrall/Entrance/Mesmerize
    are MEZ, not charm** — do not uncharm on them ("cajole" won't match "Cajoling
    Whispers"; stems are audited against real worn-off lines).
  - `<mob> has been slain …` → pet off. **Zoning clears all charm** (charm cannot
    survive a zone line).

## Combat engine = a formal state machine

State: `charmed:Set`, `zone`, `current` encounter, `history[]`, `zoneAgg`. One
transition per ingested line (documented at the top of `engine.ts`). Rules:

- Attribution lives in the pure, unit-testable `classify()` (engine.ts):
  `A=You` → your out — **even if B's name is charmed** (a same-named hostile twin;
  you can't meaningfully melee your own pet); `A∈charmed, B=You` → incoming;
  `A∈charmed, A==B` → pet out flagged **ambiguous** (pet↔twin, direction unknowable
  — surfaced as a `~` badge, never silently guessed); `A∈charmed, B other` → pet
  out; else ignored (not your fight). All comparisons via canonical `idKey()`.
- **Encounter segmentation is death-closed** (Task #20, replacing the old
  `SEGMENT_GAP_MS` idle rule). A fight CLOSES when either:
  - every engaged **hostile** instance is *gone* — retired (dead/zoned) OR idle for
    `LINGER_MS` (5s) with no attributed damage involving it (a mob the pet stopped
    fighting that never got a death line) — AND `LINGER_MS` has passed since the last
    attributed damage overall. A live charmed pet is **excluded** from this check (it
    never dies, so it would otherwise pin every charm-grind fight open forever).
  - OR no attributed damage AND no CC event for `FALLBACK_IDLE_MS` (60s) — the
    fled/deaggroed backstop for mobs the log never reports dead.
  A **CC (mez/root) application or refresh** HOLDS the encounter open regardless of
  damage gaps while the CC'd instance is alive (`CC_HOLD_MS` 120s backstop expiry) —
  this is the *mez-and-wait* case (the pure time-gap rule would wrongly split it).
  Pet swap (uncharm→re-charm) is **not** a boundary event. Empty (0-damage) shells
  are dropped at finalize. Closure is **time-driven**, so it's evaluated both on the
  next ingested damage/CC event AND in `snapshot(now)` (the poll may be the first
  observation past a threshold); finalization always stamps the encounter's own
  `lastTs` (a damage ts), never the eval moment. **DPS = damage ÷ (lastHit −
  firstHit)** so it freezes when a fight ends (do NOT divide by `now` — that was the
  "sliding average / NaN" bug).
- **Active-time DPS**: each encounter accumulates `activeMs` = Σ over attributed
  damage hits of `min(ts − prevHitTs, ACTIVE_MS)` (3s cap, standard meter convention;
  first hit adds 0). Surfaced as `activeSec`/`activeDps` (total ÷ activeSec) on the
  segment summary/view; the CombatView shows it as a subtle "(act N/s)" caption next
  to wall-clock DPS (which stays the headline). `activeSec ≤ durationSec` always.
- **CC events** (`kind:'cc'`, `shared/logEvents.ts`): mez/root, NOT charm. Parser
  emits them from `<mob> has been mesmerized|enthralled|entranced|ensnared.`
  (application) and from `Your <mez/root spell> spell has worn off of <mob>.`
  (`refresh:true` keep-alive). The charm-vs-mez split in the worn-off handler is
  intact: a **charm** spell worn-off still emits `uncharm`; a **CC** spell worn-off
  now emits a `cc` refresh (was previously dropped). Spell families are the
  `charmSpell`/`ccSpell` regexes in `log/rulesets.ts`.
- Overall aggregate resets on **zone**.
- Same-name ambiguity is handled by the `classify()` rules above: your own hits and
  hits on you are always attributed; only pet↔same-named-twin lines are ambiguous,
  and those are counted as pet damage with an explicit ambiguous flag. A full
  entity-instance world model (spawn generations) is the planned next step.
- The engine keeps a capped **classification ring** (recent parsed lines) for the
  live processing log; `looksDamage()` flags damage-shaped lines it *couldn't*
  parse so misses are visible via the "show unparsed" toggle.

## Data sources & scrapers (offline, committed output)

- Quest data: `npm run scrape:posky` → `src/renderer/src/data/eqlegends/posky.json`.
  Source of truth is the **main Plane of Sky page** compact table on eqlwiki.com
  (the dedicated per-class pages are stale). Item stat blocks come from each
  item's wiki page.
- Spell DB: `npm run scrape:spells` → **`src/main/data/spells.json`** (NOT the renderer
  data dir — the parser in MAIN needs it; imported+inlined by spellDb.ts). Source: every
  `Template:Spellpage` wiki page. See the Task #34 buffs notes above.
- Raid targets: `npm run scrape:bosses` → `.../eqlegends/bosses.json`. Roster is
  **classic-only** (no Kunark/Velious). Portraits come from the **Project 1999
  wiki** (`Npc_*` images, best classic art) with eqlwiki fallback; Cazic uses the
  `Cazic Thule (God)` P99 page. Images are hotlinked (CSP allows `https:`);
  `onError` falls back to an initials placeholder.
- Profiles (`src/shared/profiles.ts`) namespace data by server so a P99 backend
  can be added later.

## Dev workflow

- `npm run dev` (HMR for renderer only — **restart after main/preload changes**).
- `npm run typecheck` before committing. `npm run build`, `npm run dist`.
- **Verify engine changes by feeding the real log through the pure engine** with a
  throwaway `scripts/_x.mts` + `npx tsx` (the engines have no DOM deps). This is
  how every combat/AA claim in the history was validated.
- After launching dev in the background, the app window can't be screenshotted
  (dev Electron isn't a registered app), so verify via logs + tsx scripts.
- **A blank window should now be impossible** (Task #13 error harness). Every JS
  error — main uncaught/unhandled, renderer `window.onerror`/rejection, React
  render crashes (caught by `ErrorBoundary` wrapping `<App/>`), dead render
  processes, failed loads, preload errors, and renderer console warnings/errors —
  is captured. Instead of a blank shell the user sees a dark "Something broke"
  fallback with the message, a collapsed stack, and a Reload button.
  - **When debugging a broken/blank UI, check `errors.log` FIRST.** Location:
    `app.getPath('userData')/errors.log` → on this machine
    `C:\Users\jmoye\AppData\Roaming\eq-tools\errors.log` (the path is also printed
    at startup: `[eq-tools] Error log: …`). It's append-only, truncated at ~1MB.
  - Every captured error is also `console.error`'d with the grep-able prefix
    **`[eq-tools:error]`**, so it lands in the `electron-vite dev --watch` stdout
    (the task `.output` file) — `grep '\[eq-tools:error\]'` to find them. Source
    tags identify origin: `main:uncaughtException`, `main:render-process-gone`,
    `renderer:onerror`, `renderer:ErrorBoundary`, `renderer:console`, etc.

## TypeScript notes

- Discriminated unions where one member has a union-typed tag don't narrow across
  multiple `=== ` checks — guard with a single `if (ev.t !== 'dmg') { … return }`.
- `@shared/*` value imports need the alias in `electron.vite.config.ts` renderer
  `resolve.alias` (type-only imports are erased and don't).
