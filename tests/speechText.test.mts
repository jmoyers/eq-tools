// Voice alerts — the CONTENT resolver (src/shared/speechText.ts).
//
// `speechTextFor` decides the literal words a spoken alert says, and it is the single place
// three surfaces agree: the alert editor's live preview, the renderer's alert player, and any
// future main-side speaker. So the matrix below is the specification — every mode against a
// firing that carries a spell and against one that does not, because the difference between
// those two columns is the whole design (docs/plans/voice-alerts.md §1: never silent, never a
// guess). No Electron, no log, no fixtures: a pure function over plain objects.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AlertDef, SpeechMode } from '../src/shared/alertTypes'
import {
  ALERT_AUDIO_ACTIONS,
  DEFAULT_VOICE_PREFS,
  MAX_SPEECH_CHARS,
  MAX_SPEECH_RATE,
  MIN_SPEECH_RATE,
  SPEECH_ENGINES,
  SPEECH_MODES,
  normalizeVoicePrefs,
  speechTextFor,
  type SpeechFiring
} from '../src/shared/speechText'

/** A def with just enough shape to resolve; `speechTextFor` reads only name + speech. */
function def(name: string, mode?: SpeechMode, phrase?: string): AlertDef {
  const base: AlertDef = {
    id: 'a',
    name,
    enabled: true,
    trigger: { type: 'event', kind: 'castBegin' },
    sound: { packId: 'alan-rickman', soundId: 'x' }
  }
  return mode === undefined ? base : { ...base, speech: phrase === undefined ? { mode } : { mode, phrase } }
}

const firing = (spell?: string): SpeechFiring => (spell === undefined ? {} : { spell })

// ------------------------------------------------------------------------ the mode matrix

test('every mode resolves against a firing that NAMES a spell', () => {
  const d = (mode: SpeechMode): AlertDef => def('Mez landed', mode)
  const f = firing('Mesmerization III')
  assert.equal(speechTextFor(d('alertName'), f), 'Mez landed')
  // Ranks are noise aloud — stripped through the SAME machinery spellCanonKey uses.
  assert.equal(speechTextFor(d('spellName'), f), 'Mesmerization')
  assert.equal(speechTextFor(d('spellFirstWord'), f), 'Mesmerization')
  assert.equal(speechTextFor(def('Mez landed', 'custom', 'Watch out'), f), 'Watch out')
})

test('every mode resolves against a firing with NO spell — by falling back to the alert name', () => {
  // An app-signal alert (bossDefeat), a raw trigger on a spell-less line, or any of the ~30
  // event families that name no spell. Silence would be an alert the user cannot see failing.
  for (const mode of SPEECH_MODES) {
    const d = mode === 'custom' ? def('Boss down', 'custom', 'Victory') : def('Boss down', mode)
    const expected = mode === 'custom' ? 'Victory' : 'Boss down'
    assert.equal(speechTextFor(d, firing()), expected, `${mode} with no spell`)
    // Same answer whether the firing is absent entirely (the editor's pre-fire preview),
    // explicitly null, or present-but-spell-less.
    assert.equal(speechTextFor(d), expected, `${mode} with no firing at all`)
    assert.equal(speechTextFor(d, null), expected, `${mode} with a null firing`)
  }
})

test('SPEECH_MODES covers exactly the four documented modes', () => {
  assert.deepEqual([...SPEECH_MODES].sort(), ['alertName', 'custom', 'spellFirstWord', 'spellName'])
  assert.deepEqual([...ALERT_AUDIO_ACTIONS], ['sound', 'speech', 'both'])
  assert.deepEqual([...SPEECH_ENGINES], ['system', 'kokoro'])
})

// --------------------------------------------------------------------------- rank stripping

