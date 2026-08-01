# EQ Legends Companion

A desktop app (Electron + TypeScript + React + MUI) for **EverQuest Legends** that
processes your combat log in real time. Today it focuses on **Plane of Sky** class-quest
tracking; combat analysis (DPS, timelines) is the next milestone — the log pipeline already
streams every parsed line to the UI.

## Requirements

- Node.js LTS (`winget install OpenJS.NodeJS.LTS`)
- EverQuest Legends with logging on (`/log on`). The app auto-detects `eqlog_*` files under
  `C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest Legends\Logs`.

## Scripts

```bash
npm run dev            # launch with hot reload
npm run build          # production bundle into out/
npm run dist           # build the one-click Windows installer (release/)
npm run scrape:posky   # refresh quest data (default source: eqlegends)
npm run typecheck      # type-check main, preload, renderer, scripts
```

## Features

- **Characters** — every detected `eqlog_*` file is listed in the top-right picker, sorted by
  last played. Switch characters and the app re-reads that log and keeps **per-character**
  progress (turn-ins, inventory).
- **Plane of Sky** — all 16 classes' quests from the authoritative main
  [Plane of Sky](https://eqlwiki.com/Plane_of_Sky) page. Multi-select class filter (remembered),
  search, and sort (Closest to done / Fewest missing). Each quest row shows every required item
  as a chip — green ✓ = have, grey = still needed — plus a rune. Hover any item for an EQ-style
  **stat popover** (name, slot, damage, stats, saves).
- **Inventory** — reconciliation view: per item, how many you **looted** (log) vs. have in your
  **export**, what's been **turned in**, and the **net** available.
- **Loot** — full looted-item history (real-time), searchable, group-by-item, PoSky items flagged.
- **Turn-ins** — mark a quest "Turned in / complete" and its items are subtracted from your
  simulated inventory, so a drop handed in for one quest stops counting toward another.

### Counting source

A "Count items from" selector (remembered) controls how the app decides what you have:

- **Log (looted)** — everything the character has ever looted, parsed from the whole log on
  launch and updated live. Default, because it doesn't depend on the inventory export (which may
  miss an un-exported bank, e.g. the Dragonhoard).
- **Inventory export** — your last `/outputfile inventory` dump. Click **Reload inventory** after
  running the command in-game.
- **Both** — the higher of the two per item.

## Architecture: swappable sources

Different EQ servers/emulators have wildly different rules, so the app is built around **profiles**
(`src/shared/profiles.ts`). Each profile has:

- a **quest-data source** (`scripts/sources/<id>.ts` implementing `QuestSource`) that scrapes data
  into `src/renderer/src/data/<id>/posky.json`;
- a **log ruleset** (`src/main/log/rulesets.ts`) for that server's log format.

To add e.g. Project 1999: add a profile, implement `scripts/sources/p99.ts`, register it in
`scripts/sources/index.ts`, run `npm run scrape:posky -- --source p99`, and add a ruleset if the
log format differs. The runtime loads data via `src/renderer/src/data/index.ts` keyed by the
active profile.

## Distributing to friends

```bash
npm run dist
```

produces a **one-click installer** at `release/<version>/EQ Legends Companion-Setup-<version>.exe`
— double-click installs and launches, adds Start-menu/desktop shortcuts. Unsigned, so Windows
SmartScreen may warn on first run (More info → Run anyway). The build is not code-signed
(`signAndEditExecutable: false` in `electron-builder.yml`); to sign, provide a certificate and
remove that flag.
