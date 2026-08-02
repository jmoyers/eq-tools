// TASK #45 GOLDEN-WINDOW TESTS — three user-reported refinements.
//
// Same hand-verified golden-window methodology as the other suites (locate a real span in
// eqlog_Primitive_freeport.txt, extract it verbatim, replay through the REAL parser +
// BuffsModule, assert the world model). These pin the three Task #45 fixes:
//
//   #1  RECENCY SORT   — the suggested-alerts catalog sorts USED spells by lastSeenTs DESC
//                        (recent over frequent), tie-break usage, then the never-used tail.
//   #2  SHARED WEARS-OFF — a wears-off message shared by many spells ("Your speed returns to
//                        normal." = 9 haste spells) removes whichever matching ACTIVE self
//                        buff exists, not just the first candidate.
//   #3  OWN-CAST GATING — a message-driven apply is tracked ONLY when attributable to the
//                        player's OWN cast (own castBegin in the landing window, or a Quick
//                        Buff burst). A stranger's buff landing on a nearby entity is skipped.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFixture, replayBuffsWithDb, findActive, activeNames, tsOf } from './harness.mts'
import { loadSpellDb, buildSpellCatalog } from '../src/main/data/spellDb'

// ─────────────────────────────────────────────────────────────────────────────
// W16 — SHARED WEARS-OFF removes the actually-active self haste (fix #2).
// Raw: eqlog lines 239510 (19:47:58) → 239943 (19:52:29), Tue Jul 28.
// HAND-VERIFIED sequence:
//   19:48:16  You begin casting Quickness.          (own self haste cast)
//   19:48:17  You feel much faster.                 → Quickness applies on SELF (resolved via
//                                                     the just-prior own cast; shared haste msg)
//   19:52:29  Your speed returns to normal.         → the SELF haste wears off.
// "Your speed returns to normal." is the shared msg_wears_off of NINE haste spells; its FIRST
// candidate is "Aanya's Quickening" (alphabetical), which is NOT what's active. The DEFECT was
// removing only that first candidate, so the active Quickness never cleared (the user reported
// their self haste stuck on the bar). The fix resolves against the ACTIVE self set.
test('W16 shared wears-off: "Your speed returns to normal." removes the active self Quickness', () => {
  const lines = readFixture('w16-shared-wearsoff-speed.log')

  // Mid-window (right after the apply, before the wears-off): Quickness is active on self.
  const mid = tsOf('[Tue Jul 28 19:48:30 2026] x')
  const before = lines.filter((l) => tsOf(l) <= mid)
  const snapBefore = replayBuffsWithDb(before, mid)
  const q = findActive(snapBefore, 'quickness')
  assert.ok(q, 'Quickness should be active on self after "You feel much faster."')
  assert.equal(q!.self, true, 'the haste is the player-cast self buff')

  // End of window: the "Your speed returns to normal." line at 19:52:29 removes it.
  const observe = tsOf('[Tue Jul 28 19:52:29 2026] x')
  const snapAfter = replayBuffsWithDb(lines, observe)
  assert.equal(
    findActive(snapAfter, 'quickness'),
    undefined,
    'the shared speed wears-off must clear the active self Quickness (not miss it on the wrong candidate)'
  )
  // And no OTHER haste-family member was fabricated as active by the shared-message handling.
  for (const name of ['aanya', 'alacrity', 'celerity', 'swift', 'flurry']) {
    assert.equal(findActive(snapAfter, name), undefined, `no phantom ${name} left active`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// W17 — OWN-CAST GATING skips a stranger's Symbol on the user's fight target (fix #3).
// Raw: eqlog line 45831 (16:19:58, Sun Jul 19).
//   16:19:58  Kahaptra Z`Taj is cloaked in a shimmer of glowing symbols.
// A nearby Teir`Dal priestess cast Symbol of Ryltan on Kahaptra Z`Taj (the user's engaged
// mob) — the cast-on-other landing emote names the TARGET, never the caster. There is NO own
// castBegin of any Symbol. The user reported this stranger-cast buff appearing on their list.
// With own-cast gating the apply is skipped entirely: nothing tracked.
test('W17 own-cast gating: a stranger Symbol landing on the fight target is NOT tracked', () => {
  const lines = readFixture('w17-own-cast-gating.log')
  const observe = tsOf('[Sun Jul 19 16:19:58 2026] x')
  const snap = replayBuffsWithDb(lines, observe)
  assert.equal(snap.active.length, 0, 'no buff tracked — the user cast nothing here')
  assert.ok(
    !activeNames(snap).some((n) => n.includes('symbol')),
    'a stranger-cast Symbol must never bind as the user’s buff'
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// W17b — OWN-CAST GATING lets a genuinely own-cast (Quick Buff) Symbol through (fix #3, the
// other side). Raw: the Aug 1 Quick Buff burst, lines 962955 → 963020 (23:19:xx).
//   23:19:21  You activate Quick Buff.                       (burst context)
//   23:19:24  The symbol of Pinzarn flashes before your eyes.
//   23:19:24  You healed Primitive … by Symbol of Pinzarn.   (self-heal-by-buff apply)
//   23:19:24  You feel valorous. / You feel much faster. / A cool breeze …  (burst applies)
// These are OWN casts (a Quick Buff burst applies MANY spells with no castBegin), so the gate
// WHITELISTS them: Symbol of Pinzarn + the burst buffs are tracked as SELF. This proves the
// gate blocks strangers (W17) without blocking the user's own burst buffs (existing behavior).
test('W17b own-cast gating: the player’s own Quick Buff burst buffs ARE tracked', () => {
  const lines = readFixture('w17-priming.log')
  const observe = tsOf('[Sat Aug 01 23:19:30 2026] x')
  const snap = replayBuffsWithDb(lines, observe)
  const sym = findActive(snap, 'symbol of pinzarn')
  assert.ok(sym, 'own Quick Buff Symbol of Pinzarn should be tracked')
  assert.equal(sym!.self, true, 'it is the player’s own self buff')
  // The other own burst self buffs land too (they share the Quick Buff attribution window):
  // Valor via its unique cast-on-you, Swift via the shared haste message (own burst context).
  const valor = findActive(snap, 'valor')
  assert.ok(valor && valor.self, 'own Valor tracked as a self buff')
  assert.ok(findActive(snap, 'swift like the wind'), 'own Swift tracked in the burst')
})

// ─────────────────────────────────────────────────────────────────────────────
// W18 — RECENCY SORT (fix #1). The suggested-alerts catalog must sort USED spells by
// lastSeenMs DESC (most recently seen first), tie-broken by usage, with the never-used spells
// as an alphabetical tail after all used ones. Built directly on buildSpellCatalog with a
// synthetic usage/lastSeen map so the ordering rule is asserted deterministically.
test('W18 recency sort: recent spells outrank merely-frequent ones; unused tail is last', () => {
  const db = loadSpellDb()
  // Pick three real DB spells with distinct keys. Give the FREQUENT one an OLD lastSeen and a
  // less-frequent one a RECENT lastSeen — recency must win.
  const usage = new Map<string, number>([
    ['clarity', 50], // frequent but OLD
    ['valor', 5], // infrequent but RECENT
    ['swift like the wind', 20] // middling, most recent
  ])
  const t0 = Date.parse('2026-08-01T00:00:00Z')
  const lastSeen = new Map<string, number>([
    ['clarity', t0], // oldest
    ['valor', t0 + 60_000], // +1m
    ['swift like the wind', t0 + 120_000] // +2m, newest
  ])
  const cat = buildSpellCatalog(db, usage, lastSeen)
  const used = cat.entries.filter((e) => e.usageCount > 0).map((e) => e.key)
  // The three used spells lead, ordered by recency DESC (swift, valor, clarity) — NOT by
  // frequency (which would put clarity first).
  assert.deepEqual(
    used.slice(0, 3),
    ['swift like the wind', 'valor', 'clarity'],
    'used spells sort by recency DESC, not frequency'
  )
  // Every used spell precedes every never-used spell.
  const firstUnused = cat.entries.findIndex((e) => e.usageCount === 0)
  assert.equal(firstUnused, cat.withUsage, 'the never-used tail begins exactly after all used spells')
  // The unused tail is alphabetical by name.
  const tail = cat.entries.slice(firstUnused).map((e) => e.name)
  const sortedTail = [...tail].sort((a, b) => a.localeCompare(b))
  assert.deepEqual(tail.slice(0, 20), sortedTail.slice(0, 20), 'unused tail is alphabetical')
})

// ─────────────────────────────────────────────────────────────────────────────
// W18b — lastSeenMs is populated on the buffs snapshot stats (fix #1 plumbing). The Quick Buff
// burst window makes Symbol/Valor/etc. "seen", so their stats carry a lastSeenMs at/after the
// burst — the recency signal the catalog join reads. (Reuses the W17b burst span.)
test('W18b lastSeenMs is recorded on snapshot stats after a burst', () => {
  const lines = readFixture('w17-priming.log')
  const observe = tsOf('[Sat Aug 01 23:19:30 2026] x')
  const snap = replayBuffsWithDb(lines, observe)
  const burstTs = tsOf('[Sat Aug 01 23:19:24 2026] x')
  const valor = snap.stats['valor']
  assert.ok(valor, 'Valor has a stat entry (it was applied)')
  assert.ok(valor.lastSeenMs != null && valor.lastSeenMs >= burstTs, 'Valor lastSeenMs >= burst ts')
})
