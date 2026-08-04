# What this app measures

<!-- GENERATED FILE — do not edit by hand.
     Rendered from src/shared/telemetry.ts by `npm run gen:telemetry-doc`.
     tests/telemetryDoc.test.mts fails if this file and the schema disagree. -->

EQ Legends Companion can send anonymous usage counts so the person building it can see
which parts are used and which parts break. It is **on by default**, you are asked about
it the first time you run the app, and you can turn it off at any time in
**Preferences → Usage analytics** — where you can also read the exact events waiting to be
sent, as JSON.

**Right now no build sends anything at all.** There is no endpoint compiled into the app,
so the "last batch sent" panel in Preferences is permanently empty. This page describes
what the schema is allowed to say when that changes.

## What can never be collected

Not "what we choose not to collect" — what the schema has no room for. Every field below
is either a number or one value from a fixed list printed on this page. There is no
free-text field anywhere in it, so there is nowhere for any of this to go:

- your character names, your server, your guild, anyone you play with
- zone, mob, spell, item or quest names
- anything you typed: chat, tells, search boxes, alert names, feedback text
- any line of your log, or any file path
- your IP address, your machine name, your account — there is no account

## What identifies a send

One random id (`analyticsId`), generated on your machine, stored in your settings file, and
deliberately **different from** the id a feedback report uses — the two cannot be joined.
You can replace it at any time from Preferences; doing so also throws away everything
waiting to be sent, and the new id looks like a brand-new install.

| Field | Values |
| --- | --- |
| `analyticsId` | a random UUID, replaceable from Preferences |
| `appVersion` | the app version, e.g. `0.2.0` |
| `channel` | `prod` · `dev` |
| `platform` | `win32` · `darwin` · `linux` · `other` |
| `tzOffsetBucket` | your UTC offset in whole hours (-12 to 14) |

Events are held on your machine (at most 500 of them, oldest dropped first) and would
be sent in batches, not one by one. Schema version: 1.

## Events

### `sessionStart`

Once, when the app finishes starting up.

| Field | Values | What it means |
| --- | --- | --- |
| `coldStartMsBucket` | bucket index | How long the app took to become usable. |

### `sessionHeartbeat`

Every 5 minutes while the app is open — the "is anyone using it right now" signal.

| Field | Values | What it means |
| --- | --- | --- |
| `uptimeMs` | whole number | How long this session has been running. |

### `sessionEnd`

Once, when the app closes.

| Field | Values | What it means |
| --- | --- | --- |
| `durationMs` | whole number | How long the session lasted. |
| `viewsVisited` | whole number | How many different tabs were opened. |

### `viewDwell`

When you switch away from a tab.

| Field | Values | What it means |
| --- | --- | --- |
| `view` | `overview` · `combat` · `mobs` · `maps` · `bosses` · `posky` · `alerts` · `leveling` · `loot` · `buffs` · `preferences` · `triage` | Which tab. A fixed list of tab names. |
| `ms` | whole number | How long it was on screen. |

### `overlayToggle`

When you open or close a floating meter.

| Field | Values | What it means |
| --- | --- | --- |
| `kind` | `fight` · `overall` · `heal-fight` · `heal-overall` · `events` | Which overlay. |
| `open` | true / false | Opened or closed. |

### `featureUse`

When you use one of the listed features.

| Field | Values | What it means |
| --- | --- | --- |
| `feature` | `mapOpen` · `mapSearch` · `rangeSelect` · `comboCorrection` · `feedbackOpen` · `alertGroupAdd` · `drillPet` · `copyView` · `speechPreview` · `procAnalyticsOpen` · `questFavorite` · `lootFilter` · `profileSwitch` | Which one. A fixed list. |
| `count` | whole number | How many times, since the last batch. |

### `alertFired`

A rollup of how many alerts fired — never which alert, and never its text.

| Field | Values | What it means |
| --- | --- | --- |
| `count` | whole number | Alerts fired. |
| `spokenCount` | whole number | How many of those were spoken aloud. |

### `setupSnapshot`

Once per session: what a typical install looks like.