test('spellName strips every roman-numeral rank I–X and leaves unranked names alone', () => {
  const ranks = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']
  for (const r of ranks) {
    assert.equal(speechTextFor(def('n', 'spellName'), firing(`Mesmerization ${r}`)), 'Mesmerization')
  }
  // An unsuffixed name is already the base — nothing to strip.
  assert.equal(speechTextFor(def('n', 'spellName'), firing('Clarity')), 'Clarity')
  // Lowercase ranks strip too (the fold is case-insensitive, like spellCanonKey).
  assert.equal(speechTextFor(def('n', 'spellName'), firing('Allure vi')), 'Allure')
  // A roman numeral INSIDE the name is not a rank — only a trailing one is.
  assert.equal(speechTextFor(def('n', 'spellName'), firing('Vision of Ix Ward')), 'Vision of Ix Ward')
  // A name that is nothing but a numeral has no leading space, so it is not a rank tail.
  assert.equal(speechTextFor(def('n', 'spellName'), firing('III')), 'III')
})

test('spellName keeps possessives and punctuation — 712 spell names contain an apostrophe-s', () => {
  assert.equal(speechTextFor(def('n', 'spellName'), firing("Denon's Desperate Dirge")), "Denon's Desperate Dirge")
})

// ------------------------------------------------------------------------------- first word

test('spellFirstWord is the first word of the RANK-STRIPPED name — the shortest useful utterance', () => {
  const f = (spell: string): string | null => speechTextFor(def('n', 'spellFirstWord'), firing(spell))
  assert.equal(f('Swift Like the Wind I'), 'Swift')
  assert.equal(f('Lay on Hands X'), 'Lay')
  assert.equal(f('Clarity'), 'Clarity')
  // The rank is stripped BEFORE the split, so a one-word line never speaks its numeral.
  assert.equal(f('Mesmerization III'), 'Mesmerization')
  // Leading/trailing whitespace and internal runs collapse rather than producing an empty word.
  assert.equal(f('  Swift   Like the Wind  '), 'Swift')
})

// -------------------------------------------------------------------------------- custom

test('a custom phrase is spoken verbatim, whitespace-collapsed', () => {
  assert.equal(speechTextFor(def('n', 'custom', 'Adds on the puller!'), firing()), 'Adds on the puller!')
  assert.equal(speechTextFor(def('n', 'custom', '  two   lines\nfolded '), firing()), 'two lines folded')
})

test('an EMPTY custom phrase falls back to the alert name rather than speaking nothing', () => {
  // The mode says "say my words" and there are none. Saying the alert's name is a true
  // statement about what fired; silence is an alert the user cannot tell is broken.
  for (const phrase of ['', '   ', '\n\t']) {
    assert.equal(speechTextFor(def('Charm break', 'custom', phrase), firing()), 'Charm break')
  }
})

// ----------------------------------------------------------------------------- the char cap

test('an over-long utterance is TRUNCATED at MAX_SPEECH_CHARS, never refused', () => {
  assert.equal(MAX_SPEECH_CHARS, 120)
  const long = 'a'.repeat(MAX_SPEECH_CHARS + 40)
  const out = speechTextFor(def('n', 'custom', long), firing())
  assert.equal(out?.length, MAX_SPEECH_CHARS)
  assert.equal(out, 'a'.repeat(MAX_SPEECH_CHARS))
  // Exactly at the cap is untouched — the boundary is inclusive.
  const exact = 'b'.repeat(MAX_SPEECH_CHARS)
  assert.equal(speechTextFor(def('n', 'custom', exact), firing()), exact)
  // The cap applies to EVERY mode, including a pathological alert name and a long spell line.
  assert.equal(speechTextFor(def('c'.repeat(300), 'alertName'), firing())?.length, MAX_SPEECH_CHARS)
  assert.equal(speechTextFor(def('n', 'spellName'), firing('d'.repeat(300)))?.length, MAX_SPEECH_CHARS)
  // Truncation never leaves a trailing space to be spoken as a pause.
  const spacey = `${'e'.repeat(MAX_SPEECH_CHARS - 1)}   tail`
  assert.equal(speechTextFor(def('n', 'custom', spacey), firing()), 'e'.repeat(MAX_SPEECH_CHARS - 1))
})

