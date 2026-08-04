// useVoices — the React half of the speech seam: one hook that hands a picker the voices a
// tier can actually speak with.
//
// It lives beside `lib/speech.ts` rather than inside it because that module is loaded by
// node:test (its two pure decisions are unit-pinned) and must stay React-free and DOM-free at
// module scope. Everything asynchronous and platform-specific — including the `voiceschanged`
// dance that makes a cold `getVoices()` lie — is already handled there; this is the subscription.
//
// BOTH pickers use it (the preferences default voice and the alert editor's per-alert override),
// so "which voices exist" has one answer in the UI, and swapping the engine tier re-reads
// exactly once.

import { useEffect, useState } from 'react'
import type { SpeechEngine, SpeechVoice } from '@shared/types'
import { listVoices } from './speech'

/**
 * The voices of one engine tier, or `[]` while they load — and `[]` for a tier that is not
 * installed, which is not an error but the accurate inventory (the kokoro row renders
 * "not installed" from exactly this emptiness, per voice-alerts §2).
 *
 * `refreshKey` is the seam for the one thing that CHANGES a tier's inventory while the panel is
 * open: finishing the Kokoro download. Engine alone is not enough — the tier the user is looking
 * at is the same tier before and after the install, so a bump of this number is what re-asks. Any
 * changing value works; the preferences panel counts completed installs.
 */
export function useVoiceOptions(engine: SpeechEngine, refreshKey = 0): SpeechVoice[] {
  const [voices, setVoices] = useState<SpeechVoice[]>([])
  useEffect(() => {
    let alive = true
    void listVoices(engine).then((list) => {
      if (alive) setVoices(list)
    })
    return () => {
      alive = false
    }
  }, [engine, refreshKey])
  return voices
}
