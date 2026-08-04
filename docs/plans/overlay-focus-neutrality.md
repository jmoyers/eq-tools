# RETRACTED (2026-08-04) — the diagnosis below was wrong

The doer implementing this plan proved §0 misread the code: presence.ts's
own-windows rule (`pid === process.pid` ⇒ EQ-side, a deliberate design) already
made focus excursions into ANY of our windows — main included — invisible to
the model. The real mechanism was Z-ORDER: ring and overlays share the
'screen-saver' always-on-top level, the most recent assertion wins, and
auto-hide's re-shows re-asserted the overlays above the ring on every EQ
refocus. Fixed in windows.ts ("Cursor ring: above the overlays by INVARIANT"):
every overlay show/re-raise path now ends with raiseCursorRing(). The
implementation branch for THIS plan was discarded — its faithful rendering of
§1 would have regressed main-window focus behavior the codebase chose on
purpose. Kept for the record; nothing below is to be built.

# Overlay focus neutrality — mousing over our own windows is not leaving EQ

Design by the integrator (Fable), 2026-08-04. Owner report: with overlay
auto-hide on ("take off when not in EQ"), mousing over an overlay makes the
cursor ring flicker; the overlay should keep the ring there.

## 0. The mechanism

The presence watcher reports the FOREGROUND window; `overlaysShouldHide` and
`cursorRingActive` (presenceProtocol.ts) key off "EQ is focused." When the
pointer enters an interactive overlay (drag surface, buttons), that overlay
becomes the foreground window — our own window — and the model reads it as
"EQ lost focus": auto-hide arms, the ring parks, then EQ refocuses and it all
comes back. Flicker, caused by us watching ourselves.

## 1. The rule

**A focus excursion into one of the app's own OVERLAY windows is invisible to
the presence model.** While the foreground window is an overlay of ours, every
presence predicate keeps its previous answer (eqFocused stays whatever it
was). The MAIN app window keeps today's behavior — deliberately focusing the
main window IS leaving EQ; overlays exist inside the play loop, the main
window does not.

## 2. Implementation shape (doer verifies specifics against the code)

- The watcher's foreground record gains the foreground window's HWND (and/or
  pid) — presence.ts already P/Invokes GetForegroundWindow /
  GetWindowThreadProcessId; emit the handle it already holds.
- Main knows its own overlay windows' native handles
  (BrowserWindow.getNativeWindowHandle()); windows.ts maintains the live set
  (create/destroy). The protocol evaluation receives "foreground is one of
  our overlays" as a boolean fact — the pure predicates in
  presenceProtocol.ts take it as an input (`selfOverlayForeground`), and when
  true, the F record does NOT update eqFocused. Keep the predicates pure and
  the HWND matching at the boundary, so tests stay table-driven.
- The cursor ring window itself is click-through and should never take focus,
  but include it in the set anyway — a set-membership check costs nothing and
  a future interactive ring costs no regression.
- If the watcher cannot deliver HWND cheaply, pid + "is not the main window's
  current title" is NOT acceptable (title matching is how this class of bug
  is born); fall back to pid == our pid AND the main window is not focused
  (BrowserWindow.isFocused() in main at record-apply time) — state which path
  shipped and why.

## 3. Verification

- tests/presence.test.mts: table cases — EQ focused → overlay foreground →
  predicates unchanged (no hide, ring active); EQ focused → MAIN window
  foreground → today's behavior (hide arms); EQ never focused → overlay
  foreground → still inactive (an excursion cannot CREATE presence);
  excursion then real alt-tab to another app → hide arms from the real loss.
- Manual note for the owner: hover the fight overlay with auto-hide on — no
  ring park, no overlay blink.

## 4. Sequencing

Presence files only (presence.ts, presenceProtocol.ts, presencePrefs.ts,
windows.ts overlay-set plumbing, presenceEffects.ts if the ring gate reads a
new input). No conflict with in-flight doers (alerts dialog, notice bar,
perf HUD, combat proc panel). Dispatchable immediately.
