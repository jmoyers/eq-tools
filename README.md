# EQ Legends Companion

A desktop companion app for **EverQuest Legends** that reads your combat log in real
time and turns it into live, useful views: a Plane of Sky class-quest tracker, loot
history, inventory reconciliation, per-character leveling + AA tracking, raid-target
(boss) progress, a Details-style DPS meter with encounter history, and a triggered
sound-alert system. It watches your `eqlog_*` file as you play — no add-ons, no
memory reading, just the log EQ already writes.

- **Characters** — auto-detects every `eqlog_*` file; switch characters and the app
  re-reads that log and keeps per-character progress.
- **Plane of Sky** — all 16 classes' quests with per-item "have / need" chips, item
  stat popovers, class filter, and sort by closest-to-done.
- **Loot / Turn-ins / Inventory** — real-time looted-item history, quest turn-in
  tracking, and a reconciliation view (looted vs. exported vs. turned-in vs. net).
- **Combat** — a live DPS meter fed by the full log scan + tail, with death-closed
  encounter segmentation, active-time DPS, and charmed-pet attribution.
- **Buffs** — a log-mined per-spell buff-duration model with live remaining-time bars.
- **Alerts** — play a sound when something happens in the log (charm break, a buff
  fading, a raid target defeated, or any log event / regex you author). Ships with
  original tones plus optional imported voice packs.

## Download & install

Grab the latest installer from the [**Releases**](https://github.com/jmoyers/eq-tools/releases)
page: `eq-tools-Setup-<version>.exe`. It's a **one-click, per-user installer** (like
Discord) — double-click and it installs under your user profile and launches. No
admin prompt, no wizard. It adds a Start-menu + desktop shortcut ("EQ Legends
Companion").

### "Windows protected your PC" — this is expected

The app is **not code-signed** (a code-signing certificate costs money and is on the
to-do list), so Windows SmartScreen shows a blue warning the first time you run the
installer. It's safe to proceed:

1. On the "Windows protected your PC" dialog, click **More info**.
2. Click **Run anyway**.

You only see this once. (Signing would remove the prompt; until then, this is the
normal experience for unsigned open-source Windows apps.)

### Enable logging in EverQuest

The app needs your combat log. In-game, type `/log on`. The app auto-detects logs at:

```
C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest Legends\Logs\eqlog_<Char>_<server>.txt
```

## Automatic updates

The app updates itself in the background from GitHub Releases. When an update finishes
downloading, a small **"Update ready — vX.Y.Z"** snackbar appears with a **Restart**
button; click it to apply and relaunch (or it installs on next quit). Two channels:

- **Main** (default) — the latest build, published on every push. You get fixes and
  features as soon as they land.
- **Stable** — only tagged releases. Fewer updates, more baked.

Switch channels in the app's settings (the channel selector).

## Building from source

```bash
npm install
npm run fetch:packs   # download the optional CC-BY-NC voice packs (see below)
npm run dev           # launch with hot reload
npm run build         # production bundle into out/
npm run dist          # build the one-click Windows installer into release/
npm run typecheck     # type-check main, preload, renderer, scripts
```

The installer build (`npm run dist`) writes the icon + version metadata into the exe
via electron-builder's winCodeSign toolchain. On Windows that toolchain can fail to
extract without symlink privilege — if `npm run dist` loops on a "Cannot create
symbolic link" error, run the one-time workaround first:

```powershell
./scripts/seed-wincodesign.ps1   # seeds the winCodeSign cache (see scripts/README.md)
npm run dist
```

(Or enable Windows **Developer Mode** so electron-builder can extract it itself.)

Clean-machine installer test harnesses (Windows Sandbox + Windows containers) live in
`scripts/sandbox` and `scripts/docker` — see [`scripts/README.md`](scripts/README.md).

### Sound packs (`npm run fetch:packs`)

The two imported voice packs — **Orc Peon** and **StarCraft Marine** — are sourced
from [PeonPing/og-packs](https://github.com/PeonPing/og-packs) and licensed
**CC-BY-NC-4.0** (non-commercial). Because they're third-party game audio, they are
**not committed** to this repo; `npm run fetch:packs` downloads them into
`resources/soundpacks/` so a source build has them. The bundled `default` pack (used
by the seeded alerts as a fallback) is original synthesized audio and ships with the
repo. Attribution and license are recorded in each pack's `manifest.json`.

## Extending it

The app is built as a small **module framework** — each feature (loot, kills,
leveling, alerts, buffs, …) owns a slice of log-derived state and pushes deltas to the
UI over one typed transport. Adding a new log-driven feature, a new alert trigger, or
support for a different server's log format is a documented, contained change. The
architecture, log formats, and extension contract are written up in
[`AGENTS.md`](AGENTS.md) — start there.

## Screenshots

<!-- TODO: add screenshots of the Plane of Sky tracker, DPS meter, and alerts view. -->

## License

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 Josh Moyers. (The imported voice
packs are CC-BY-NC-4.0 and are not part of this repository; see above.)
