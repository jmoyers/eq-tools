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
Tailer (byte-offset, polling)  ──►  parseLine  ──►  processLine (loot/kill/zone/
   src/main/log/Tailer.ts                            turnin/level/AA)   src/main/log/process.ts
                                              └─►  CombatEngine.ingest   src/main/combat/engine.ts
On character load: scanLog() reads the WHOLE file once and feeds BOTH pipelines,
seeding all state (this is why history/charm work from app start).
IPC:  getX()  for snapshots (loot, kills, levels, AAs, combat) ;
      onX events (onLoot/onLevel/onAA/onTurnIn/…) for live pushes.
Renderer subscribes/polls; main owns all authoritative state.
```

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
  AA spend: `You have gained the ability "<X>" at a cost of N ability points.`
  ("You now have M" is **unspent**, not lifetime; unspent = last M − spends after.)
- **Combat** (see `src/main/combat/parse.ts`):
  - Melee: `<A> <verb> <B> for N points of damage.` + optional `(Critical)` /
    `(Riposte)` / `(Slay Undead)` / `(Finishing Blow)` modifier.
  - Spell (typed): `<A> hit <B> for N points of <class> damage by <Spell>. (Critical)`.
  - DoT: `<B> has taken N damage from your <Spell>.` | `… from <Spell> by <caster>.`
  - Damage shield: `<B> is burned by YOUR flames for N points of non-melee damage.`
  - Mob nuke on you: `<mob> hit you for N points of magic damage by <Spell>.`
- **Charm lifecycle** (only the charmer sees these, so they're yours):
  - `<mob> has been charmed.` → pet on.
  - `Your <charm spell> spell has worn off of <mob>.` → pet off (only for charm
    spells: Allure/Beguile/Charm/Dictate/… — ignore buffs like *Dazzle* wearing off).
  - `<mob> has been slain …` → pet off.

## Combat engine = a formal state machine

State: `charmed:Set`, `zone`, `current` encounter, `history[]`, `zoneAgg`. One
transition per ingested line (documented at the top of `engine.ts`). Rules:

- Attribution: `A=You` → your out; `A∈charmed && B∉friendly` → pet out; `B=You` →
  incoming; else ignored (not your fight).
- Encounters group **staggered adds**; a new one starts after a `SEGMENT_GAP_MS`
  (10s) idle. **DPS = damage ÷ (lastHit − firstHit)** so it freezes when a fight
  ends (do NOT divide by `now` — that was the "sliding average / NaN" bug).
- Overall aggregate resets on **zone**.
- Name-only ambiguity is unsolved-by-design: if two `a fire giant warrior`s exist
  and one is charmed, the log can't distinguish them. We rely on explicit
  charm/worn-off/death messages, never guess.
- The engine keeps a capped **classification ring** (recent parsed lines) for the
  live processing log; `looksDamage()` flags damage-shaped lines it *couldn't*
  parse so misses are visible via the "show unparsed" toggle.

## Data sources & scrapers (offline, committed output)

- Quest data: `npm run scrape:posky` → `src/renderer/src/data/eqlegends/posky.json`.
  Source of truth is the **main Plane of Sky page** compact table on eqlwiki.com
  (the dedicated per-class pages are stale). Item stat blocks come from each
  item's wiki page.
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

## TypeScript notes

- Discriminated unions where one member has a union-typed tag don't narrow across
  multiple `=== ` checks — guard with a single `if (ev.t !== 'dmg') { … return }`.
- `@shared/*` value imports need the alias in `electron.vite.config.ts` renderer
  `resolve.alias` (type-only imports are erased and don't).
