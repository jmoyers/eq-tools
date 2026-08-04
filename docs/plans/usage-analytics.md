# Usage analytics — opt-out, transparent, allowlist-only

Design by the integrator (Fable), 2026-08-04. Owner decisions: **opt-out**
(overriding the integrator's opt-in recommendation — recorded), privacy-focused
and transparent, near-real-time engagement (session duration, overlay on/off,
per-feature use). App-wide scope now; deeper per-feature instrumentation grows
behind the same schema.

## 0. Decisions

| # | Decision |
|---|---|
| T1 | **Opt-out — but nothing transmits until the first-run notice has been SHOWN.** One modal, equal-prominence "Keep on / Turn off", no pre-checked anything, dismissal = keep on (that is what opt-out means), change any time in Preferences. Collection may buffer pre-notice; the network starts only after the notice renders. No silent pre-notice exfiltration, ever. |
| T2 | **Allowlist schema or it doesn't exist.** A versioned event union in `src/shared/telemetry.ts` — the schema structurally cannot express character names, zone/mob/spell/item names, log text, or anything typed. Fields: event kind, coarse feature ids, durations, counts, appVersion/channel/platform, schemaVersion. The shared validator runs client-side before buffering AND server-side (the feedback-contract pattern). |
| T3 | **A separate anonymous `analyticsId`** — NOT the feedback installId, deliberately non-correlatable, rotatable from Preferences (rotation wipes the local buffer too). Stated in the docs. |
| T4 | **Show the payload.** Preferences pane renders the live buffer + the last batch sent, as JSON. `TELEMETRY.md` committed in the repo enumerates every event/field, generated from the schema so it cannot drift (a test pins schema↔doc parity). |
| T5 | **Transport rides the feedback stack**: `POST /v1/telemetry` on the same API, same Lambda family, same kill switch/caps philosophy. Client buffers to `<userData>/telemetry.json` (ring, cap ~500 events), flushes 60s batches + a 5-min session heartbeat. Ships DARK (same endpoint constant discipline; the dark build cannot send — pinned like feedback's). |
| T6 | **Server: CloudWatch Embedded Metrics for the near-real-time view** (active sessions, feature counters → CloudWatch dashboards, zero storage to build) + DynamoDB raw events with 90-day TTL for deeper cuts. Triage CLI gains `analytics digest`. |
| T7 | e2e never sends; dev channel tagged and filtered by default; disable drops the buffer immediately; `analytics wipe --id` in the CLI. |

## 1. Event taxonomy (v1)

`sessionStart {appVersion, channel, platform}` · `sessionHeartbeat {uptimeMs}` ·
`sessionEnd {durationMs}` · `viewDwell {view, ms}` (flushed on switch) ·
`overlayToggle {kind, open}` · `featureUse {feature: closed enum — mapOpen,
rangeSelect, comboCorrection, feedbackOpen, alertGroupAdd, drillPet, copyView,
speechPreview…, count}` (batched counts, not per-click events) · `alertFired
{count}` (rollup per flush, no content).

## 2. Waves

- **A1 — client (ships dark)**: shared schema + validator + TELEMETRY.md
  generator/test, `src/main/telemetry/` (collector, ring, flush loop, notice
  state), store migration (telemetry prefs {enabled: true, noticeShown: false,
  analyticsId: null-until-first-run}), Preferences pane (toggle, rotate,
  payload viewer) + the first-run notice modal, renderer event sources via a
  tiny `track()` preload method (fire-and-forget), e2e (notice renders; Turn
  off persists; dark build sends nothing — asserted structurally).
  SEQUENCING: storeMigrations.ts is owned by the voice W1 agent right now —
  A1 dispatches when it lands (append-only law, one appender at a time).
- **A2 — infra + CLI**: `/v1/telemetry` route + handler (validate, EMF emit,
  Dynamo put w/ TTL), Terraform additions to the same stack, `analytics
  digest`/`wipe` in the triage CLI. Rides the SAME `terraform plan` review the
  owner already owes F2 — one apply lights both features.
