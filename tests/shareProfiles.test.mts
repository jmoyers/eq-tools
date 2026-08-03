// Share-profile envelope tests — the paste-safe settings/alert sharing model.
//
// What's guarded here (and why each one is load-bearing):
//   * round-trip: encode → decode returns exactly what went in, through a real deflate.
//   * checksum: a tampered body is REJECTED, not partially applied.
//   * version: a future-generation string is refused with a "newer version" story, never
//     mis-parsed.
//   * additive merge: importing never deletes/replaces; id collisions land ALONGSIDE; the
//     same string imported twice is a no-op.
//   * WHITELIST: a machine path can NEVER appear in an export — the tripwire for the whole
//     privacy story (a future store key must not leak by being added).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  alertBehaviorKey,
  applyAlertMerge,
  buildAlertSetBody,
  buildSettingsBody,
  canonicalJson,
  checksum,
  makeEnvelope,
  mergeUiPref,
  planAlertMerge,
  planScalarChanges,
  SHARE_PREFIX,
  SHARE_SCHEMA_VERSION,
  sanitizeAlertDef,
  UI_PREF_SPECS,
  validateEnvelope,
  type AlertSetBody,
  type SettingsBundleBody
} from '../src/shared/profiles'
import { decodeShareString, encodeShareString, looksLikeShareString } from '../src/main/shareCodec'
import type { AlertDef } from '../src/shared/types'

const MACHINE_PATH = 'C:\\Users\\jmoye\\AppData\\Roaming\\everquest-companion-dev'
const EQ_PATH = 'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'

function alert(over: Partial<AlertDef> = {}): AlertDef {
  return {
    id: 'charm-break',
    name: 'Charm break',
    enabled: true,
    trigger: { type: 'event', kind: 'uncharm' },
    sound: { packId: 'alan-rickman', soundId: 'attention' },
    ...over
  }
}

// ------------------------------------------------------------------ canonical json + checksum

test('canonicalJson is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }))
  assert.equal(canonicalJson({ a: 1, u: undefined }), '{"a":1}')
  assert.equal(canonicalJson([1, { z: 1, a: 2 }]), '[1,{"a":2,"z":1}]')
})

test('checksum is stable, and differs for different content', () => {
  assert.equal(checksum('hello'), checksum('hello'))
  assert.notEqual(checksum('hello'), checksum('hellp'))
  assert.match(checksum('hello'), /^[0-9a-f]{8}$/)
})

// ------------------------------------------------------------------ codec round-trip

test('round-trips an alert set through encode/decode', () => {
  const body = buildAlertSetBody([alert(), alert({ id: 'boss', name: 'Boss', trigger: { type: 'app', signal: 'bossDefeat' } })])
  const env = makeEnvelope('alerts', body, '1.2.3')
  const text = encodeShareString(env)

  assert.ok(text.startsWith(SHARE_PREFIX), 'carries the human-readable prefix')
  assert.ok(!/\s/.test(text), 'is a single line with no whitespace')
  assert.ok(!/[+/=]/.test(text.slice(SHARE_PREFIX.length)), 'is base64url — no +, / or = to mangle')
  assert.ok(looksLikeShareString(text))

  const back = decodeShareString(text)
  assert.ok(back.ok, 'decodes')
  if (!back.ok) return
  assert.equal(back.envelope.kind, 'alerts')
  assert.equal(back.envelope.app, '1.2.3')
  assert.equal(back.envelope.v, SHARE_SCHEMA_VERSION)
  assert.deepEqual((back.envelope.body as AlertSetBody).alerts, body.alerts)
})

test('compresses: 20 alerts still fit in a single chat message', () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    alert({ id: `alert-${i}`, name: `Alert number ${i}`, trigger: { type: 'raw', regex: `You have entered zone ${i}` } })
  )
  const text = encodeShareString(makeEnvelope('alerts', buildAlertSetBody(many), '1.0.0'))
  assert.ok(text.length < 2000, `expected < 2000 chars for Discord, got ${text.length}`)
})

test('tolerates a mangled paste (wrapped lines, code fence, surrounding prose)', () => {
  const text = encodeShareString(makeEnvelope('alerts', buildAlertSetBody([alert()]), '1.0.0'))
  const half = Math.floor(text.length / 2)
  const wrapped = '```\n' + text.slice(0, half) + '\n' + text.slice(half) + '\n```'
  assert.ok(decodeShareString(wrapped).ok, 'survives a code-fenced, line-wrapped paste')
  assert.ok(decodeShareString(`  ${text}  `).ok, 'survives surrounding whitespace')
})

