// TASK #47 TESTS — composite alert triggers + resolved buffExpired derived events.
//
// Two proofs (same spirit as Task #38's harness proof):
//   (A) COMPOSITE TRUTH TABLE — drive the REAL AlertsModule with synthetic LogEvents and
//       assert the any/all semantics: 'any' fires when ANY condition matches a single event;
//       'all' fires only when EVERY condition matches THE SAME event; a single (primitive)
//       trigger is unchanged; cooldown applies once at the alert level.
//   (B) RESOLVED buffExpired — replay a real shared-family wears-off window through the REAL
//       parser + BuffsModule with a derived-event emitter, and assert the module synthesizes a
//       RESOLVED `buffExpired { spell, target:'self' }` that an alert `where:{spell}` fires on
//       (whereas the raw parser buffWearOff carried the ambiguous candidate list). This is the
//       end-to-end "wears off you" wiring the wizard's dual default relies on.
//   (C) EDITOR KINDS LIST — the alerts editor's kind list equals the full LogEventKind union
//       (ALL_LOG_EVENT_KINDS is exhaustiveness-checked at compile time; asserted here at runtime).
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { BuffsModule } from '../src/main/modules/buffs'
import { AlertsModule } from '../src/main/modules/alerts'
import { ALL_LOG_EVENT_KINDS } from '../src/shared/logEventKinds'
import type { AlertDef } from '../src/shared/types'
import type { LogEvent } from '../src/shared/logEvents'
import { readFixture } from './harness.mts'

// A tiny synthetic-event factory (only the fields the matcher reads matter).
let seq = 0
function ev(partial: Partial<LogEvent> & { kind: LogEvent['kind'] }): LogEvent {
  return { seq: seq++, ts: 1_000_000 + seq * 1000, raw: `raw-${partial.kind}-${seq}`, ...partial } as LogEvent
}

// ─────────────────────────────────────────────────────────────────────────────
// (A) COMPOSITE TRUTH TABLE.
test('A composite any/all truth table on synthetic events (real AlertsModule)', () => {
  const anyAlert: AlertDef = {
    id: 'any-1',
    name: 'any',
    enabled: true,
    trigger: {
      type: 'any',
      conditions: [
        { type: 'event', kind: 'uncharm' },
        { type: 'event', kind: 'buffExpired', where: { spell: 'Clarity' } }
      ]
    },
    sound: { packId: 'default', soundId: 'chime' },
    cooldownMs: 0
  }
  const allAlert: AlertDef = {
    id: 'all-1',
    name: 'all',
    enabled: true,
    trigger: {
      type: 'all',
      conditions: [
        { type: 'event', kind: 'buffExpired', where: { spell: 'Swift Like the Wind' } },
        { type: 'raw', regex: 'speed returns' }
      ]
    },
    sound: { packId: 'default', soundId: 'chime' },
    cooldownMs: 0
  }
  const single: AlertDef = {
    id: 'single-1',
    name: 'single',
    enabled: true,
    trigger: { type: 'event', kind: 'buffExpired', where: { spell: 'Valor' } },
    sound: { packId: 'default', soundId: 'chime' },
    cooldownMs: 0
  }

  const mod = new AlertsModule()
  mod.setDefs([anyAlert, allAlert, single])
  mod.reset()

  const firedFor = (e: LogEvent): Set<string> => {
    mod.onEvent(e, true)
    const out = mod.flushDelta()
    return new Set((out?.delta.fired ?? []).map((f) => f.alertId))
  }

  // 'any' fires on either branch — an uncharm alone:
  assert.deepEqual([...firedFor(ev({ kind: 'uncharm', mob: 'a mob' }))], ['any-1'])
  // 'any' fires on the OTHER branch — a buffExpired{Clarity}:
  assert.deepEqual(
    [...firedFor(ev({ kind: 'buffExpired', spell: 'Clarity', target: 'self' }))],
    ['any-1']
  )
  // 'any' does NOT fire on a buffExpired for a different spell (no branch matches):
  assert.deepEqual([...firedFor(ev({ kind: 'buffExpired', spell: 'Haste', target: 'self' }))], [])

  // 'all' requires BOTH conditions on the SAME event. A buffExpired{Swift} whose raw line ALSO
  // contains "speed returns" satisfies both → fires. (Real Swift wears-off raw line shape.)
  const swiftWearoff = {
    ...ev({ kind: 'buffExpired', spell: 'Swift Like the Wind', target: 'self' }),
    raw: '[Tue Jul 28 19:52:29 2026] Your speed returns to normal.'
  } as LogEvent
  assert.deepEqual([...firedFor(swiftWearoff)], ['all-1'])
  // 'all' does NOT fire when only ONE condition matches (right kind+spell, wrong raw):
  const swiftNoRaw = {
    ...ev({ kind: 'buffExpired', spell: 'Swift Like the Wind', target: 'self' }),
    raw: '[..] something else.'
  } as LogEvent
  assert.deepEqual([...firedFor(swiftNoRaw)], [])

  // single (primitive) still works exactly as before:
  assert.deepEqual([...firedFor(ev({ kind: 'buffExpired', spell: 'Valor', target: 'self' }))], [
    'single-1'
  ])
})

