# Proc visibility — the ledger stops hiding, and drill rows learn their rate

Design by the integrator (Fable), 2026-08-04. Owner feedback: "not sure where
we're showing proc information — it should be shown in a panel in combat; if
we detect a spell is a proc, the proc rate should be shown in the drill
down/expand for that spell."

## 0. What exists (the discoverability failure)

Proc information ships today as the SECOND TAB of the breakdown card
(BreakdownCard.tsx — composition | procs, ProcsPanel + ProcAnalytics behind
it). The card's own header comment explains the 2x2 grid is at the density
the 900 px window allows, so procs became a tab — correct structurally, but
the tab is a dead label: nothing on screen ever says proc data is IN there.
The owner, who built the feature's backend, could not find it. That is the
bug.

## 1. Make the ledger announce itself (no fifth grid cell)

1. **Live tab badge.** The Procs tab label carries the fight's proc count and
   rate when non-zero — `Procs · 12 (3.1/min)` — computed from the same
   ProcsView the panel renders (one source of truth, no second rollup). Zero
   procs = plain label, exactly as today.
2. **A one-line summary strip inside the composition body** when the selected
   fight has proc activity: `Procs: 12 landed · 3.1/min · slow landed +4s`
   (the slow fragment only when the ProcsView carries one), clicking it
   switches to the Procs tab. One Typography row, no card, no new cell — the
   panel stays where density allows, but its existence is now stated where
   the eyes already are.

## 2. Proc rate in the spell drill

The level-2 drill / expanded skill rows (flattenSkills → drill rows) learn
one honest fact: **when the row's skill is a detected proc, show its rate.**

- Sources of "is a proc": (a) the poison Strike names (poisons.ts — exact),
  (b) procDetect's cast-less inference (the spell landed with no cast line
  inside its window — the existing PROC_CAST_WINDOW_MS machinery), joined at
  view-build time in main (procViews / dashboardData), never re-derived in
  the renderer.
- The rate shown is the one the proc ledger already computes (per-minute over
  ACTIVE fight time, the procWindows PPM convention) — the drill row and the
  ledger can never disagree because the number is read from the same view.
- Presentation: a small right-aligned annotation on the expanded row —
  `proc · 3.1/min` — with a tooltip naming the window basis (active seconds,
  count). No annotation for non-proc rows; no guessing when the ledger has
  no entry for the skill.

## 3. Verification

- Unit: the is-proc join (poison strikes exact-match; procDetect-inferred
  names annotate; ordinary melee/cast rows do not), and the badge/strip
  number equals the ProcsView totals the panel itself renders (pin equality,
  not re-computation).
- Fixture-driven: w36/w41 poison fixtures produce a ProcsView whose count and
  rate light the badge, the strip, and the Weakening/Venom drill rows.
- e2e: combat dashboard spec — if it already drives the breakdown card, add
  the badge assertion; otherwise unit coverage suffices this wave.

## 4. Sequencing

Combat-feature files only (BreakdownCard, ProcsPanel/ProcAnalytics label
surface, dashboardData/procViews join, tests). Independent of everything in
flight (alerts dialog, analytics A1, perf HUD). Dispatchable immediately.
