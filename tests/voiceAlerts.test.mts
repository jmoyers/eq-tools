// Pure unit tests for the RENDERER half of voice alerts (docs/plans/voice-alerts.md W2).
//
// No DOM, no Electron, no fixture — so this file never skips. It pins the three decisions that
// are invisible until they are wrong, every one of them a thing the user experiences as "the
// app said the wrong thing / said nothing / would not stop talking":
//
//   1. `speechPlan` — sound vs speech vs both, and the two ways a firing goes quiet (the alerts
//      master mute) versus the one way it must NOT (voice switched off ⇒ degrade to the sound,
//      never to silence).
//   2. `coalesceAudio` — "three buffs fading at once is ONE audio alert" (owner direction), plus
//      the per-alert opt-out's exact contract: it bypasses the window AND does not occupy it.
//   3. `pickVoice` — a stored voice id resolved against a per-machine voice list, bounded: exact
//      then case-insensitive, and NEVER "the first voice" (a stranger's voice is worse than the
//      engine's own default).
//
// The engine itself (`speak`) is deliberately not unit-tested: it is the seam onto
// speechSynthesis and IPC, and what it must do is asserted where it lives, by
// tests/e2e/voice-alerts.e2e.mts against the real app.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AlertDef, VoicePrefs } from '../src/shared/types'
import { DEFAULT_VOICE_PREFS } from '../src/shared/speechText'
import { pickVoice, speechPlan, voiceIdOf } from '../src/renderer/src/lib/speech'
import { AUDIO_COALESCE_MS, coalesceAudio } from '../src/renderer/src/features/alerts/audioThrottle'

const ON: VoicePrefs = { ...DEFAULT_VOICE_PREFS, enabled: true }
const OFF: VoicePrefs = { ...DEFAULT_VOICE_PREFS, enabled: false }

function def(over: Partial<AlertDef> = {}): AlertDef {
  return {
    id: 'charm-break',
    name: 'Charm break',
    enabled: true,
    trigger: { type: 'event', kind: 'uncharm' },
    sound: { packId: 'alan-rickman', soundId: 'attention' },
    ...over
  }
}

// ------------------------------------------------------------------ speechPlan

test('a def with no audio field plays its sound, exactly as it always did', () => {
  assert.deepEqual(speechPlan(def(), null, ON, false), { sound: true, speak: null, after: false })
})

test("audio:'speech' speaks INSTEAD of the sound", () => {
  const plan = speechPlan(def({ audio: 'speech' }), null, ON, false)
  assert.equal(plan.sound, false)
  assert.equal(plan.speak, 'Charm break', 'no speech block ⇒ the alert name (W1 fallback)')
  assert.equal(plan.after, false)
})

test("audio:'both' plays the sound AND queues the speech behind it", () => {
  const plan = speechPlan(def({ audio: 'both' }), null, ON, false)
  assert.deepEqual(plan, { sound: true, speak: 'Charm break', after: true })
})

test('the alerts master MUTE silences speech too — mute is a promise about noise', () => {
  for (const audio of ['sound', 'speech', 'both'] as const) {
    assert.deepEqual(
      speechPlan(def({ audio }), null, ON, true),
      { sound: false, speak: null, after: false },
      `audio:'${audio}' must be silent while muted`
    )
  }
})

test('voice switched OFF degrades a speaking alert to its sound — never to silence', () => {
  assert.deepEqual(speechPlan(def({ audio: 'speech' }), null, OFF, false), {
    sound: true,
    speak: null,
    after: false
  })
  assert.deepEqual(speechPlan(def({ audio: 'both' }), null, OFF, false), {
    sound: true,
    speak: null,
    after: false
  })
})

test('the spell modes read the firing’s RANK-INTACT spell and strip the rank aloud', () => {
  const d = def({ audio: 'speech', speech: { mode: 'spellName' } })
  assert.equal(speechPlan(d, { spell: 'Mesmerization III' }, ON, false).speak, 'Mesmerization')
  const first = def({ audio: 'speech', speech: { mode: 'spellFirstWord' } })
  assert.equal(speechPlan(first, { spell: 'Swift Like the Wind II' }, ON, false).speak, 'Swift')
})

test('a spell mode on a firing with NO spell falls back to the alert name, never silence', () => {
  const d = def({ name: 'Mez broke', audio: 'speech', speech: { mode: 'spellName' } })
  assert.equal(speechPlan(d, { spell: undefined }, ON, false).speak, 'Mez broke')
  assert.equal(speechPlan(d, null, ON, false).speak, 'Mez broke')
})

