# Performance profiling — a HUD you can leave on, and a startup you can read

Design by the integrator (Fable), 2026-08-04. Owner ask: memory + CPU visible,
toggled in Preferences, shown in the title bar when enabled; profile startup;
motivated by observed CPU stutter around a hot/manual reload (cause unproven —
possibly external load from parallel agent builds — which is exactly the point:
the app should be able to EXONERATE itself).

## 0. Decisions

| # | Decision |
|---|---|
| P1 | **`app.getAppMetrics()` is the one source for live numbers.** Main polls it every 2 s while the HUD is enabled (never otherwise — an off HUD costs zero), aggregates per process type (main / renderer / gpu / utility), and pushes one compact `PerfSample` to the renderer over a push channel. No renderer-side polling, no `performance.memory` (Chromium-only, imprecise, redundant next to workingSetSize). |
| P2 | **Stutter is measured, not vibed.** Two jank probes ride the same sample: main-process event-loop lag (a 500 ms interval measuring its own drift; p95/max over the window) and a renderer `PerformanceObserver('longtask')` count. CPU% alone cannot distinguish "the app is busy" from "the app is BLOCKED"; lag can — and high lag with low app CPU says the machine, not the app (the agent-wave case). |
| P3 | **Title bar chip, compact and honest.** When enabled: `CPU 12% · 480 MB`, colored only by event-loop-lag severity (normal / warn ≥50 ms p95 / alert ≥200 ms max — thresholds are shared constants). Click opens a popover: per-process-type table (CPU%, memory), lag p95/max, longtask count, and a 60-sample sparkline. Lives in TitleBar.tsx beside the existing controls; hidden entirely when disabled (no empty placeholder). |
| P4 | **Startup is phases, recorded ALWAYS.** Marking costs microseconds, so every launch writes `<userData>/perf-startup.json` (last profile only, atomic write) whether the HUD is on or off — the launch you wish you had profiled is always the one that already happened. Phases are a closed enum marked from the composition root: `appReady → protocols → storeLoaded → dataLoaded (spell DB / mob catalog / maps) → windowCreated → tailAttached → replayDone (with events-replayed count) → rendererHydrated` (renderer reports its mark over IPC). One `logInfo` summary line per launch. |
| P5 | **Preferences → Performance**: the HUD toggle (default OFF, store migration — the version number is whatever is next when this dispatches; the analytics wave owns the migration file until it lands) and a read-only "Last startup" breakdown: per-phase bars with ms, total, events replayed, and the launch timestamp — so a stuttery reload is inspectable AFTER the fact from inside the app. |
| P6 | **No history, no upload.** The HUD is a live instrument, not a datastore: one startup profile on disk, a 60-sample ring in renderer memory, nothing else retained and nothing transmitted. (The analytics plan's `coldStartMsBucket`/`healthCounters` may later read the same marks — that linkage stays in the analytics plan, behind its consent gate.) |
| P7 | e2e asserts: chip absent by default, present after enabling, popover renders numbers; startup profile file exists and phases are monotonic. Unit tests pin the pure parts: sample aggregation, lag stats, severity thresholds, phase accounting (out-of-order marks are a typed error, not NaN). |

## 1. Files (implementation map)

- `src/shared/perf.ts` — `PerfSample`, `StartupPhase` enum + `StartupProfile`,
  `PerfHudPrefs`, lag-severity thresholds, pure aggregation/format helpers.
- `src/main/perf.ts` — sampler (metrics poll + lag probe, unref'd, enabled-gated),
  startup marks (`markStartupPhase(phase)`), atomic profile persistence, IPC
  registration (`perf:sample` push, `perf:getStartup`, prefs get/set via store).
- `src/main/index.ts` — `markStartupPhase` calls at each existing boot step
  (the boot log lines already name them); sampler start/stop on pref change.
- `src/preload/index.ts` — `onPerfSample`, `getStartupProfile`, perf prefs bridge.
- `src/renderer` — TitleBar chip + popover (+ longtask observer while enabled);
  `features/preferences/PerfSetting.tsx` (toggle + startup breakdown);
  mount in PreferencesView.
- `src/main/store.ts` + `storeMigrations.ts` — `perfHud: { enabled: false }`.
- Tests: `tests/perf.test.mts` (pure), e2e additions per P7.

## 2. Sequencing

Blocked on analytics A1 landing (it owns `storeMigrations.ts` and
`PreferencesView.tsx`; append-only law, one appender at a time). Dispatch as a
single doer immediately after.