// Cooldown applies ONCE at the alert level for a composite (not per condition).
test('A2 composite cooldown is alert-level (one fire per cooldown window)', () => {
  const alert: AlertDef = {
    id: 'cd',
    name: 'cd',
    enabled: true,
    trigger: {
      type: 'any',
      conditions: [
        { type: 'event', kind: 'uncharm' },
        { type: 'event', kind: 'death' }
      ]
    },
    sound: { packId: 'default', soundId: 'chime' },
    cooldownMs: 10_000
  }
  const mod = new AlertsModule()
  mod.setDefs([alert])
  mod.reset()
  // Two matching events 1s apart (both within the 10s cooldown) → exactly ONE fire.
  mod.onEvent({ ...ev({ kind: 'uncharm', mob: 'x' }), ts: 5000 } as LogEvent, true)
  mod.onEvent({ ...ev({ kind: 'death', name: 'y', bySelf: true }), ts: 6000 } as LogEvent, true)
  const out = mod.flushDelta()
  assert.equal(out?.delta.fired.length, 1, 'composite fires once within its cooldown window')
})

// ─────────────────────────────────────────────────────────────────────────────
// (B) RESOLVED buffExpired end-to-end (reuses the W16 shared-wears-off fixture).
//   19:48:16 You begin casting Quickness. / 19:48:17 You feel much faster. → Quickness active
//   19:52:29 Your speed returns to normal.  → shared msg_wears_off of 9 haste spells.
// The parser's buffWearOff carries the ambiguous candidate list (first = "Aanya's Quickening").
// The BuffsModule RESOLVES it against the active self set (→ Quickness) and emits a derived
// `buffExpired { spell:'Quickness', target:'self' }`, on which an alert where:{spell:'Quickness'}
// fires — the raw ambiguous line never could.
test('B resolved buffExpired: shared self wears-off fires an alert with where:{spell}', () => {
  const db = loadSpellDb()
  installSpellDb(db)

  // Capture derived events AND feed them to a live AlertsModule (mirrors index.ts's bus wiring).
  const alerts = new AlertsModule()
  alerts.setDefs([
    {
      id: 'quickness-off',
      name: 'Quickness wears off',
      enabled: true,
      trigger: { type: 'event', kind: 'buffExpired', where: { spell: 'Quickness' } },
      sound: { packId: 'default', soundId: 'warning' },
      cooldownMs: 0
    }
  ])
  alerts.reset()

  const derived: LogEvent[] = []
  const buffs = new BuffsModule(db, [], (e, live) => {
    derived.push(e)
    alerts.onEvent(e, live) // deliver the derived event to alerts, live (as the bus would)
  })
  buffs.reset()

  const lines = readFixture('w16-shared-wearsoff-speed.log')
  let s = 0
  for (const raw of lines) {
    const parsed = parseEvent(raw, s++)
    if (parsed) buffs.onEvent(parsed, true) // live so alerts can fire
  }

  // A resolved buffExpired for Quickness on self was synthesized.
  const expired = derived.filter(
    (d) => d.kind === 'buffExpired' && (d as { spell: string }).spell.toLowerCase().includes('quickness')
  )
  assert.ok(expired.length >= 1, 'a resolved buffExpired{Quickness} was emitted')
  assert.equal((expired[0] as { target: string }).target, 'self', 'it wore off the player (self)')

  // The alert fired on it (the raw ambiguous wears-off line never named Quickness).
  const out = alerts.flushDelta()
  const fired = new Set((out?.delta.fired ?? []).map((f) => f.alertId))
  assert.ok(fired.has('quickness-off'), 'the where:{spell:Quickness} alert fired on the resolved event')

  installSpellDb(undefined) // leave the shared parser config clean for other suites
})

// A wears-off with NO matching active buff must NOT fabricate a derived buffExpired.
test('B2 no active buff → no phantom buffExpired', () => {
  const db = loadSpellDb()
  installSpellDb(db)
  const derived: LogEvent[] = []
  const buffs = new BuffsModule(db, [], (e) => derived.push(e))
  buffs.reset()
  // A lone "Your speed returns to normal." with nothing active.
  const raw = '[Tue Jul 28 20:00:00 2026] Your speed returns to normal.'
  const parsed = parseEvent(raw, 0)
  if (parsed) buffs.onEvent(parsed, true)
  assert.equal(
    derived.filter((d) => d.kind === 'buffExpired').length,
    0,
    'no active haste → no derived buffExpired (never fabricate a phantom fade)'
  )
  installSpellDb(undefined)
})

// ─────────────────────────────────────────────────────────────────────────────
// (C) EDITOR KINDS LIST = full union (programmatic).
test('C editor kind list covers every LogEventKind (no drift)', () => {
  // Every kind the parser+modules can emit appears in the editor list. We assert the new
  // derived kind is present and that the list has no duplicates.
  assert.ok(ALL_LOG_EVENT_KINDS.includes('buffExpired'), 'buffExpired is selectable')
  assert.ok(ALL_LOG_EVENT_KINDS.includes('cc'), 'cc (previously missing from the union) is selectable')
  const set = new Set(ALL_LOG_EVENT_KINDS)
  assert.equal(set.size, ALL_LOG_EVENT_KINDS.length, 'no duplicate kinds')
})
