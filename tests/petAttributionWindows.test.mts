// Golden-window tests for PET ATTRIBUTION vs. the CHARM roster (Task: "N charmed" badge bug).
//
// The bug: the engine kept ONE name-set called `charmed` and the petClaim handler
// (`<Name> told you, '… Master.'`) added SUMMONED class pets to it. The snapshot exposed
// that whole set as `charmed`, so the Combat header rendered "1 charmed" listing Vebarn /
// Garer — random-named summoned pets that were never charmed by anything.
//
// The truth, verified against the real log (eqlog_Primitive_freeport.txt):
//   - SUMMONED class pets have random proper names (Garer, Vebarn, Gibober, Kaner…) and are
//     bound ONLY by the owner-only "… Master." tell. None of them EVER appears in a
//     `<mob> has been charmed.` line (full-log sweep: 373 charm-name/claim-name pairs; the
//     two name populations only overlap for genuinely-charmed mobs — see below).
//   - CHARMED pets are NPCs bound by `<mob> has been charmed.` — and they send the SAME
//     "… Master." tell (the kodiak window below is verbatim proof), which is exactly why
//     the claim tell can never be read as "this is a summoned pet, therefore charmed".
//   - Zone behavior differs and is load-bearing (AGENTS.md world-model law 4): a summoned
//     pet FOLLOWS you across a zone; a charmed pet is LEFT BEHIND.
//
// The fix under test: the engine's set is `petNames` — an ATTRIBUTION set holding both
// kinds (both attribute as `kind: 'pet'` on the meter, unchanged) — and the only charm
// roster is derived from the world model's `Instance.petKind === 'charmed'`
// (CombatEngine.charmedPetNames()). CombatSnapshot no longer carries a `charmed` field.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'

const FULL_LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

function replay(window: string[], live = false): { eng: CombatEngine; lastTs: number } {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  // The classification ring only records once the engine is live (historical replay is
  // silent), so tests that assert on snapshot.recent must opt in.
  if (live) eng.setLive()
  let seq = 0
  let lastTs = 0
  for (const raw of window) {
    const ev = parseEvent(raw, seq++)
    if (ev) {
      eng.ingestEvent(ev, false)
      lastTs = ev.ts
    }
  }
  return { eng, lastTs }
}

const lower = (xs: string[]): string[] => xs.map((s) => s.toLowerCase()).sort()

