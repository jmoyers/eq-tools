// Pure unit tests for the alert ROW's audio dropdowns (renderer/features/alerts/audioChoice.ts).
//
// The owner's ask was one sentence — "the voice vs sound should be integrated into this dropdown
// instead of having to drill into edit" — and every risk in it is a WRITE: two selects now edit
// four def fields, and the fields they do NOT show (the per-alert voice override) must survive
// being edited around. So the mapping is a pure module and this file pins it:
//
//   1. a sound-only alert edited through the new picker still saves BYTE-IDENTICALLY (no `audio`
//      key, no `speech` key) — that is what keeps every pre-voice def, every share string and the
//      import de-duplication fingerprint stable;
//   2. the editor-owned `speech.voiceId` rides through every row edit untouched;
//   3. the selects can never display a state the def is not in (outputValueOf is the inverse of
//      the write), and picking a pack re-seeds a sound that pack actually has;
//   4. what the row writes is what `speechTextFor` reads — the row and the editor speak the same
//      def, not two dialects of it.
//
// No DOM, no Electron, no fixture: it never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AlertDef, SoundPack } from '../src/shared/types'
import { MAX_SPEECH_CHARS, speechTextFor } from '../src/shared/speechText'
import {
  OUTPUT_BOTH,
  OUTPUT_SPEECH,
  applyAudioChoice,
  audioChoiceOf,
  displayedChoice,
  outputValueOf,
  withOutput,
  withPhrase,
  withSoundId,
  withSpeechMode,
  writeBase
} from '../src/renderer/src/features/alerts/audioChoice'

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

function pack(id: string, sounds: string[]): SoundPack {
  return {
    id,
    name: id,
    source: 'bundled',
    sounds: Object.fromEntries(sounds.map((s) => [s, { label: s, file: `${s}.wav` }]))
  }
}

const PACKS: SoundPack[] = [
  pack('alan-rickman', ['attention', 'charm-break']),
  pack('peon', ['ready', 'attention'])
]

// ------------------------------------------------------------------ reading a def

test('a def with no audio fields flattens to the sound-only defaults', () => {
  assert.deepEqual(audioChoiceOf(def()), {
    audio: 'sound',
    packId: 'alan-rickman',
    soundId: 'attention',
    mode: 'alertName',
    phrase: ''
  })
})

test('the OUTPUT select shows the def’s actual channel, never a hidden mode', () => {
  assert.equal(outputValueOf(audioChoiceOf(def())), 'alan-rickman')
  assert.equal(outputValueOf(audioChoiceOf(def({ audio: 'speech' }))), OUTPUT_SPEECH)
  assert.equal(outputValueOf(audioChoiceOf(def({ audio: 'both' }))), OUTPUT_BOTH)
})

// ------------------------------------------------------------------ the byte-identical floor

test('editing a sound-only alert through the row leaves NO voice keys on the def', () => {
  const before = def()
  const after = applyAudioChoice(before, withSoundId(audioChoiceOf(before), 'charm-break'))
  assert.deepEqual(after, def({ sound: { packId: 'alan-rickman', soundId: 'charm-break' } }))
  assert.equal('audio' in after, false, "absent means 'sound' — the pre-voice shape, unchanged")
  assert.equal('speech' in after, false)
})

test('switching a spoken alert back to a pack DELETES the audio key rather than blanking it', () => {
  const spoken = def({ audio: 'speech' })
  const back = applyAudioChoice(spoken, withOutput(audioChoiceOf(spoken), 'alan-rickman', PACKS))
  assert.equal('audio' in back, false)
  assert.deepEqual(back, def())
})

// ------------------------------------------------------------------ choosing an output

test('choosing a pack IS choosing sound-only, and re-seeds a sound that pack has', () => {
  const next = withOutput(audioChoiceOf(def({ audio: 'speech' })), 'peon', PACKS)
  assert.equal(next.audio, 'sound')
  assert.equal(next.packId, 'peon')
  assert.equal(next.soundId, 'attention', 'peon happens to carry the same id — keep it')

  const other = withOutput(
    audioChoiceOf(def({ sound: { packId: 'alan-rickman', soundId: 'charm-break' } })),
    'peon',
    PACKS
  )
  assert.equal(other.soundId, 'ready', 'peon has no charm-break — take its first sound')
})

test('the two voice outputs keep the pack sound the alert already had', () => {
  const c = audioChoiceOf(def())
  for (const [value, audio] of [
    [OUTPUT_SPEECH, 'speech'],
    [OUTPUT_BOTH, 'both']
  ] as const) {
    const next = withOutput(c, value, PACKS)
    assert.equal(next.audio, audio)
    assert.equal(next.packId, 'alan-rickman')
    assert.equal(next.soundId, 'attention', "'both' needs it, and a change of mind must be free")
  }
})