// ------------------------------------------------------------------------------- defaults

test('a def with NO speech block still says something: its own name', () => {
  // Turning speech on for an existing alert must be a one-field change. `audio` decides
  // WHETHER to speak; this function only ever decides WHAT.
  assert.equal(speechTextFor(def('Charm break'), firing('Mesmerization III')), 'Charm break')
})

test('a def with no usable name and no phrase resolves to null, not to an empty utterance', () => {
  assert.equal(speechTextFor(def('   ', 'alertName'), firing()), null)
  assert.equal(speechTextFor(def('', 'custom', ''), firing()), null)
  // A blank spell is treated as no spell, so it falls back — and the blank name yields null.
  assert.equal(speechTextFor(def('  ', 'spellName'), firing('   ')), null)
})

test('the resolver is pure — it never mutates the def or the firing', () => {
  const d = def('Mez landed', 'spellName')
  const f = firing('Mesmerization III')
  const dBefore = JSON.stringify(d)
  const fBefore = JSON.stringify(f)
  speechTextFor(d, f)
  assert.equal(JSON.stringify(d), dBefore)
  assert.equal(JSON.stringify(f), fBefore)
})

// -------------------------------------------------------------------------- voice prefs

test('normalizeVoicePrefs repairs anything into a legal blob, defaulting rather than guessing', () => {
  assert.deepEqual(normalizeVoicePrefs(undefined), DEFAULT_VOICE_PREFS)
  assert.deepEqual(normalizeVoicePrefs(null), DEFAULT_VOICE_PREFS)
  assert.deepEqual(normalizeVoicePrefs('nonsense'), DEFAULT_VOICE_PREFS)
  assert.deepEqual(normalizeVoicePrefs([]), DEFAULT_VOICE_PREFS)
  // Speech is OFF until asked for (D4: an off-by-default feature spends nobody's bandwidth).
  assert.equal(DEFAULT_VOICE_PREFS.enabled, false)
  assert.equal(DEFAULT_VOICE_PREFS.engine, 'system')
  assert.equal(DEFAULT_VOICE_PREFS.voiceId, null)

  // An engine this build has never heard of is NOT coerced into the other tier's meaning.
  assert.equal(normalizeVoicePrefs({ engine: 'chatterbox' }).engine, 'system')
  assert.equal(normalizeVoicePrefs({ engine: 'kokoro' }).engine, 'kokoro')

  // Rate/volume are clamped, and non-numbers become the documented default.
  assert.equal(normalizeVoicePrefs({ rate: 99 }).rate, MAX_SPEECH_RATE)
  assert.equal(normalizeVoicePrefs({ rate: -5 }).rate, MIN_SPEECH_RATE)
  assert.equal(normalizeVoicePrefs({ rate: 'fast' }).rate, DEFAULT_VOICE_PREFS.rate)
  assert.equal(normalizeVoicePrefs({ rate: Number.NaN }).rate, DEFAULT_VOICE_PREFS.rate)
  assert.equal(normalizeVoicePrefs({ volume: 3 }).volume, 1)
  assert.equal(normalizeVoicePrefs({ volume: -1 }).volume, 0)

  // A blank voice id is "no override", spelled null — never '' and never undefined.
  assert.equal(normalizeVoicePrefs({ voiceId: '   ' }).voiceId, null)
  assert.equal(normalizeVoicePrefs({ voiceId: 42 }).voiceId, null)
  assert.equal(normalizeVoicePrefs({ voiceId: 'sapi:David' }).voiceId, 'sapi:David')

  // Idempotent: normalizing a normalized blob changes nothing (the store read and the store
  // write both run it, so a round-trip must be a fixed point).
  const once = normalizeVoicePrefs({ enabled: true, engine: 'kokoro', rate: 5, volume: 0.4 })
  assert.deepEqual(normalizeVoicePrefs(once), once)
})
