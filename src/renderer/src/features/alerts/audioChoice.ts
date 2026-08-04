// audioChoice.ts — the PURE half of "what does this alert do when it fires", as edited from the
// alert LIST's two dropdowns (owner: "the voice vs sound should be integrated into this dropdown
// instead of having to drill into edit").
//
// The alert row shows two selects and nothing else, but the def carries FOUR things behind them:
// the audio channel (`audio`: sound | speech | both), the pack sound (`sound.packId`/`soundId`),
// what a spoken alert says (`speech.mode`/`phrase`) and — editor-only — whose voice says it
// (`speech.voiceId`). This module is the mapping between the two, kept pure and DOM-free so the
// mapping itself is node-testable: every "clicking X writes Y on the def" claim in the row is a
// function here, not a closure inside a Select.
//
// THE SHAPE OF THE WRITE IS LOAD-BEARING, not cosmetic. `audio` is omitted at 'sound' and
// `speech` is omitted when nothing is configured — exactly as SpeechBlock.speechFieldsFor does
// it — so an alert that never asked to speak still saves byte-identically to how it always did.
// That is what keeps every pre-voice def, every share string and the import de-duplication
// fingerprint stable (shared/alertTypes.ts: absent `audio` ⇒ 'sound', by construction).
//
// VOICEID IS PRESERVED, NEVER AUTHORED. The row cannot pick a voice — two selects cannot show
// three dimensions — so the editor's SpeechBlock stays authoritative for it. Every write here
// carries the def's existing `speech.voiceId` through untouched; a row edit must not silently
// drop an override the user set in the editor.
//
// Value imports from `shared/` are RELATIVE, never `@shared/*` — the repo-wide rule for anything
// node:test loads (AGENTS.md toolchain gotchas, the mobSearch.ts precedent). Type-only imports
// keep the alias, which is erased before Node ever sees the file.

import type { AlertAudio, AlertDef, AlertSpeech, SoundPack, SpeechMode } from '@shared/types'
import { MAX_SPEECH_CHARS } from '../../../../shared/speechText'

/**
 * The audio state ONE row edits, flattened out of the def.
 *
 * `mode`/`phrase` are always present (at their defaults when the def has no speech block),
 * because a picker needs a value to display even for a def that has never spoken.
 */
export interface AudioChoice {
  audio: AlertAudio
  packId: string
  soundId: string
  mode: SpeechMode
  phrase: string
}

/** The def fields this module reads and writes. Any AlertDef satisfies it. */
export type AudioDef = Pick<AlertDef, 'audio' | 'sound' | 'speech'>

/**
 * The two non-pack entries of the OUTPUT select, as select values.
 *
 * They share the select's value space with pack ids, so they are namespaced with a colon —
 * `isSafePackId` (main/ipc) restricts a pack id to filename-safe characters, so neither string
 * can ever collide with a real pack.
 */
export const OUTPUT_SPEECH = 'output:speech'
export const OUTPUT_BOTH = 'output:both'

/** Flatten a def into the row's editable state. */
export function audioChoiceOf(def: AudioDef): AudioChoice {
  return {
    audio: def.audio ?? 'sound',
    packId: def.sound.packId,
    soundId: def.sound.soundId,
    mode: def.speech?.mode ?? 'alertName',
    phrase: def.speech?.phrase ?? ''
  }
}

/** Which OUTPUT select entry a choice is showing: a pack id, or one of the two voice entries. */
export function outputValueOf(choice: AudioChoice): string {
  if (choice.audio === 'speech') return OUTPUT_SPEECH
  if (choice.audio === 'both') return OUTPUT_BOTH
  return choice.packId
}

/**
 * The `speech` block a choice implies, or undefined for "omit the key".
 *
 * `prev` is the def's current block, read for ONE thing: the voiceId the editor owns.
 */
function speechFieldsOf(choice: AudioChoice, prev: AlertSpeech | undefined): AlertSpeech | undefined {
  const speech: AlertSpeech = { mode: choice.mode }
  const phrase = choice.phrase.trim().slice(0, MAX_SPEECH_CHARS)
  if (phrase) speech.phrase = phrase
  if (prev?.voiceId) speech.voiceId = prev.voiceId
  const configured =
    speech.mode !== 'alertName' || speech.phrase !== undefined || speech.voiceId !== undefined
  return configured ? speech : undefined
}

