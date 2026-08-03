# Security

EQ Legends Companion is a desktop app that reads your EverQuest log file and shows
you what happened. This document is an honest description of what it touches, what
it does not, and how you can verify that the copy you installed is the one we built.

## Reporting a vulnerability

Use **[GitHub private security advisories](https://github.com/jmoyers/everquest-companion/security/advisories/new)**
— that gives us a private channel to confirm and fix before anything is public.

If advisories are unavailable to you, open a normal
[issue](https://github.com/jmoyers/everquest-companion/issues) and say only that you
have a security report and how to reach you; don't put the details in the issue.

This is a small hobby project maintained by one person. There is no bounty and no
guaranteed response time, but reports are taken seriously and credited unless you
ask otherwise.

## What the app touches

**On your machine**

| Thing                                              | Access                                 |
| -------------------------------------------------- | -------------------------------------- |
| Your EverQuest log file(s)                          | **read-only**, never modified or uploaded |
| `%APPDATA%\everquest-companion\`                    | read/write — your settings and progress |
| `%LOCALAPPDATA%\Programs\everquest-companion\`      | the install directory                   |
| Windows registry (`HKCU`, uninstall entry)          | written by the installer only           |

The app installs **per-user**. It never asks for administrator rights, and there is
no UAC prompt at install, update, or uninstall time — the installer is built with
`perMachine: false`, so it has no elevation manifest at all.

Your log file is the only game data it reads, and it is opened read-only. Log
contents are parsed locally and never leave your machine.

**Over the network** — four hosts, all HTTPS, all read-only GETs:

| Host                                             | Why                                                   |
| ------------------------------------------------ | ----------------------------------------------------- |
| `github.com` / `objects.githubusercontent.com`   | update checks and installer downloads                  |
| `wiki.project1999.com`                           | item lookups + item icons                              |
| `eqlwiki.com`                                    | item lookups + item icons                              |
| `peonping.github.io`, `raw.githubusercontent.com`| the optional sound-pack registry and pack downloads     |

Remote images are fetched only from an exact hostname allowlist
(`wiki.project1999.com`, `eqlwiki.com`), HTTPS only, default port only, no embedded
credentials, and are cached on disk after content sniffing.

## What the app never does

- No telemetry, analytics, crash reporting, or phone-home of any kind.
- No account, no login, no credentials, nothing stored that identifies you.
- Nothing about your logs, characters, or gameplay is ever uploaded anywhere.
- It does not write to, inject into, or otherwise touch the EverQuest client.
- It does not run with administrator privileges.
- It does not accept an update feed URL from settings, from the UI, or from any
  file on disk. The update source is compiled in.

## How updates are verified today

1. The app polls **only** the GitHub Releases of this repository, over HTTPS. The
   feed location is fixed at build time (`electron-builder.yml`); nothing in the
   settings store or the renderer process can point it elsewhere.
2. The feed (`latest.yml` / `main.yml`) carries a **SHA-512** for the installer.
   `electron-updater` streams the download through a digest transform and aborts
   with `ERR_CHECKSUM_MISMATCH` on any mismatch. The same check is applied to
   differential (block-map) downloads and re-applied to an already-staged
   installer before it is ever run.
3. Downgrades are refused (`allowDowngrade = false`), so a re-published or
   rolled-back release cannot walk an installation backwards.
4. Every release also ships **`SHA256SUMS.txt`** so you can verify a manual
   download yourself, independently of GitHub's TLS:

   ```powershell
   certutil -hashfile everquest-companion-Setup.exe SHA256
   ```

   ```sh
   sha256sum -c SHA256SUMS.txt
   ```

## What is NOT yet verified — read this part

**The Windows installer is currently unsigned.** That has two consequences, and
the second one is the one that matters.

1. The cosmetic one: SmartScreen shows a "Windows protected your PC" warning on
   first run. You have to click *More info → Run anyway*. This is expected today.

2. The real one: **because the build is unsigned, `electron-updater` has no
   publisher identity to check.** It verifies that the installer it downloaded is
   byte-for-byte the file the release feed describes — but not *who* produced that
   release. So the trust boundary of the auto-update path is exactly **the
   maintainer's GitHub account and this repository's release pipeline**. Anyone who
   could publish a release here — a compromised GitHub account, a stolen token, a
   malicious workflow change — could ship an update that every existing install
   would download, verify successfully (the sha512 would match, because the
   attacker generated it), and apply silently in the background. No warning, no
   prompt, no UAC.
   
   The blast radius is limited by the app being per-user and unelevated, but it is
   still arbitrary code running as you.

We do not think this is an acceptable end state, and it is being closed:

- **Code signing (in progress).** Azure Trusted Signing is wired into the release
  workflow and stays inert until the signing secrets exist. Once builds are signed,
  `electron-updater` enables `verifyUpdateCodeSignature` on Windows: the downloaded
  installer's Authenticode publisher is checked against the publisher recorded in
  the build, and a mismatch fails the update with `ERR_UPDATER_INVALID_SIGNATURE`.
  At that point compromising the GitHub account alone is no longer sufficient to
  ship an update.
- **Release-pipeline hardening (done).** CI publishes only from a pushed `v*` tag;
  only that one job holds a repository-write token (every other path runs read-only);
  all third-party GitHub Actions are pinned to commit SHAs; dependency install
  scripts are disabled (`.npmrc`, `ignore-scripts=true`) so a compromised npm
  package cannot execute code inside the release job.

Until signing lands, if you want certainty about a specific download, check it
against `SHA256SUMS.txt` on the release page and against the hash printed in the
public build log for that tag.

## Supply chain

- Dependencies are installed with `npm ci` from a committed lockfile; every entry
  carries a `sha512` integrity hash and resolves to `registry.npmjs.org`.
- `ignore-scripts=true` — no dependency's install hook executes on a developer
  machine or in CI. See `.npmrc`.
- All GitHub Actions are pinned to full commit SHAs, not mutable tags.
- Dependabot watches npm and Actions weekly (`.github/dependabot.yml`).
- The shipped runtime dependencies currently report **zero** known
  vulnerabilities (`npm audit --omit=dev`).

## Scope

In scope: anything that lets someone else read your data, run code on your machine
through this app, or tamper with an update. Out of scope: SmartScreen warnings on
unsigned builds (known, documented above), and anything requiring an attacker who
already has code execution on your machine.
