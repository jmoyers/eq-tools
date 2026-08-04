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
| Your EverQuest log file(s)                          | **read-only**, never modified. Uploaded only as an opt-in, previewed, scrubbed slice attached to a bug report you send — see [Feedback reports](#feedback-reports) |
| `%APPDATA%\everquest-companion\`                    | read/write — your settings and progress |
| `%LOCALAPPDATA%\Programs\everquest-companion\`      | the install directory                   |
| Windows registry (`HKCU`, uninstall entry)          | written by the installer only           |

The app installs **per-user**. It never asks for administrator rights, and there is
no UAC prompt at install, update, or uninstall time — the installer is built with
`perMachine: false`, so it has no elevation manifest at all.

Your log file is the only game data it reads, and it is opened read-only. Log
contents are parsed locally, and they leave your machine in exactly one case: you
attach a slice to a feedback report and press Send, having seen it first.

**Over the network** — all HTTPS. Everything the app does on its own is a read-only
GET:

| Host                                             | Why                                                   |
| ------------------------------------------------ | ----------------------------------------------------- |
| `github.com` / `objects.githubusercontent.com`   | update checks and installer downloads                  |
| `wiki.project1999.com`                           | item lookups + item icons                              |
| `eqlwiki.com`                                    | item lookups + item icons                              |
| `peonping.github.io`, `raw.githubusercontent.com`| the optional sound-pack registry and pack downloads     |

Two more hosts are reached **only when you press Send in the feedback dialog**, never
on a timer and never at startup: our ingest API (`*.execute-api.us-east-1.amazonaws.com`)
and, if you attached a log slice, our own S3 bucket. The upload URL comes back from
the API, and the main process checks it against an exact hostname match for that one
bucket before a byte moves — a redirected or substituted URL uploads nothing. The
endpoint is compiled into the build; nothing in settings, in the UI, or on disk can
point it somewhere else.

Remote images are fetched only from an exact hostname allowlist
(`wiki.project1999.com`, `eqlwiki.com`), HTTPS only, default port only, no embedded
credentials, and are cached on disk after content sniffing.

## What the app never does

- No telemetry, analytics, crash reporting, or phone-home of any kind. The app
  sends us nothing unless you open the feedback dialog and press Send.
- No account, no login, no credentials, nothing stored that identifies you.
- Nothing about your logs, characters, or gameplay is uploaded on its own. The one
  exception is a log slice you deliberately attach to a bug report, after reading it.
- It does not write to, inject into, or otherwise touch the EverQuest client.
- It does not run with administrator privileges.
- It does not accept an update feed URL from settings, from the UI, or from any
  file on disk. The update source is compiled in.

## Feedback reports

The one place the app sends data anywhere is the feedback dialog, and only when you
press Send. [`README.md`](README.md#feedback) describes what a report contains; this
section is about what happens to it afterwards. Nothing here is a promise about a
third party — the ingest API, the database, and the bucket are ours, in a dedicated
AWS account, and the whole stack is in this repo under [`infra/`](infra/).

**How long each piece is kept:**

| Data | Kept |
| --- | --- |
| The report itself — type, your description, the version block | **indefinitely**. It *is* the bug backlog; deleting it would mean losing the bug. |
| An attached log slice | **90 days**, then the object expires automatically. This is an S3 lifecycle rule on the bucket, not a script we have to remember to run — and versioning is off, so an expired or deleted object is gone rather than shadowed by an old version. |
| Contact details | Reports no longer have a contact field — anything you want us to have goes in the description, where you can see it. Rows filed before that change still carry one, and it can be stripped on request without touching the report. |
| API gateway access logs, which include your source IP | **14 days**, then CloudWatch drops them. They exist for one reason: if the public endpoint is ever flooded, there is evidence for two weeks. **Your IP is never written onto a report and the two are never joined** — there is no query that turns an access log line back into "who filed what". |
| Rate-limit counters and duplicate-send keys | Days, not weeks (3 and 7 respectively), then deleted. |

**Asking us to delete something.** The dialog shows a **report id** after a successful
send — keep it. Quote that id in a
[GitHub issue](https://github.com/jmoyers/everquest-companion/issues) (or a
[private advisory](https://github.com/jmoyers/everquest-companion/security/advisories/new)
if you'd rather it not be public) and say what you want removed. Deleting a slice
deletes the object outright; stripping contact details clears the field and stamps the
row so we can tell it was done. The description itself stays unless you ask for the
whole report to go, in which case the report and its slice both go — that is what the
`wipe` path in the triage tool exists for.

Two things about how the collected data is handled, because they bound the damage a
mistake could do: **a log slice is never pasted into a public GitHub issue** (the repo
is public; an issue gets the description and a summary of what the log showed), and the
public ingest endpoint's database credentials can `INSERT` a report and touch the
counters — nothing more. It cannot read the backlog and it cannot delete anything, so
compromising the public half of the system leaks no reports.

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

## Code signing and the update trust chain

**Release builds are code-signed** ("Joshua Moyers", via Azure Artifact Signing;
CI injects the signing arguments on tagged releases — see `.github/workflows/`).
Two consequences:

1. SmartScreen: signed installers should not warn. If a warning appears while the
   certificate's reputation is new, *More info → Run anyway* — and the signature
   details on the exe are checkable either way (right-click → Properties →
   Digital Signatures).

2. The update path: `electron-updater` verifies more than transport integrity.
   Every download is checked byte-for-byte against the sha512 in the release
   feed, AND (because `publisherName` is set in electron-builder.yml) the
   downloaded installer's Authenticode publisher must match "Joshua Moyers" or
   the update fails with `ERR_UPDATER_INVALID_SIGNATURE` before anything runs.
   A compromised GitHub account alone is therefore no longer sufficient to ship
   a malicious update to existing installs: the attacker would also need the
   Azure signing identity. (Historical note: builds before v0.1.8 were unsigned
   and did not verify publisher identity; they will update to signed builds,
   and from then on the verification applies.)

- **Release-pipeline hardening.** CI publishes only from a pushed `v*` tag;
  only that one job holds a repository-write token (every other path runs read-only);
  all third-party GitHub Actions are pinned to commit SHAs; dependency install
  scripts are disabled (`.npmrc`, `ignore-scripts=true`) so a compromised npm
  package cannot execute code inside the release job.

For out-of-band certainty about a specific download, check it against
`SHA256SUMS.txt` on the release page and against the hash printed in the public
build log for that tag.

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
