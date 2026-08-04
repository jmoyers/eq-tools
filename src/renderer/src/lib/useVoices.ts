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
 * The voices of one engine tier, or `[]` while they load — and `[]` FOREVER for a tier that is
 * not installed, which is not an error but the accurate inventory (the kokoro row renders
 * "not installed" from exactly this emptiness, per voice-alerts §2).
 */
export function useVoiceOptions(engine: SpeechEngine): SpeechVoice[] {
  const [voices, setVoices] = useState<SpeechVoice[]>([])
  useEffect(() => {
    let alive = true
    void listVoices(engine).then((list) => {
      if (alive) setVoices(list)
    })
    return () => {
      alive = false
    }
  }, [engine])
  return voices
}