// ------------------------------------------------------------------ what it says

test('the speak-what mode is a def field the row writes, and the editor reads', () => {
  const d = def({ audio: 'speech' })
  const next = applyAudioChoice(d, withSpeechMode(audioChoiceOf(d), 'spellFirstWord'))
  assert.deepEqual(next.speech, { mode: 'spellFirstWord' })
  assert.equal(speechTextFor(next, { spell: 'Mesmerization III' }), 'Mesmerization')
})

test('a custom phrase is trimmed, capped, and is what the alert actually says', () => {
  const d = def({ audio: 'speech' })
  const next = applyAudioChoice(d, withPhrase(audioChoiceOf(d), '  slow landed  '))
  assert.deepEqual(next.speech, { mode: 'custom', phrase: 'slow landed' })
  assert.equal(speechTextFor(next, null), 'slow landed')

  const long = withPhrase(audioChoiceOf(d), 'x'.repeat(MAX_SPEECH_CHARS + 40))
  assert.equal(long.phrase.length, MAX_SPEECH_CHARS)
})

test('an EMPTY custom phrase falls back to the mode that describes what is spoken', () => {
  const d = def({ audio: 'speech', speech: { mode: 'custom', phrase: 'old' } })
  const cleared = withPhrase(audioChoiceOf(d), '   ')
  assert.equal(cleared.mode, 'alertName', 'the picker must not say "custom" about a name')
  const next = applyAudioChoice(d, cleared)
  assert.equal(next.speech, undefined, 'nothing configured ⇒ the key goes away entirely')
  assert.equal(speechTextFor(next, null), 'Charm break')
})

// ------------------------------------------------------------------ before the packs are there

test('with NO pack resolved, an edit leaves the def’s sound exactly as it stated it', () => {
  // Caught by tests/e2e/voice-alerts.e2e.mts, which runs in a channel where downloads are
  // disabled and the default pack has therefore never self-provisioned: the display
  // normalization is a pair of empty strings there, and writing it erased `sound` on the way to
  // `audio:'speech'` — which the editor then refused to save (packId/soundId are required).
  const c = audioChoiceOf(def())
  assert.deepEqual(displayedChoice(c, undefined), { ...c, packId: '', soundId: '' })
  assert.deepEqual(writeBase(c, undefined), c, 'a write is applied to the def, not to the blank')

  const spoken = applyAudioChoice(def(), withOutput(writeBase(c, undefined), OUTPUT_SPEECH, []))
  assert.deepEqual(spoken.sound, { packId: 'alan-rickman', soundId: 'attention' })
  assert.equal(spoken.audio, 'speech')
})

test('with a pack resolved, the display normalizes a sound that pack does not carry', () => {
  const c = audioChoiceOf(def({ sound: { packId: 'alan-rickman', soundId: 'gone' } }))
  assert.equal(displayedChoice(c, PACKS[0]).soundId, 'attention', 'never a blank select')
  assert.deepEqual(writeBase(c, PACKS[0]), displayedChoice(c, PACKS[0]))
})

// ------------------------------------------------------------------ what the row cannot see

test('the editor-owned voice override survives every row edit', () => {
  const d = def({ audio: 'speech', speech: { mode: 'spellName', voiceId: 'Microsoft David' } })
  const c = audioChoiceOf(d)

  const modeChanged = applyAudioChoice(d, withSpeechMode(c, 'alertName'))
  assert.deepEqual(modeChanged.speech, { mode: 'alertName', voiceId: 'Microsoft David' })

  const backToSound = applyAudioChoice(d, withOutput(c, 'peon', PACKS))
  assert.equal(backToSound.audio, undefined, 'sound-only again…')
  assert.deepEqual(
    backToSound.speech,
    { mode: 'spellName', voiceId: 'Microsoft David' },
    '…but the voice the user chose in the editor is still there if they come back'
  )
})

test('an alert’s unrelated fields are never touched by an audio edit', () => {
  const d = def({ volume: 0.4, cooldownMs: 30_000, alwaysPlay: true, note: 'from a share string' })
  const next = applyAudioChoice(d, withOutput(audioChoiceOf(d), OUTPUT_BOTH, PACKS))
  assert.equal(next.volume, 0.4)
  assert.equal(next.cooldownMs, 30_000)
  assert.equal(next.alwaysPlay, true)
  assert.equal(next.note, 'from a share string')
  assert.equal(next.audio, 'both')
})