// ============================================================================
// W22 — SUMMONED pet (Vebarn) across TWO zone changes. Verbatim real log,
// Sat Aug 01 16:52:11 → 16:54:10 (log lines 874988–875202). Vebarn is a summoned class
// pet: it appears in 3 "… Master." tells in this window and in ZERO charm lines anywhere
// in the log.
//
// HAND-VERIFIED Vebarn damage:
//   BEFORE the zone (16:52:13, zone "The Ruins of Old Paineel - Solo 3 (Fused)" not yet
//   entered): Wrath 168 (spell) + slash 48 + cleave 42 + bash 11 + kick 42 (melee 143)
//     = 311 over 5 hits, plus 3 avoided swings (slash/crush/bash misses).
//   AFTER the two zone lines (16:54:10): slash 44 + bash 11 + kick 48 = 103 over 3 hits,
//     plus 3 avoided swings. This post-zone damage is the whole point: a summoned pet
//     must STILL attribute as your pet after zoning.
// ============================================================================
const SUMMONED_PRE: string[] = [
  "[Sat Aug 01 16:52:11 2026] Vebarn told you, 'Attacking a flighty fiend Master.'",
  '[Sat Aug 01 16:52:13 2026] Vebarn hit a flighty fiend for 168 points of magic damage by Wrath.',
  '[Sat Aug 01 16:52:13 2026] Vebarn slashes a flighty fiend for 48 points of damage.',
  '[Sat Aug 01 16:52:13 2026] Vebarn tries to slash a flighty fiend, but misses!',
  '[Sat Aug 01 16:52:13 2026] Vebarn tries to crush a flighty fiend, but misses!',
  '[Sat Aug 01 16:52:13 2026] Vebarn cleaves a flighty fiend for 42 points of damage.',
  '[Sat Aug 01 16:52:13 2026] Vebarn tries to bash a flighty fiend, but misses!',
  '[Sat Aug 01 16:52:13 2026] Vebarn bashes a flighty fiend for 11 points of damage.',
  '[Sat Aug 01 16:52:13 2026] Vebarn kicks a flighty fiend for 42 points of damage.',
  '[Sat Aug 01 16:52:28 2026] You have slain a flighty fiend!'
]
const SUMMONED_ZONE: string[] = [
  '[Sat Aug 01 16:52:42 2026] You have entered Paineel.',
  '[Sat Aug 01 16:53:38 2026] You have entered The Ruins of Old Paineel - Solo 3 (Fused).',
  '[Sat Aug 01 16:53:38 2026] You have entered an area where levitation effects do not function.'
]
const SUMMONED_POST: string[] = [
  '[Sat Aug 01 16:54:10 2026] Vebarn tries to slash an elemental warrior, but an elemental warrior parries!',
  '[Sat Aug 01 16:54:10 2026] Vebarn slashes an elemental warrior for 44 points of damage.',
  '[Sat Aug 01 16:54:10 2026] Vebarn tries to cleave an elemental warrior, but misses!',
  '[Sat Aug 01 16:54:10 2026] Vebarn tries to bash an elemental warrior, but misses!',
  '[Sat Aug 01 16:54:10 2026] Vebarn bashes an elemental warrior for 11 points of damage.',
  '[Sat Aug 01 16:54:10 2026] Vebarn kicks an elemental warrior for 48 points of damage.'
]

test('W22: a claimed SUMMONED pet attributes as your pet — and is NOT in the charm roster', () => {
  const { eng, lastTs } = replay(SUMMONED_PRE)
  const snap = eng.snapshot(lastTs + 90_000, { selectedId: 'zone' })

  // Attribution is UNCHANGED by the fix: the summoned pet is a `pet` source row.
  const pet = snap.selected!.entities.find((e) => e.kind === 'pet')
  assert.ok(pet, 'Vebarn is an outgoing pet source')
  assert.match(pet!.name, /Vebarn/)
  assert.equal(pet!.total, 311, 'hand-verified pet damage (168 spell + 143 melee)')
  assert.equal(pet!.hits, 5)
  assert.equal(pet!.misses, 3, 'avoided pet swings still attach to the pet')
  const byCat = new Map(pet!.categories.map((c) => [c.category, c.total]))
  assert.equal(byCat.get('melee'), 143)
  assert.equal(byCat.get('spell'), 168)

  // …but a SUMMONED pet is never "charmed".
  assert.deepEqual(eng.charmedPetNames(), [], 'the charm roster is empty — nothing was charmed')
  assert.deepEqual(lower(eng.petDisplayNames()), ['vebarn'], 'it IS a live pet (attribution roster)')
})

test('W22: the snapshot exposes NO charm roster at all (the lying field is gone)', () => {
  const { eng, lastTs } = replay(SUMMONED_PRE, true)
  const snap = eng.snapshot(lastTs + 90_000, {})
  assert.ok(!('charmed' in snap), 'CombatSnapshot must not carry a `charmed` field any more')
  // Nothing in the user-visible classification ring may call a summoned pet a charm.
  const claimLine = snap.recent.find((l) => l.text.includes('pet claim'))
  assert.ok(claimLine, 'the claim is logged')
  assert.equal(claimLine!.cat, 'pet', 'a summoned-pet claim is categorized "pet", never "charm"')
  assert.ok(
    !snap.recent.some((l) => /charm/i.test(l.text) && /Vebarn/.test(l.text)),
    'no recent line describes Vebarn as charmed'
  )
})