// ------------------------------------------------------------------ rejection paths

test('rejects a tampered body via the checksum', () => {
  const body = buildAlertSetBody([alert()])
  const env = makeEnvelope('alerts', body, '1.0.0')
  // Same envelope, body swapped for something else — the sum no longer matches.
  const tampered = { ...env, body: { alerts: [alert({ name: 'Evil' })] } }
  const res = validateEnvelope(tampered)
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.error, 'checksum')
})

test('rejects a truncated share string as corrupt, never half-applies it', () => {
  const text = encodeShareString(makeEnvelope('alerts', buildAlertSetBody([alert()]), '1.0.0'))
  const res = decodeShareString(text.slice(0, text.length - 12))
  assert.equal(res.ok, false)
  if (!res.ok) assert.ok(res.error === 'corrupt' || res.error === 'checksum')
})

test('rejects a newer schema version with a "newer version" story', () => {
  const body = buildAlertSetBody([alert()])
  const env = { ...makeEnvelope('alerts', body, '9.9.9'), v: SHARE_SCHEMA_VERSION + 1 }
  const res = validateEnvelope(env)
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.error, 'newer-version')
})

test('rejects a newer PREFIX generation before spending an inflate on it', () => {
  const res = decodeShareString('EQC2-abcdefghijk')
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.error, 'newer-version')
})

test('rejects non-share text and empty input with distinct errors', () => {
  const empty = decodeShareString('   ')
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.equal(empty.error, 'empty')
  const junk = decodeShareString('hey check out this cool alert')
  assert.equal(junk.ok, false)
  if (!junk.ok) assert.equal(junk.error, 'not-a-share-string')
})

test('sanitizes untrusted payloads: unknown keys dropped, bad regex refused', () => {
  const dirty = sanitizeAlertDef({
    id: 'x',
    name: 'X',
    trigger: { type: 'raw', regex: 'ok' },
    sound: { packId: 'p', soundId: 's' },
    // A sender must not be able to smuggle extra state into the store.
    evil: { path: MACHINE_PATH },
    volume: 99,
    cooldownMs: -5
  })
  assert.ok(dirty)
  assert.equal(Object.prototype.hasOwnProperty.call(dirty as object, 'evil'), false)
  assert.equal(dirty?.volume, 1, 'volume clamped to 0..1')
  assert.equal(dirty?.cooldownMs, 0, 'cooldown clamped to >= 0')

  assert.equal(
    sanitizeAlertDef({ id: 'y', name: 'Y', trigger: { type: 'raw', regex: '([' }, sound: { packId: 'p', soundId: 's' } }),
    null,
    'an unparseable regex is refused rather than stored to blow up the evaluator'
  )
  assert.equal(sanitizeAlertDef({ id: 'z', name: 'Z' }), null, 'a def with no trigger/sound is refused')
})

// ------------------------------------------------------------------ additive merge

test('merge is additive: existing alerts are never removed or modified', () => {
  const existing = [alert(), alert({ id: 'boss', name: 'Boss', trigger: { type: 'app', signal: 'bossDefeat' } })]
  const incoming = [alert({ id: 'new-one', name: 'New', trigger: { type: 'raw', regex: 'hello' } })]
  const plan = planAlertMerge(existing, incoming, ['alan-rickman'])
  const res = applyAlertMerge(existing, plan)
  assert.equal(res.added, 1)
  assert.equal(res.alerts.length, 3)
  assert.deepEqual(res.alerts.slice(0, 2), existing, 'the head of the list is byte-identical')
})

test('same behavior is SKIPPED — importing the same string twice is a no-op', () => {
  const existing = [alert()]
  // Same trigger + sound, different name/note: still the same alert.
  const incoming = [alert({ id: 'their-charm', name: 'CHARM BROKE!!', note: 'from a friend' })]
  const plan = planAlertMerge(existing, incoming, ['alan-rickman'])
  assert.equal(plan[0].action, 'skip')
  const res = applyAlertMerge(existing, plan)
  assert.equal(res.added, 0)
  assert.deepEqual(res.alerts, existing)
})