test('a custom phrase is spoken verbatim', () => {
  const d = def({ audio: 'speech', speech: { mode: 'custom', phrase: 'run away' } })
  assert.equal(speechPlan(d, null, ON, false).speak, 'run away')
})

// ------------------------------------------------------------------ coalesceAudio

test('three alerts firing in the same instant produce ONE audio alert', () => {
  const now = 1_000_000
  let last: number | null = null
  const played: boolean[] = []
  for (let i = 0; i < 3; i++) {
    const gate = coalesceAudio(def(), now + i, last)
    last = gate.lastAudioMs
    played.push(gate.play)
  }
  assert.deepEqual(played, [true, false, false])
  assert.equal(last, now, 'FIRST arrival owns the window; the suppressed pair never extend it')
})

test('the window expires — the next burst is heard', () => {
  const t0 = 5_000
  const first = coalesceAudio(def(), t0, null)
  assert.equal(first.play, true)
  assert.equal(coalesceAudio(def(), t0 + AUDIO_COALESCE_MS - 1, first.lastAudioMs).play, false)
  const later = coalesceAudio(def(), t0 + AUDIO_COALESCE_MS, first.lastAudioMs)
  assert.equal(later.play, true)
  assert.equal(later.lastAudioMs, t0 + AUDIO_COALESCE_MS)
})

test('alwaysPlay BYPASSES the window and does NOT occupy it', () => {
  const t0 = 42
  const opened = coalesceAudio(def(), t0, null)
  // Bypasses an open window…
  const critical = coalesceAudio(def({ alwaysPlay: true }), t0 + 10, opened.lastAudioMs)
  assert.equal(critical.play, true)
  assert.equal(critical.lastAudioMs, t0, 'it left the existing window exactly as it found it')
  // …and two of them together both sound, which is the whole point of the opt-out.
  const a = coalesceAudio(def({ alwaysPlay: true }), 900, null)
  const b = coalesceAudio(def({ alwaysPlay: true }), 900, a.lastAudioMs)
  assert.equal(a.play && b.play, true)
  assert.equal(b.lastAudioMs, null, 'a critical alert never opens a window against the next one')
})

test("'both' is ONE occupancy — its sound+speech pair cannot silence itself", () => {
  // The caller charges the window once per FIRING, whatever the plan contains; this pins that
  // the throttle has no per-channel notion at all.
  const gate = coalesceAudio(def({ audio: 'both' }), 100, null)
  assert.deepEqual(gate, { play: true, lastAudioMs: 100 })
})

// ------------------------------------------------------------------ pickVoice

const VOICES = [
  { name: 'Microsoft David Desktop', voiceURI: 'urn:sapi:David?en-US', lang: 'en-US' },
  { name: 'Microsoft Zira Desktop', voiceURI: 'urn:sapi:Zira?en-US', lang: 'en-US' },
  { name: 'Google UK English Male', lang: 'en-GB' }
]

test('a stored voice id matches by URI, then by name, then case-insensitively', () => {
  assert.equal(pickVoice(VOICES, 'urn:sapi:Zira?en-US')?.name, 'Microsoft Zira Desktop')
  assert.equal(pickVoice(VOICES, 'Microsoft David Desktop')?.name, 'Microsoft David Desktop')
  assert.equal(pickVoice(VOICES, 'MICROSOFT ZIRA DESKTOP')?.name, 'Microsoft Zira Desktop')
  assert.equal(pickVoice(VOICES, 'urn:SAPI:david?EN-US')?.name, 'Microsoft David Desktop')
})

test('an unknown / absent voice id resolves to the ENGINE default, never to voices[0]', () => {
  assert.equal(pickVoice(VOICES, 'Microsoft Hazel'), null, 'a machine without that voice')
  assert.equal(pickVoice(VOICES, 'David'), null, 'never substring-matches (law 12)')
  assert.equal(pickVoice(VOICES, null), null)
  assert.equal(pickVoice(VOICES, ''), null)
  assert.equal(pickVoice([], 'urn:sapi:Zira?en-US'), null)
})

test('a voice with no URI is identified by its name', () => {
  assert.equal(voiceIdOf(VOICES[2]), 'Google UK English Male')
  assert.equal(voiceIdOf(VOICES[0]), 'urn:sapi:David?en-US')
  assert.equal(pickVoice(VOICES, 'Google UK English Male')?.lang, 'en-GB')
})
