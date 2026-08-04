# Chunked replay — main never blocks, and a bench that proves it

Design by the integrator (Fable), 2026-08-04. Owner directive: kill the
blocked-main class at the root (IPC stalls, perf-HUD gaps, the WH_MOUSE_LL
freeze that ate the cursor for 10 s), and build a harness to measure
performance. Lands AFTER the v0.3.0 release.

## 0. The problem, measured

Startup replay folds the whole character log through the module pipeline
synchronously on the main process: 8.5–10 s blocked for ~1.23 M events
(perf-startup.json, two independent boots). While main is blocked, every
main-thread consumer starves: IPC, timers, the presence watcher's records,
and — until 70436d5 removed it — a system-wide mouse hook. Removing the hook
treated the symptom; the disease is the block itself.

## 1. The chunking rule

The replay fold becomes cooperatively scheduled on main:

- **A time budget per slice, not an event count**: process events until
  `performance.now() - sliceStart >= REPLAY_SLICE_MS` (12 ms), then yield via
  `setImmediate` and continue. Event-count chunks lie when event cost varies
  (combat-dense stretches are 10× quieter lines); a time budget bounds the
  block directly. Target invariant: **no main-loop block > 50 ms during
  replay** — the same threshold the perf HUD already calls "warn".
- **Order and outputs are untouched.** Chunking interleaves event-loop turns
  into the SAME sequential fold; every module sees the same events in the
  same order with the same `live=false`. Module logic keys off event
  timestamps, never wall clock — the doer verifies this claim against the
  modules (epoch detector, celebration gating, windows) and pins it: golden
  outputs byte-identical chunked vs unchunked over the proc/combat fixtures.
- **Late-arriving live lines stay correct.** Whatever the session does today
  with lines appended while the scan runs (buffer-then-drain or
  read-to-EOF-then-follow) must hold under chunking — the doer reads
  session.ts first and states the mechanism in the commit. The handoff rule:
  replay drains to EOF, then the tail goes live; a line may never be folded
  twice or skipped.
- **IPC during replay**: snapshots requested mid-replay reflect the fold so
  far (same as today's post-replay state, just reachable earlier). The
  renderer already renders progressively off deltas; no new UI is required.
  A cheap `replayProgress` push (events folded / total bytes) MAY be added if
  the hydration screen wants it — optional, not a gate.

## 2. Always-on block instrumentation

The perf HUD's lag probe currently runs only while the HUD is enabled. Split
the concern: during startup (appReady → replayDone), a lightweight probe
ALWAYS runs (500 ms self-drift interval, unref'd) and its result —
`maxBlockMs`, `blocksOver50Ms` — is written into perf-startup.json beside the
phases. Cost is one timer for a few seconds; the launch you wish you had
profiled is always the one that happened. The HUD's live probe is unchanged.

## 3. The bench harness

`npm run bench:replay` — a spec-shaped harness (tests/bench/replay.bench.mts,
modeled on the e2e appHarness, NOT registered in run-all) that:

1. Boots the real app against a fixed large log (the harness's standard
   fixture path; falls back to the machine's real log with a note — numbers
   from the real log are not comparable across machines and the output says
   so).
2. Reads perf-startup.json: replay ms, events, events/sec, maxBlockMs,
   blocksOver50Ms, plus per-phase table.
3. Prints one comparison-friendly table and appends a JSON line to
   `.bench/replay.jsonl` (gitignored) so runs accumulate locally — the
   before/after ledger for THIS change and every future pipeline change.
4. Asserts two budgets, both stated in the file with their rationale:
   `maxBlockMs <= 50` (the chunking invariant) and an events/sec FLOOR set at
   0.5× the pre-chunking measured rate (~145k/s → floor 70k/s) — chunking may
   cost throughput, but not half of it. Budgets are constants a human edits
   deliberately, never auto-ratcheted.

Run it once BEFORE the chunking change lands (on the unchunked code) to
record the baseline line in .bench/replay.jsonl — the change's own report
must quote before/after from the same machine.

## 4. Verification

- Golden equivalence: chunked fold output identical to unchunked across the
  proc/combat/leveling fixtures (the engine's existing goldens are the
  oracle; a seam flag `EQ_REPLAY_UNCHUNKED=1` may exist for the comparison
  test only if needed, and must not survive as a user-facing knob).
- Unit: the slicer (budget honored with a fake clock; a single monster event
  still yields after; EOF drain; no double-fold at the live handoff).
- Bench: before/after table in the final report; maxBlockMs ≤ 50 after.
- e2e: the existing perf spec keeps passing; replayDone still marked once,
  events count unchanged.

## 5. Sequencing

After v0.3.0 ships. Files: src/main/session.ts / pipeline.ts / perf.ts,
tests/bench/ (new), package.json script. Disjoint from the alerts doer and
the A2/A3 doer.
