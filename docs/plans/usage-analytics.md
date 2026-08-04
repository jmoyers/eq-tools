# Usage analytics — opt-out, transparent, allowlist-only

Design by the integrator (Fable), 2026-08-04 (expanded same day: funnels, health,
retention, storage decision amended). Owner decisions: **opt-out** (overriding the
integrator's opt-in recommendation — recorded), privacy-focused and transparent,
near-real-time engagement, and — 2026-08-04 — **"more than the basics": design for
what the owner wants to SEE, not just what is easy to count.**

## 0. Decisions

| # | Decision |
|---|---|
| T1 | **Opt-out — but nothing transmits until the first-run notice has been SHOWN.** One modal, equal-prominence "Keep on / Turn off", no pre-checked anything, dismissal = keep on (that is what opt-out means), change any time in Preferences. Collection may buffer pre-notice; the network starts only after the notice renders. No silent pre-notice exfiltration, ever. |
| T2 | **Allowlist schema or it doesn't exist.** A versioned event union in `src/shared/telemetry.ts` — the schema structurally cannot express character names, zone/mob/spell/item names, log text, or anything typed. Where a raw number is itself revealing (log size, character count), the schema carries a **bucket**, and the buckets are enumerated in the schema so `TELEMETRY.md` shows them exactly. The shared validator runs client-side before buffering AND server-side (the feedback-contract pattern). |
| T3 | **A separate anonymous `analyticsId`** — NOT the feedback installId, deliberately non-correlatable, rotatable from Preferences (rotation wipes the local buffer too, and by design severs the retention chain — a rotated id is a new cohort member). Stated in the docs. |
| T4 | **Show the payload.** Preferences pane renders the live buffer + the last batch sent, as JSON. `TELEMETRY.md` committed in the repo enumerates every event/field/bucket, generated from the schema so it cannot drift (a test pins schema↔doc parity). |
| T5 | **Transport rides the feedback stack**: `POST /v1/telemetry` on the same API, same Lambda family, same kill-switch/caps philosophy (`feedback_config` gains `telemetry_accepting`, seeded false; per-id daily event cap; body cap before parse; route throttle). Client buffers to `<userData>/telemetry.json` (ring, cap ~500 events), flushes 60 s batches + a 5-min session heartbeat. Ships DARK (same endpoint-constant discipline; the dark build cannot send — pinned like feedback's). |
| T6 | **AMENDED 2026-08-04 — no DynamoDB.** The original T6 chose CloudWatch EMF + DynamoDB raw events (90-day TTL). Feedback's own DynamoDB design was overturned for Aurora DSQL before deploy; a second database technology for analytics would re-introduce exactly the operational spread that decision rejected. New shape: **ingest aggregates on arrival into DSQL** (`usage_daily` — the table the triage Analytics panel already names — plus `usage_funnel_daily` and `analytics_install`), **CloudWatch EMF for the near-real-time view**, and **no raw-event store at all** — the Lambda's CloudWatch log (14-day retention, counts only, no ids) is the only debugging tail. Aggregates are anonymous by construction; there is no per-user event trail to subpoena, leak, or delete. |
| T7 | e2e never sends; dev channel tagged and filtered by default; disable drops the buffer immediately; `analytics wipe --id` clears an id's `analytics_install` row (the only per-id row that exists). |

## 1. What the owner sees (the point of all of it)

Four surfaces, in order of reach-for-it-first:

1. **Triage → Analytics sub-tab** (the stub that already ships): fills its
   `available: true` arm from DSQL via the triage role. Sections: **Pulse**
   (DAU/WAU/MAU, sessions/day, median session length, sparklines over 90 days),
   **Adoption** (per-feature reach %, per-view dwell share, overlay/cursor-ring/
   voice-engine mix, alert-count distribution), **Funnels** (§3 — conversion and
   drop-off per step, per version), **Health** (crash-free session %, error-class
   counts, update success rate, voice-install failure classes), **Versions**
   (version/channel spread, days-to-adopt for each release).
2. **CloudWatch dashboard** (Terraform-defined, EMF-fed): active sessions now,
   events/min, ingest 4xx/5xx, per-funnel-step counters today. The "is anyone
   using it right now" glance.
3. **`triage-feedback analytics digest [--days N]`**: the same pulse/adoption/
   funnel/health numbers as text, for the terminal.
4. **`TELEMETRY.md`**: what users see; the contract the other three surfaces
   are allowed to know.

## 2. Event taxonomy (v1)

All events carry `{v, analyticsId, appVersion, channel, platform, tzOffsetBucket}`.
Counts are batched per flush — never per-click streams.

**Session & engagement**
- `sessionStart {coldStartMsBucket}` · `sessionHeartbeat {uptimeMs}` ·
  `sessionEnd {durationMs, viewsVisited}`
- `viewDwell {view, ms}` (flushed on switch) — view is the closed `KNOWN_VIEWS` enum
- `overlayToggle {kind, open}` · `featureUse {feature: closed enum, count}` —
  enum grows by schema PR only: mapOpen, rangeSelect, comboCorrection,
  feedbackOpen, alertGroupAdd, drillPet, copyView, speechPreview, mapSearch,
  procAnalyticsOpen, questFavorite, lootFilter, profileSwitch…
- `alertFired {count, spokenCount}` (rollup; no content)

**Scale & setup (buckets only — the schema defines the bucket edges)**
- `setupSnapshot {charCountBucket, logSizeBucket, alertCountBucket,
  overlaysEnabled: kind[], cursorRing: bool, autoHide: bool, voiceEngine:
  system|kokoro|off, soundPackCount, updateChannel}` — once per session, the
  "what does a typical install look like" record.

**Funnel steps (§3)** — `funnelStep {funnel, step, outcome?, failureClass?}`
with closed enums per funnel; failureClass is a coarse enum (network, checksum,
disk, timeout, other) — never a message.

**Health**
- `healthCounters {rendererCrashes, mainErrorLogLines, parserStalls,
  presenceRestarts, speechFailures}` (per-session rollup, counts only)
- `updateOutcome {step: check|download|apply, ok, failureClass?}`

## 3. Funnels — the instrument this week proved we need

Each funnel is a closed step enum; the panel shows per-step conversion and the
version where drop-off changed. Three at v1:

1. **First-run**: installed → log auto-detected (or manually set) → first parse
   complete → first non-overview view visited → first overlay enabled. The
   "does onboarding work without a human in the room" curve.
2. **Voice install**: engine set to kokoro → download started → completed |
   failed(class) → first utterance spoken. *The current release would have shown
   100% of installs stalling at "download started: never" — the exact bug the
   owner had to find by hand.*
3. **Feedback**: dialog opened → send pressed → sent | queued | failed. The
   server only ever sees arrivals; the interesting number is the gap between
   opened and sent.

## 4. Storage schema (DSQL, same cluster, same laws: no FKs, epoch-ms bigints, swept TTLs)

- `usage_daily (day text, metric text, dim text, n bigint, PK(day, metric, dim))`
  — every counter above rolls into this one narrow table; `dim` carries the
  closed-enum dimension value (view id, feature id, version…), `'—'` when none.
- `usage_funnel_daily (day, funnel, step, outcome, appVersion, n,
  PK(day, funnel, step, outcome, appVersion))`
- `analytics_install (analytics_id PK, first_seen_day, last_seen_day, days_seen,
  app_version, channel)` — one row per id, the entire per-id footprint;
  retention cohorts (D1/D7/D30) are computed from it at read time. `wipe --id`
  deletes the row.
- GRANTs mirror feedback's: the telemetry ingest role can UPSERT counters and
  its own `analytics_install` row and read `feedback_config`; it cannot read
  other tables. Triage role reads everything.

## 5. Waves

- **A1 — client (ships dark)**: shared schema + validator + TELEMETRY.md
  generator/test, `src/main/telemetry/` (collector, ring, flush loop, notice
  state, funnel-step + health sources), store migration v6 (telemetry prefs
  {enabled: true, noticeShown: false, analyticsId: null-until-first-run}),
  Preferences pane (toggle, rotate, payload viewer) + first-run notice modal,
  renderer sources via a `track()` preload method (fire-and-forget), e2e
  (notice renders; Turn off persists; dark build sends nothing — asserted
  structurally). Store-migration append is single-owner: dispatch only when no
  other agent owns `storeMigrations.ts`.
- **A2 — infra + CLI**: `/v1/telemetry` route + handler (validate → EMF emit →
  DSQL aggregate UPSERTs), `telemetry_accepting` kill switch, Terraform (route,
  lambda or handler extension, dashboard, alarms on ingest 5xx), `analytics
  digest`/`wipe --id` in the triage CLI. Rides the owner's next
  `terraform apply`.
- **A3 — the readout**: fill the Analytics sub-tab's `available: true` arm
  (Pulse / Adoption / Funnels / Health / Versions off `usage_daily` +
  `usage_funnel_daily` + `analytics_install`), plus the CloudWatch dashboard
  polish. A3 is what the owner actually asked for; A1/A2 exist so A3 has
  something true to draw.