test('W22: a SUMMONED pet FOLLOWS you across zones and stays attributable', () => {
  const { eng, lastTs } = replay([...SUMMONED_PRE, ...SUMMONED_ZONE, ...SUMMONED_POST])
  // The zone lines reset the zone aggregate, so 'zone' now holds ONLY post-zone damage.
  const snap = eng.snapshot(lastTs + 90_000, { selectedId: 'zone' })
  assert.equal(snap.zone, 'The Ruins of Old Paineel - Solo 3 (Fused)', 'pseudo-zone line rejected')
  const pet = snap.selected!.entities.find((e) => e.kind === 'pet')
  assert.ok(pet, 'the summoned pet is STILL attributed as your pet after two zone lines')
  assert.match(pet!.name, /Vebarn/)
  assert.equal(pet!.total, 103, 'hand-verified post-zone pet damage (44 + 11 + 48)')
  assert.equal(pet!.hits, 3)
  assert.deepEqual(lower(eng.petDisplayNames()), ['vebarn'], 'survivor rebuild kept the summoned pet')
  assert.deepEqual(eng.charmedPetNames(), [], 'and it is still not a charm')
})

// ============================================================================
// W23 — CHARMED pet (a kodiak) that ALSO sends the "… Master." claim tell. Verbatim real
// log, Tue Jul 28 16:54:39 → 16:59:14 (log lines 214717–215017). This window is the
// counter-example that makes the whole distinction necessary: `A kodiak told you,
// 'Attacking a plains cat Master.'` fires 4s AFTER `a kodiak has been charmed.` — the
// claim tell alone can never mean "summoned".
//
// HAND-VERIFIED kodiak damage: crush 6 + cleave 7 + cleave 5 (a plains cat) + crush 9 +
// bash 1 (a giant spider) = 28 over 5 hits. Then the 16:59:00 zone line leaves it behind.
// ============================================================================
const CHARMED_PRE: string[] = [
  '[Tue Jul 28 16:54:39 2026] a kodiak has been charmed.',
  "[Tue Jul 28 16:54:43 2026] A kodiak told you, 'Attacking a plains cat Master.'",
  '[Tue Jul 28 16:54:43 2026] A kodiak crushes a plains cat for 6 points of damage.',
  '[Tue Jul 28 16:54:43 2026] A kodiak tries to crush a plains cat, but misses!',
  '[Tue Jul 28 16:54:43 2026] A kodiak tries to bash a plains cat, but misses!',
  '[Tue Jul 28 16:54:44 2026] A kodiak cleaves a plains cat for 7 points of damage.',
  '[Tue Jul 28 16:54:44 2026] A kodiak cleaves a plains cat for 5 points of damage.',
  '[Tue Jul 28 16:54:44 2026] A plains cat has been slain by a kodiak!',
  '[Tue Jul 28 16:54:52 2026] A kodiak crushes a giant spider for 9 points of damage.',
  '[Tue Jul 28 16:54:52 2026] A kodiak bashes a giant spider for 1 point of damage.',
  '[Tue Jul 28 16:54:56 2026] You have slain a giant spider!'
]
const CHARMED_POST: string[] = [
  '[Tue Jul 28 16:59:00 2026] You have entered East Commonlands.',
  '[Tue Jul 28 16:59:14 2026] You smite a young kodiak for 8 points of damage.',
  '[Tue Jul 28 16:59:14 2026] You kick a young kodiak for 60 points of damage.'
]

test('W23: a `has been charmed.` mob IS in the charm roster — and its Master tell never demotes it', () => {
  const { eng, lastTs } = replay(CHARMED_PRE)
  const snap = eng.snapshot(lastTs + 90_000, { selectedId: 'zone' })

  // Same attribution as a summoned pet — that dimension is deliberately identical.
  const pet = snap.selected!.entities.find((e) => e.kind === 'pet')
  assert.ok(pet, 'the charmed kodiak is an outgoing pet source')
  assert.match(pet!.name, /kodiak/i)
  assert.equal(pet!.total, 28, 'hand-verified charmed-pet damage')
  assert.equal(pet!.hits, 5)

  // The charm roster is the ONLY place the two kinds diverge.
  assert.deepEqual(lower(eng.charmedPetNames()), ['a kodiak'], 'a charmed mob IS charmed')
  assert.deepEqual(lower(eng.petDisplayNames()), ['a kodiak'], 'and is of course also a pet')
})