test('id collision with DIFFERENT behavior imports alongside, deterministically', () => {
  const existing = [alert()] // id 'charm-break'
  const theirs = alert({ name: 'Charm break', trigger: { type: 'raw', regex: 'charm has broken' } })
  const plan = planAlertMerge(existing, [theirs], ['alan-rickman'])
  assert.equal(plan[0].action, 'rekey')
  assert.notEqual(plan[0].finalId, 'charm-break')
  assert.ok(plan[0].finalId.startsWith('charm-break~'))
  assert.equal(plan[0].finalName, 'Charm break (imported)', 'name clash is disambiguated for the list')

  const first = applyAlertMerge(existing, plan)
  assert.equal(first.added, 1)
  assert.equal(first.alerts.length, 2)
  assert.ok(first.alerts.some((a) => a.id === 'charm-break'), 'the original survives untouched')

  // Second import of the SAME payload: the rekeyed id is derived from the behavior, so the
  // twin is found and skipped — idempotent.
  const plan2 = planAlertMerge(first.alerts, [theirs], ['alan-rickman'])
  assert.equal(plan2[0].action, 'skip')
  const second = applyAlertMerge(first.alerts, plan2)
  assert.equal(second.added, 0)
  assert.equal(second.alerts.length, 2)
})

test('two incoming alerts that collide with EACH OTHER both land', () => {
  const incoming = [
    alert({ id: 'dup', name: 'Dup', trigger: { type: 'raw', regex: 'a' } }),
    alert({ id: 'dup', name: 'Dup', trigger: { type: 'raw', regex: 'b' } })
  ]
  const plan = planAlertMerge([], incoming, ['alan-rickman'])
  const res = applyAlertMerge([], plan)
  assert.equal(res.added, 2)
  assert.equal(new Set(res.alerts.map((a) => a.id)).size, 2, 'ids are distinct after merge')
})

test('per-item opt-in: only selected alerts are applied', () => {
  const incoming = [
    alert({ id: 'a1', name: 'A1', trigger: { type: 'raw', regex: 'a' } }),
    alert({ id: 'a2', name: 'A2', trigger: { type: 'raw', regex: 'b' } })
  ]
  const plan = planAlertMerge([], incoming, ['alan-rickman'])
  const res = applyAlertMerge([], plan, new Set(['a1']))
  assert.equal(res.added, 1)
  assert.equal(res.alerts[0].id, 'a1')
})

test('a missing sound pack flags the alert but still imports it (never silently muted)', () => {
  const incoming = [alert({ id: 'x', name: 'X', sound: { packId: 'peon', soundId: 'work-work' } })]
  const plan = planAlertMerge([], incoming, ['alan-rickman'])
  assert.equal(plan[0].missingPackId, 'peon')
  assert.equal(plan[0].action, 'add')
  const res = applyAlertMerge([], plan)
  assert.equal(res.added, 1)
  assert.deepEqual(res.alerts[0].sound, { packId: 'peon', soundId: 'work-work' }, 'sound is NOT re-pointed at a default')
})

test('behavior key ignores name/note/enabled but tracks trigger + sound', () => {
  const base = alert()
  assert.equal(alertBehaviorKey(base), alertBehaviorKey(alert({ name: 'other', note: 'x', enabled: false })))
  assert.notEqual(alertBehaviorKey(base), alertBehaviorKey(alert({ sound: { packId: 'p', soundId: 's' } })))
  assert.notEqual(alertBehaviorKey(base), alertBehaviorKey(alert({ trigger: { type: 'raw', regex: 'q' } })))
})

// ------------------------------------------------------------------ the whitelist (tripwire)

