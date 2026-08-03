# EQ Legends Companion

A Windows desktop companion for **EverQuest Legends**. It reads the log file the game
already writes and turns it into live, useful views — a DPS meter, floating overlays,
quest and loot tracking, alerts.

**It only reads your log.** Nothing is injected into EverQuest, no game files are
touched, no memory is read, and nothing is automated or played for you. If you turned
off logging, the app simply has nothing to show.

## What it does

- **Live DPS meter** — per-fight and per-zone numbers with fight history, drill-down
  into each attack and spell, and a timeline of the pull.
- **Floating overlays** — small always-on-top meters you can leave on top of the game:
  damage or healing, scoped to the current fight or the whole zone. Lock one and it
  becomes click-through.
- **Plane of Sky tracker** — every class's Test quests with "have / need" chips per
  item, item stats on hover, and sorting by closest-to-done.
- **Loot + item knowledge** — a running history of what you looted, and what each item
  is actually *for*: which quests use it, what it turns in for, which recipes consume it.
- **Leveling & AA** — XP and AA progress per character, with history.
- **Raid targets** — which named/raid mobs you've killed and when.
- **Buff timers** — remaining time on buffs, learned from the log *(early — still rough)*.
- **Sound alerts** — play a sound when something happens: a charm break, a buff fading,
  a raid target dying, or any log line you write a rule for. Voice packs included.

Everything is per-character; switch characters and the app re-reads that log.

## Getting started

1. Download `everquest-companion-Setup-<version>.exe` from the
   [**Releases**](https://github.com/jmoyers/everquest-companion/releases) page.
2. Run it. It's a one-click, per-user install (like Discord) — no admin prompt, no
   wizard. It adds a Start-menu and desktop shortcut.
3. In EverQuest, type `/log on`.

The app finds your log automatically — usually
`C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest Legends\Logs\`. If your
install lives somewhere else, point it at the right folder in **Settings**.

Overlays sit on top of the game in **windowed** or **borderless** mode. Exclusive
fullscreen can't be overlaid by anything, so use borderless if you want them.

### Code signing

The installer is code-signed as **Joshua Moyers** through Microsoft's Artifact
Signing service, and auto-updates are verified against that signature before they
install. If SmartScreen still shows a "Windows protected your PC" warning while
the certificate is new, click **More info**, then **Run anyway** — you only ever
see it once.

### Already have an old `eq-tools` install?

The app was renamed from `eq-tools` to `everquest-companion`, which Windows treats as a
different app — the new installer will *not* replace the old one, and the old install
will never auto-update again. Uninstall **eq-tools** once from Settings → Apps, then run
the new installer. Your settings, alerts and sound packs carry over automatically on
first launch (the old folder is left in place, untouched, as a backup).

## Updates

The app updates itself in the background from GitHub Releases. When a new version has
downloaded, an **"Update ready"** notice appears with a **Restart** button — click it to
apply now, or it installs the next time you quit.

## Make it yours

- **Sound & voice packs.** Alert sounds come from packs. One voice pack ships with the
  app and installs itself on first launch, and you can browse and install ~350 more from
  inside the app (**Alerts → Sound packs…**). To add your own: drop a folder into
  `%AppData%\everquest-companion\soundpacks\<your-pack>\` containing your `.wav`/`.mp3`/`.ogg`
  files and a small `manifest.json` naming them — it shows up in every sound picker. Want
  your own Final Fantasy fanfare on a raid kill? That's the whole job.
- **Share alerts.** Any alert (or all of them at once) copies to a short paste-safe
  string. Drop it in guild chat or Discord; whoever pastes it back in gets a preview
  before anything is added. Imports only ever *add* — they never overwrite your alerts.
- **Share your setup.** Export your whole settings bundle — alerts, volume, overlay
  look, view preferences, favorites — as one string or a file. It carries no file paths,
  no window positions, and no character progress.

## Development

Contributions welcome. Everything about building, testing, and the architecture lives in
[`AGENTS.md`](AGENTS.md) — start there.

## License

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 Josh Moyers.

The bundled **Alan Rickman** voice pack comes from
[utensils/openpeon-alan-rickman-soundpack](https://github.com/utensils/openpeon-alan-rickman-soundpack)
and is licensed CC-BY-4.0. Packs you install from the in-app browser carry their own
licenses and attribution (see each pack's manifest); none of them are part of this
repository.
