# EQ Legends Companion

A desktop app (Electron + TypeScript + React + MUI) for **EverQuest Legends** that
processes your combat log in real time. First feature: a **Plane of Sky** class-quest
tracker showing which required drops you have vs. still need, filterable by class and
prioritized by how close each quest is to done. Combat analysis (DPS, timelines) is the
next milestone — the log pipeline already streams every parsed line to the UI.

## Requirements

- Node.js LTS (installed via `winget install OpenJS.NodeJS.LTS`)
- EverQuest Legends with logging enabled (`/log on`). The app auto-detects the most
  recently written `eqlog_<char>_<server>.txt` under
  `C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest Legends\Logs`.

## Scripts

```bash
npm run dev            # launch the app with hot reload
npm run build          # production build into out/
npm run scrape:posky   # refresh Plane of Sky quest data from eqlwiki.com
npm run typecheck      # type-check main, preload, and renderer
```

## How it works

- **Log pipeline** (`src/main/log/`): `Tailer` byte-tails the active log (polling, survives
  log rotation); `parse.ts` turns lines into events. Self-loot lines
  (`--You have looted a <item> from <mob>'s corpse.--`) become live progress updates.
- **Plane of Sky data** (`scripts/scrape-posky.ts` → `src/renderer/src/data/posky.json`):
  scraped from the EQ Legends wiki (MediaWiki API). 16 classes, ~95 quests. Classes with
  dedicated pages get full mob/island drop info; the rest fall back to the wiki's compact
  per-class table. Re-run the scraper to refresh; the JSON is committed so the app needs no
  network at runtime.
- **Inventory** (`src/main/inventory/`): run `/outputfile inventory` in-game, then click
  **Reload inventory**. The app parses `<Character>-Inventory.txt`, seeds held-item counts,
  and keeps them current from live loot. Progress persists via `electron-store`.

## Plane of Sky view

- Multi-select **class filter**, search, and sort (Closest to done / Fewest missing / By class).
- Each quest shows a progress bar (`have/need`), missing-item count, and — expanded — every
  required item with who drops it and on which island. Mark a quest **Turned in / complete**
  once you hand it in (turn-ins consume the items, so this can't be inferred from inventory).
