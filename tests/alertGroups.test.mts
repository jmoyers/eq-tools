// CURATED ALERT GROUPS — every group's trigger fires on the REAL log line it claims.
//
// The catalog (src/shared/alertGroups.ts) quotes an exact line shape and an occurrence count
// beside every trigger. This suite is the enforcement: each quoted line is pushed through the
// REAL parser and the REAL AlertsModule, and the group's alert must fire. A regex someone
// "improved" without re-reading the log, or an event kind whose `where` no longer matches the
// parser's field names, fails here instead of going silently mute in the user's ears.
//
// The line texts below are verbatim from eqlog_Primitive_freeport.txt (read-only sweep,
// 2026-08-03), with mob/spell names left as they appeared. They are authored inline rather
// than extracted into tests/fixtures/ because each is a single client notice with no
// surrounding state — there is no window to warm.
//
// It also pins the NEGATIVE half: the two groups the owner asked for that the log cannot
// support (feign-death failure, pet death) must stay unverified and unoffered, and the rank
// suggestion templates must fire on the rank-suffixed lines they were built from.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { AlertsModule } from '../src/main/modules/alerts'
import {
  ALERT_GROUPS,
  GROUP_SOUND_IDS,
  VERIFIED_ALERT_GROUPS,
  alertGroupDefs
} from '../src/shared/alertGroups'
import { REQUIRED_SOUND_IDS } from '../src/main/data/defaultPacks'
import type { AlertDef } from '../src/shared/types'

const TS = '[Tue Jul 28 13:04:53 2026] '

/** Feed raw log lines through the real parser into a module holding `defs`; return fired ids. */
function fire(defs: AlertDef[], lines: string[]): Set<string> {
  const mod = new AlertsModule()
  mod.setDefs(defs)
  mod.reset()
  let seq = 0
  for (const line of lines) {
    const ev = parseEvent(line, seq++)
    if (ev) mod.onEvent(ev, true)
  }
  return new Set((mod.flushDelta()?.delta.fired ?? []).map((f) => f.alertId))
}

/**
 * The exact line each group def claims to fire on. Keyed by def id so a new def without a
 * verified line breaks the completeness check below rather than shipping untested.
 */
const VERIFIED_LINES: Record<string, string[]> = {
  'group:range:melee': ['Your target is too far away, get closer!'],
  'group:range:spell': ['Your target is out of range, get closer!'],
  'group:range:sight': ['You cannot see your target.'],
  'group:resists:yours': ['A froglok ton knight resisted your Mesmerization III!'],
  'charm-break': ['Your Allure spell has worn off of an ice giant.'],
  'group:cc:broke': ['Your Mesmerization spell has worn off of a froglok ton knight.'],
  'group:invis:drop': ['You feel yourself starting to appear.', 'You become visible.'],
  'group:castFail:fizzle': ['Your Chaotic Feedback spell fizzles!'],
  'group:castFail:interrupted': ['Your Invisibility spell is interrupted.'],
  'group:castFail:blocked': [
    'Your Arch Shielding spell did not take hold. (Blocked by Talisman of Altuna.)'
  ],
  'group:mana:insufficient': ['Insufficient Mana to cast this spell!'],
  'group:death:you': ['You have been slain by a magician!'],
  // The rogue slow proc. Its full behaviour (the fixture window, the cooldown collapse, the
  // effect discriminator, the omitted on-you variant) lives in poisonSlowAlerts.test.mts;
  // this entry keeps it inside the completeness check every verified group def must pass.
  'alert:poison-slow-landed': ["Stonesoul the Unmoving's limbs move slower!"]
}

test('G1 every verified group def fires on its quoted real log line', () => {
  for (const group of VERIFIED_ALERT_GROUPS) {
    const defs = alertGroupDefs(group).map((d) => ({ ...d, cooldownMs: 0 }))
    for (const def of defs) {
      const lines = VERIFIED_LINES[def.id]
      assert.ok(lines, `no verified line recorded for ${def.id} — do not ship an unproven trigger`)
      for (const text of lines) {
        const fired = fire(defs, [TS + text])
        assert.ok(fired.has(def.id), `${def.id} did not fire on: ${text}`)
      }
    }
  }
})

test('G2 the group triggers do not fire on the wrong lines', () => {
  const all = ALERT_GROUPS.flatMap((g) => alertGroupDefs(g)).map((d) => ({ ...d, cooldownMs: 0 }))
  // Melee-range and spell-range are DIFFERENT sentences: neither may catch the other's line.
  const meleeOnly = fire(all, [TS + 'Your target is too far away, get closer!'])
  assert.ok(meleeOnly.has('group:range:melee'))
  assert.ok(!meleeOnly.has('group:range:spell'))

  // A resist by someone ELSE (a pet, a bystander, or one you took) is not YOUR spell resisted.
  const notYours = fire(all, [
    TS + "A froglok ton knight resisted Kibn's Mesmerization III!",
    TS + "You resist a froglok ton shaman's Drowsy!"
  ])
  assert.ok(!notYours.has('group:resists:yours'), "where:{caster:'you'} excludes other casters")

  // A CHARM spell wearing off is an uncharm, never the mez/root break — and vice versa.
  const charm = fire(all, [TS + 'Your Allure spell has worn off of an ice giant.'])
  assert.ok(charm.has('charm-break'))
  assert.ok(!charm.has('group:cc:broke'))
  const mez = fire(all, [TS + 'Your Mesmerization spell has worn off of a froglok ton knight.'])
  assert.ok(mez.has('group:cc:broke'))
  assert.ok(!mez.has('charm-break'))

  // Ordinary combat chatter fires nothing at all.
  const quiet = fire(all, [
    TS + 'You crush a hardened skeleton for 36 points of damage.',
    TS + 'You have entered West Freeport.',
    TS + 'A hardened skeleton has been slain by Giber!'
  ])
  assert.equal(quiet.size, 0)
})

