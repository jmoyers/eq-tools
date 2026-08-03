# scripts/ — build, packaging, and test tooling

Utility scripts for building, branding, and verifying the app. Run everything with
Node on PATH (`export PATH="/c/Program Files/nodejs:$PATH"` on this machine).

## Assets & data

| Script | `npm run` | What it does |
| --- | --- | --- |
| `gen-icon.mts` | `gen:icon` | Generates `build/icon.png` + `build/icon.ico` (dark panel + gold "EQ" mark) with zero deps. Re-run after editing the glyph. |
| `fetch-packs.mts` | `fetch:packs` | Downloads the shipped voice pack (`alan-rickman`, pinned tag — see `src/main/data/defaultPacks.ts`) into `resources/soundpacks/`, converting the source `openpeon.json` to our `manifest.json` shape. **The audio is gitignored** (it stays out of the public repo) — run this after a fresh clone before `npm run dist`. Idempotent: only missing/empty files are re-downloaded. |
| `scrape-posky.ts` / `scrape-bosses.ts` | `scrape:posky` / `scrape:bosses` | Refresh quest / raid-target data (offline, committed output). |

## Installer packaging

- **`seed-wincodesign.ps1`** — one-time, per-machine workaround for the winCodeSign
  extraction failure. electron-builder needs the winCodeSign toolchain (rcedit +
  signtool) to write the icon + version metadata into the exe. Its archive contains
  two macOS symlinks that can't be extracted on Windows without symlink privilege
  (Developer Mode), so extraction fails and `npm run dist` loops. This script
  extracts the archive with symlinks skipped straight into the cache dir
  electron-builder expects (`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0`).
  Run it once, then `npm run dist` builds a branded, versioned (still **unsigned**)
  installer.

  ```powershell
  ./scripts/seed-wincodesign.ps1
  npm run dist
  ```

  Alternative: enable Windows **Developer Mode** (grants symlink privilege) and
  electron-builder extracts winCodeSign itself — then the seed script isn't needed.

## Clean-machine installer harnesses (Task #25)

Two ready-to-run harnesses verify the installer on a pristine Windows (neither
Windows Sandbox nor Windows containers is enabled on this dev machine yet — enable
per the notes below, then run).

### Windows Sandbox — full GUI launch test (`scripts/sandbox/`)

`installer-test.wsb` maps `release/` read-only + a `results/` folder read-write into
a disposable sandbox, and on logon runs `installer-test.ps1`, which silent-installs
the newest `everquest-companion-Setup-*.exe`, verifies the install path + Start-menu shortcut +
that the **app window process starts**, silent-uninstalls, checks cleanup, and writes
`PASS`/`FAIL` + details to `scripts/sandbox/results/result.txt`.

```powershell
# one-time: enable Windows Sandbox (Win11 Pro/Enterprise), then reboot
Enable-WindowsOptionalFeature -Online -FeatureName 'Containers-DisposableClientVM' -All
# run:
WindowsSandbox scripts\sandbox\installer-test.wsb
# then read scripts\sandbox\results\result.txt
```

Host paths in the `.wsb` are absolute and assume the repo lives at
`C:\Users\jmoye\everquest-companion` — adjust if it moves.

### Windows containers — file-level verification (`scripts/docker/`)

`Dockerfile` (Server Core) silent-installs and asserts the app exe + uninstaller are
laid down, then silent-uninstalls and asserts cleanup — all at the file level (no
GUI). A failed check throws so `docker build` fails.

```powershell
# requires Windows containers (Docker Desktop → Switch to Windows containers)
docker build -f scripts/docker/Dockerfile -t everquest-companion-installer-test .
docker run --rm everquest-companion-installer-test
```

## CI (`.github/workflows/build.yml`)

- **push to `main`** → publishes a GitHub **prerelease** on the `main` update channel,
  version stamped `<pkg>-main.<run_number>` (CI-only edit).
- **push tag `v*`** → publishes a full GitHub **release** on the `latest` channel.

Both use `GITHUB_TOKEN` (no extra secrets). The app is unsigned.