test('W23: a CHARMED pet is LEFT BEHIND on a zone (both rosters drop it)', () => {
  const { eng, lastTs } = replay([...CHARMED_PRE, ...CHARMED_POST])
  const snap = eng.snapshot(lastTs + 90_000, { selectedId: 'zone' })
  assert.equal(snap.zone, 'East Commonlands')
  assert.deepEqual(eng.charmedPetNames(), [], 'charm cannot survive a zone')
  assert.deepEqual(eng.petDisplayNames(), [], 'so the attribution set drops it too')
  // Post-zone damage is all yours; no pet row exists.
  assert.equal(snap.selected!.entities.filter((e) => e.kind === 'pet').length, 0)
  assert.equal(snap.selected!.entities.find((e) => e.id === 'you')!.total, 68)
})

test('W22+W23: the two kinds are indistinguishable for ATTRIBUTION, distinct for CHARM', () => {
  const summoned = replay(SUMMONED_PRE)
  const charmed = replay(CHARMED_PRE)
  for (const { eng, lastTs } of [summoned, charmed]) {
    const snap = eng.snapshot(lastTs + 90_000, { selectedId: 'zone' })
    assert.equal(snap.selected!.entities.filter((e) => e.kind === 'pet').length, 1, 'exactly one pet row either way')
  }
  assert.equal(summoned.eng.charmedPetNames().length, 0)
  assert.equal(charmed.eng.charmedPetNames().length, 1)
})

// ---- full-log tripwire (skipped when the real log is absent) ----

test('full-log: the charm roster only ever contains names a `has been charmed.` line named', { skip: !existsSync(FULL_LOG) }, () => {
  const lines = readFileSync(FULL_LOG, 'utf8').split(/\r?\n/)
  // Pass 1 — every name the LOG says was charmed (the ground truth).
  const everCharmed = new Set<string>()
  for (const raw of lines) {
    const m = /^\[[^\]]+\] (.+?) has been charmed\.$/.exec(raw)
    if (m) everCharmed.add(m[1].toLowerCase())
  }
  assert.ok(everCharmed.size > 50, `the log charms plenty of distinct mobs (got ${everCharmed.size})`)

  // Pass 2 — replay, sampling the roster at every charm and at the FIRST claim of each
  // distinct name (bounded work; the claim path is exactly where the bug lived).
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  const claimChecked = new Set<string>()
  let claimNamesChecked = 0
  let neverCharmedClaimsChecked = 0
  let seq = 0
  const check = (): void => {
    for (const n of eng.charmedPetNames()) {
      assert.ok(everCharmed.has(n.toLowerCase()), `"${n}" is reported charmed but was never charmed by a log line`)
    }
  }
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    eng.ingestEvent(ev, false)
    if (ev.kind === 'charm') check()
    else if (ev.kind === 'petClaim') {
      const key = ev.name.toLowerCase()
      if (claimChecked.has(key)) continue
      claimChecked.add(key)
      claimNamesChecked++
      check()
      if (!everCharmed.has(key)) {
        neverCharmedClaimsChecked++
        assert.ok(
          !eng.charmedPetNames().some((n) => n.toLowerCase() === key),
          `summoned pet "${ev.name}" must never appear in the charm roster`
        )
        assert.ok(
          eng.petDisplayNames().some((n) => n.toLowerCase() === key),
          `summoned pet "${ev.name}" must still be attributable as your pet`
        )
      }
    }
  }
  assert.ok(claimNamesChecked > 20, `many distinct pets claim you as Master (got ${claimNamesChecked})`)
  assert.ok(
    neverCharmedClaimsChecked > 10,
    `and most of them are SUMMONED — never charmed anywhere in the log (got ${neverCharmedClaimsChecked})`
  )
})