test('G3 raw triggers anchor after the TIMESTAMP, not at ^ (raw carries the prefix)', () => {
  // LogEvent.raw is the WHOLE line including "[Tue Jul 28 …] ". A '^'-anchored pattern would
  // match nothing and the alert would be silently dead — this is the tripwire for that.
  for (const spec of ALERT_GROUPS.flatMap((g) => g.defs)) {
    const conditions = 'conditions' in spec.trigger ? spec.trigger.conditions : [spec.trigger]
    const anchored = conditions.filter((c) => c.type === 'raw' && c.regex.startsWith('^'))
    assert.equal(anchored.length, 0, `${spec.id} anchors at ^ — it can never match raw`)
  }
})

test('G4 the unverifiable groups stay unoffered, with the reason recorded', () => {
  const hidden = ALERT_GROUPS.filter((g) => !g.verified)
  assert.deepEqual(
    hidden.map((g) => g.id).sort(),
    ['feignDeath', 'petDeath'],
    'exactly the two the log cannot support'
  )
  for (const g of hidden) {
    assert.equal(g.defs.length, 0, `${g.id} must ship NO defs — a guessed regex is worse than none`)
    assert.ok((g.unverifiedReason ?? '').length > 80, `${g.id} must document why`)
    assert.ok(!VERIFIED_ALERT_GROUPS.includes(g), `${g.id} must not reach the UI`)
  }
})

test('G5 group def ids are unique and every group sound is provisioned', () => {
  const ids = ALERT_GROUPS.flatMap((g) => g.defs.map((d) => d.id))
  assert.equal(new Set(ids).size, ids.length, 'duplicate def ids would collide in the store')
  // The seeded charm-break alert id is reused ON PURPOSE so the group reads as already created.
  assert.ok(ids.includes('charm-break'))
  for (const soundId of GROUP_SOUND_IDS) {
    assert.ok(
      REQUIRED_SOUND_IDS.includes(soundId),
      `${soundId} is not verified after pack provisioning — it could resolve to nothing`
    )
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// The rank-pinned suggestion templates (spell levelling intelligence). These are the ONLY
// alert shapes that can go stale on a level-up, because they are the only two event families
// whose log line keeps the roman-numeral rank.

test('G6 rank-pinned triggers fire on the rank-suffixed lines they were built from', () => {
  const castRank: AlertDef = {
    id: 'r-cast',
    name: 'cast',
    enabled: true,
    trigger: { type: 'event', kind: 'castBegin', where: { spell: 'Mesmerization III' } },
    sound: { packId: 'alan-rickman', soundId: 'task-acknowledge-task-acknowledge-05' },
    cooldownMs: 0
  }
  const resistRank: AlertDef = {
    id: 'r-resist',
    name: 'resist',
    enabled: true,
    trigger: {
      type: 'event',
      kind: 'resist',
      where: { caster: 'you', spell: 'Mesmerization III' }
    },
    sound: { packId: 'alan-rickman', soundId: 'task-error-task-error-01' },
    cooldownMs: 0
  }
  const defs = [castRank, resistRank]
  assert.ok(fire(defs, [TS + 'You begin casting Mesmerization III.']).has('r-cast'))
  assert.ok(
    fire(defs, [TS + 'A froglok ton knight resisted your Mesmerization III!']).has('r-resist')
  )
  // A DIFFERENT rank must not fire them — that is exactly what makes an upgrade offer real.
  const other = fire(defs, [
    TS + 'You begin casting Mesmerization IV.',
    TS + 'A froglok ton knight resisted your Mesmerization IV!'
  ])
  assert.equal(other.size, 0, 'a rank-pinned alert goes silent on the next rank')
})

test('G7 the alerts module records rank-preserving cast recency, replay included', () => {
  const mod = new AlertsModule()
  mod.setDefs([])
  mod.reset()
  const lines = [
    TS + 'You begin casting Mesmerization III.',
    TS + 'You begin casting Mesmerization IV.',
    TS + 'Your Mesmerization spell has worn off of a froglok ton knight.'
  ]
  let seq = 0
  // live:false — the map must be complete at hydration, and firing must stay live-only.
  for (const line of lines) {
    const ev = parseEvent(line, seq++)
    if (ev) mod.onEvent(ev, false)
  }
  const snap = mod.snapshot().state
  assert.deepEqual(Object.keys(snap.spellLastCast ?? {}).sort(), [
    'Mesmerization III',
    'Mesmerization IV'
  ])
  // The rank-LESS wears-off line contributes nothing — it cannot name a rank.
  assert.equal(snap.spellLastCast?.Mesmerization, undefined)

  // The advance is carried on the delta, so the upgrade strip recomputes on a cast.
  const delta = mod.flushDelta()
  assert.equal(delta?.delta.fired.length, 0)
  assert.deepEqual(
    (delta?.delta.cast ?? []).map((c) => c.spell).sort(),
    ['Mesmerization III', 'Mesmerization IV']
  )
  assert.equal(mod.flushDelta(), null, 'the cast queue drains — no repeat deltas')
})