test('WHITELIST: no machine path can appear in a settings export', () => {
  // Everything a hostile/careless caller might hand the builder, including machine-local
  // fields planted inside otherwise-legitimate objects.
  const body = buildSettingsBody({
    alerts: [alert({ note: 'ordinary note' })],
    alertPrefs: { globalVolume: 0.5, muted: false },
    overlays: {
      fight: {
        bgAlpha: 0.8,
        topN: 10,
        // MACHINE state that must never travel:
        open: true,
        locked: false,
        bounds: { x: 1920, y: 0, width: 420, height: 300 },
        drill: { entityId: 'primitive' }
      } as never
    },
    ui: {
      'eq.combat.scope': 'overall',
      'eq.favorites': '["fire emerald"]',
      // Not on the whitelist — must be dropped even though it was handed in:
      'eq.view': 'combat',
      'eq.secretPath': MACHINE_PATH
    }
  })

  const text = canonicalJson(body)
  assert.ok(!text.includes(MACHINE_PATH), 'no userData path')
  assert.ok(!text.includes(EQ_PATH), 'no EQ install path')
  assert.ok(!/[A-Za-z]:\\\\/.test(text) && !text.includes('C:\\'), 'no Windows path of any shape')
  assert.ok(!text.includes('bounds'), 'no window geometry')
  assert.ok(!text.includes('"open"') && !text.includes('locked'), 'no overlay window state')
  assert.ok(!text.includes('drill'), 'no transient drill state')
  assert.ok(!text.includes('eq.view'), 'the last-open tab stays machine-local')
  assert.ok(!text.includes('eq.secretPath'), 'an unlisted UI key is dropped')

  assert.deepEqual(body.overlays?.fight, { bgAlpha: 0.8, topN: 10 }, 'only the two pref fields survive')
  assert.deepEqual(Object.keys(body.ui ?? {}).sort(), ['eq.combat.scope', 'eq.favorites'])
})

test('WHITELIST: the exportable UI keys are exactly the documented list', () => {
  assert.deepEqual(
    UI_PREF_SPECS.map((s) => s.key).sort(),
    ['eq.bossDensity', 'eq.combat.scope', 'eq.countSource', 'eq.favorites', 'eq.profile', 'eq.selectedClasses']
  )
  assert.ok(!UI_PREF_SPECS.some((s) => s.key === 'eq.view'), 'the last-open tab is never exportable')
})

test('WHITELIST holds through a full encode: the wire bytes carry no path', () => {
  const body = buildSettingsBody({
    alerts: [alert()],
    alertPrefs: { globalVolume: 0.7, muted: false },
    overlays: { fight: { bgAlpha: 0.72, topN: 5, bounds: { x: 1, y: 2, width: 3, height: 4 } } as never },
    ui: { 'eq.view': 'posky', 'eq.combat.scope': 'fight' }
  })
  const decoded = decodeShareString(encodeShareString(makeEnvelope('settings', body, '1.0.0')))
  assert.ok(decoded.ok)
  if (!decoded.ok) return
  const json = JSON.stringify(decoded.envelope.body)
  assert.ok(!json.includes('bounds') && !json.includes('eq.view'))
})

// ------------------------------------------------------------------ scalar / ui merge

test('scalar changes are reported only when they actually differ', () => {
  const body: SettingsBundleBody = {
    alertPrefs: { globalVolume: 0.5, muted: true },
    overlays: { fight: { bgAlpha: 0.72, topN: 10 } },
    ui: { 'eq.combat.scope': 'overall' }
  }
  const changes = planScalarChanges(body, {
    alertPrefs: { globalVolume: 0.5, muted: false },
    overlays: { fight: { bgAlpha: 0.72, topN: 5 } },
    ui: { 'eq.combat.scope': 'overall' }
  })
  const ids = changes.map((c) => c.id).sort()
  assert.deepEqual(ids, ['alertPrefs.muted', 'overlay.fight.topN'])
})

test('list-shaped UI prefs union additively; nothing you had is dropped', () => {
  const spec = UI_PREF_SPECS.find((s) => s.key === 'eq.favorites')
  assert.ok(spec)
  const merged = mergeUiPref(spec, '["a","b"]', '["b","c"]')
  assert.deepEqual(JSON.parse(merged), ['a', 'b', 'c'])
  // A non-array value can't be unioned; fall back to replace rather than guessing.
  assert.equal(mergeUiPref(spec, 'not-json', '["c"]'), '["c"]')
  const scalar = UI_PREF_SPECS.find((s) => s.key === 'eq.combat.scope')
  assert.ok(scalar)
  assert.equal(mergeUiPref(scalar, 'fight', 'overall'), 'overall')
})

test('buildAlertSetBody picks one alert by id, or all when omitted', () => {
  const all = [alert(), alert({ id: 'b', name: 'B', trigger: { type: 'raw', regex: 'x' } })]
  assert.equal(buildAlertSetBody(all).alerts.length, 2)
  assert.deepEqual(buildAlertSetBody(all, ['b']).alerts.map((a) => a.id), ['b'])
})