/**
 * Write a choice back onto a def, omitting every field that is at its default (see header).
 *
 * The keys are DELETED rather than set to `undefined`: the def is persisted as JSON and compared
 * as an object (the share fingerprint), and a present-but-undefined key is a different object
 * from an absent one even when it serializes the same.
 */
export function applyAudioChoice(def: AlertDef, choice: AudioChoice): AlertDef {
  const next: AlertDef = { ...def, sound: { packId: choice.packId, soundId: choice.soundId } }
  if (choice.audio === 'sound') delete next.audio
  else next.audio = choice.audio
  const speech = speechFieldsOf(choice, def.speech)
  if (speech) next.speech = speech
  else delete next.speech
  return next
}

/**
 * The choice the selects DISPLAY: the def's state normalized onto a pack that actually exists.
 *
 * A MUI Select whose value is not among its items renders blank and warns, so a def pointing at
 * an uninstalled pack (or a sound that pack no longer carries) has to be shown as SOMETHING —
 * `pack` is the caller's resolution (the def's pack, else the shipped default).
 */
export function displayedChoice(choice: AudioChoice, pack: SoundPack | undefined): AudioChoice {
  const soundIds = pack ? Object.keys(pack.sounds) : []
  return {
    ...choice,
    packId: pack?.id ?? '',
    soundId: pack?.sounds[choice.soundId] ? choice.soundId : soundIds[0] ?? ''
  }
}

/**
 * The choice an edit is applied TO — which is NOT always the displayed one.
 *
 * With no pack resolved at all (packs still loading, or none installed yet — the e2e channel, or
 * a first run before the default pack has self-provisioned) the displayed choice is a pair of
 * EMPTY STRINGS, and writing that would erase the def's sound as a side effect of switching it
 * to voice. So a write normalizes only when there is something honest to normalize to, and
 * otherwise leaves the sound exactly as the def stated it.
 */
export function writeBase(choice: AudioChoice, pack: SoundPack | undefined): AudioChoice {
  return pack ? displayedChoice(choice, pack) : choice
}

/**
 * Choosing an entry in the OUTPUT select.
 *
 * A PACK IS A CHANNEL CHOICE TOO: picking one means "play this sound", i.e. `audio:'sound'` —
 * so switching a spoken alert back to a pack is one click, not a trip to the editor. The two
 * voice entries keep the pack/sound the def already had, because 'both' needs it and because a
 * user who tries speech and changes their mind should get their sound back unchanged.
 *
 * The soundId is re-seeded from the new pack (its first sound) unless that pack happens to
 * carry the same id — a sound the pack does not have would render an out-of-range select.
 */
export function withOutput(
  choice: AudioChoice,
  value: string,
  packs: readonly SoundPack[]
): AudioChoice {
  if (value === OUTPUT_SPEECH) return { ...choice, audio: 'speech' }
  if (value === OUTPUT_BOTH) return { ...choice, audio: 'both' }
  const pack = packs.find((p) => p.id === value)
  if (!pack) return { ...choice, audio: 'sound', packId: value }
  const soundId = pack.sounds[choice.soundId] ? choice.soundId : Object.keys(pack.sounds)[0] ?? ''
  return { ...choice, audio: 'sound', packId: value, soundId }
}

/** Choosing a sound in the contextual select (the 'sound' and 'both' cases). */
export function withSoundId(choice: AudioChoice, soundId: string): AudioChoice {
  return { ...choice, soundId }
}

/**
 * Choosing a speak-what mode in the contextual select (the 'speech' case).
 *
 * Switching AWAY from 'custom' keeps the phrase: it is the user's text, and coming back to
 * custom should find it where they left it. It stops being spoken the moment the mode changes
 * (speechText.ts reads `phrase` only for 'custom'), which is the whole of what the change means.
 */
export function withSpeechMode(choice: AudioChoice, mode: SpeechMode): AudioChoice {
  return { ...choice, mode }
}

/**
 * Committing the inline custom-phrase popover.
 *
 * EMPTY TEXT IS NOT A CUSTOM PHRASE. `speechTextFor` would resolve it to nothing and fall back
 * to the alert's name, so leaving the mode on 'custom' would leave the select saying "custom"
 * about an alert that says its name — a picker lying about the def. It reverts to the mode that
 * describes what will actually be spoken.
 */
export function withPhrase(choice: AudioChoice, phrase: string): AudioChoice {
  const text = phrase.trim().slice(0, MAX_SPEECH_CHARS)
  return text ? { ...choice, mode: 'custom', phrase: text } : { ...choice, mode: 'alertName', phrase: '' }
}
