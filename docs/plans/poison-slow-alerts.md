# Poison-slow alerts — suggested, and auto-offered when slows are observed

Design by the integrator (Fable), 2026-08-04. Owner ask: "suggested alerts
auto-detected from rogue slows landing," researched against the live log and
the EQ Legends wiki cache.

## 0. Facts the design stands on (verified)

- The rogue slow is **Weakening Strike**, granted by four utility poisons
  (Weakening 4, Binding 25, Neurotoxic 28, Paralytic 42 — `poisons.ts` roster,
  matches Rogue.wikitext). Landing emote on a mob: **`'s limbs move slower!`**
  (on you: `Your limbs slow down!`). Duration 3:30 (`spells.json` 210000 ms).
  The wiki self-contradicts on the percentage (35% vs 15%) — **no UI copy may
  print a slow percentage** until that is resolved; duration is safe.
- The parser already emits first-class `poisonProc` events with
  `effect: 'slow'` (`parseCasts.ts` → `procRouting.ts:161-182`, which even
  pushes a timeline `slow` marker). Fixtures exist: `w36-poison-slow-timing.log`,
  `w41-poison-asp-venom.log` — including the re-landing shape (four lands on
  one mob in ~45 s), so an alert without a cooldown is a klaxon.
- The alert engine would match `{event, kind:'poisonProc'}` TODAY
  (`alerts.ts:379` is a string compare, and `SPELL_FIELD_BY_KIND` already maps
  `poisonProc → 'strike'` for speech) — but `LogEventKind`
  (`alertTypes.ts:18-51`) and `ALL_LOG_EVENT_KINDS` (`logEventKinds.ts`) are a
  curated allowlist that omits the three poison kinds. Only the type union
  gates the feature.
- A **dead catalog suggestion exists**: `suggest:weakening strike:lands`
  (spellDb `templates.lands`) authors a `buffApply` trigger that can never
  fire — the parser cascade routes the emote to `poisonProc` first.

## 1. The four pieces

1. **Widen the kind union.** Add `poisonProc | poisonCoat | poisonDry` to
   `LogEventKind` and `ALL_LOG_EVENT_KINDS` (the `satisfies`/exhaustiveness
   pair keeps them in sync). No matcher changes needed.
2. **A verified alert group** in `alertGroups.ts`: **"Rogue slow poisons"** —
   one def, `alert:poison-slow-landed`, trigger
   `{type:'event', kind:'poisonProc', where:{effect:'slow'}}`,
   `cooldownMs: 30_000` (the proc re-lands every few seconds on the same mob;
   30 s ≈ one user-visible episode per pull without muting the next pull —
   fight-scoped dedupe is not expressible in the engine and is not worth
   building for this), `line`/`observed` quoting the exact fixture line per
   that file's law, and a `note` naming the 3:30 duration and the re-landing
   behavior. The on-you variant (`Your limbs slow down!`) ships ONLY if the
   doer can prove through the real parser what event it produces, with a
   fixture line — otherwise omit, never guess.
3. **The observed-driven offer** (the "auto-detected" half), following the
   `UpgradeOffers` precedent verbatim:
   - `AlertsModule` grows a `poisonSlowSeen` recency record — `{lastAt, count,
     lastTarget}` — recorded on replay AND live exactly as `spellLastCast` is,
     shipped in `AlertsSnap` + delta (zero new IPC).
   - A pure detector (`shared/` beside `detectRankUpgrades`):
     `(alerts, poisonSlowSeen) → Offer[]` — offers `offer:poison-slow` when at
     least one slow landing has been observed and no enabled alert already
     triggers on `poisonProc`/slow (idempotent against the group def's id).
   - Renderer: join hook beside `useUpgradeOffers` in `lineIntel.ts`, reusing
     the existing `eq.alerts.upgradeDismissed` localStorage set (offer ids are
     namespaced; no new key). Strip modeled on `UpgradeOffers.tsx`, rendered in
     `AlertsView.tsx` beside the existing one. Accept = create the group def
     (same id as the group panel path — one id, two entry points, idempotent).
     Copy: "Rogue slows are landing in your fights — alert when a mob gets
     slowed?" with the observed count.
4. **Fix the dead suggestion.** Suppress the spellDb `lands` template for any
   spell whose `msgCastOnOther` is claimed by `POISON_PROCS` (single source:
   `poisons.ts`) — Strike emotes are poison procs, not buff applies, and the
   wizard must stop offering an alert that cannot fire.

## 2. Verification

- Unit: kind-union exhaustiveness still holds; detector truth table (seen →
  offer; dismissed → none; alert exists → none; zero observations → none);
  the group def's trigger matches the fixture lines through the REAL parser +
  matcher (parse `w41` lines, assert the def fires, assert the cooldown
  suppresses the 4-in-45s re-landing to one firing).
- The dead-template fix: assert `weakening strike` no longer yields a `lands`
  suggestion, and that a normal detrimental spell still does.
- e2e: not required this wave; the strip reuses a proven component pattern.

## 3. Sequencing

Independent of analytics A1 (no shared files: no store migration — dismissal
is localStorage; no PreferencesView). Dispatchable immediately.