| Field | Values | What it means |
| --- | --- | --- |
| `charCountBucket` | bucket index | How many character logs the app can see. |
| `logSizeBucket` | bucket index | How big the log it reads is. |
| `alertCountBucket` | bucket index | How many alerts you keep. |
| `overlaysEnabled` | list of `fight` · `overall` · `heal-fight` · `heal-overall` · `events` | Which floating meters are open. |
| `cursorRing` | true / false | Is the cursor ring on. |
| `autoHide` | true / false | Is overlay auto-hide on. |
| `voiceEngine` | `system` · `kokoro` · `off` | Which speech tier. |
| `soundPackCount` | whole number | How many sound packs are installed. |
| `updateChannel` | `main` · `stable` | Update channel. |

### `funnelStep`

When you reach a step of one of the three flows listed below.

| Field | Values | What it means |
| --- | --- | --- |
| `funnel` | `first-run` · `voice-install` · `feedback` | Which flow. |
| `step` | a step of that flow (below) | Which step it reached. |
| `outcome` | `ok` · `failed` · `queued` (optional) | How it ended. |
| `failureClass` | `network` · `checksum` · `disk` · `timeout` · `other` (optional) | A coarse category when it failed. Never an error message. |

### `healthCounters`

Once per session: counts of things that went wrong. Counts only, never messages.

| Field | Values | What it means |
| --- | --- | --- |
| `rendererCrashes` | whole number | Window crashes. |
| `mainErrorLogLines` | whole number | Lines written to the local error log. |
| `parserStalls` | whole number | Times log reading stalled. |
| `presenceRestarts` | whole number | Times the game-window watcher restarted. |
| `speechFailures` | whole number | Times an utterance failed to speak. |

### `updateOutcome`

When an app update is checked for, downloaded, or applied.

| Field | Values | What it means |
| --- | --- | --- |
| `step` | `check` · `download` · `apply` | Which step. |
| `ok` | true / false | Did it succeed. |
| `failureClass` | `network` · `checksum` · `disk` · `timeout` · `other` (optional) | A coarse category when it failed. |

## Flows

A `funnelStep` event says which step of one of these you reached — nothing else.

**`first-run`** — `installed` → `logDetected` → `firstParse` → `firstNonOverviewView` → `firstOverlayEnabled`

**`voice-install`** — `engineSelected` → `downloadStarted` → `downloadCompleted` → `firstUtterance`

**`feedback`** — `dialogOpened` → `sendPressed` → `sendFinished`

## Buckets

Where a raw number would say too much about one person, the app sends a RANGE instead.
These are the exact ranges, taken from the schema:

**`coldStartMsBucket`** — How long the app took to start.

| Bucket | Range |
| --- | --- |
| 0 | < 1 s |
| 1 | 1 s – 2.5 s |
| 2 | 2.5 s – 5 s |
| 3 | 5 s – 10 s |
| 4 | 10 s – 20 s |
| 5 | ≥ 20 s |

**`charCountBucket`** — How many character logs the app can see.

| Bucket | Range |
| --- | --- |
| 0 | 0 |
| 1 | 1 |
| 2 | 2 |
| 3 | 3 – 4 |
| 4 | 5 – 8 |
| 5 | ≥ 9 |

**`logSizeBucket`** — Size of the log file being read.

| Bucket | Range |
| --- | --- |
| 0 | < 1 MB |
| 1 | 1 MB – 10 MB |
| 2 | 10 MB – 100 MB |
| 3 | 100 MB – 512 MB |
| 4 | 512 MB – 2 GB |
| 5 | ≥ 2 GB |

**`alertCountBucket`** — How many alerts are configured.

| Bucket | Range |
| --- | --- |
| 0 | 0 |
| 1 | 1 – 4 |
| 2 | 5 – 9 |
| 3 | 10 – 24 |
| 4 | 25 – 49 |
| 5 | ≥ 50 |

## Turning it off

**Preferences → Usage analytics** has one switch. Turning it off stops collection, throws
away everything currently held on your machine, and discards the random id — all
immediately. Nothing is kept to be sent later. Turning it back on starts from empty, with a
new id, which counts as a brand-new install.
