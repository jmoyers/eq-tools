// audioThrottle.ts — CROSS-ALERT audio coalescing: "if three buffs fade at once, that is one
// audio alert" (owner direction, 2026-08-04).
//
// THE PROBLEM THIS SOLVES IS NOT COOLDOWN. Each AlertDef already has its own `cooldownMs`,
// which stops ONE alert from repeating. It says nothing about three DIFFERENT alerts landing in
// the same tick — a Quick Buff burst, a zone-in, an AoE that fades four buffs at once — and
// those are exactly the moments the app was loudest and least useful: four sounds stacked into
// a smear that carries less information than one. So this is a second, orthogonal gate applied
// ACROSS alerts, on top of every def's own cooldown, which is untouched.
//
// WHAT IT GATES IS AUDIO, NOT FIRING. A suppressed firing still fires: main's evaluation,
// cooldowns, and the recent-fires ring are all upstream of here and see every fire. The record
// is not the noise. What is dropped is the second, third and fourth SOUND — and the speech with
// it, because "one audio alert" is a claim about what you HEAR, not about which channel it came
// out of. An `audio:'both'` alert is ONE occupancy, not two: its sound + queued utterance are a
// single unit by design (voice-alerts D5), so charging it twice would let it silence itself.
//
// FIRST ARRIVAL WINS, and a suppressed firing does NOT extend the window. A rolling window would
// let a steady stream of alerts mute the app indefinitely; a fixed one always reopens.
//
// PURE, so the whole policy is node-tested with no DOM and no clock: the caller owns the
// `lastAudioMs` cell and the `now` reading, this file owns the decision.

import type { AlertDef } from '@shared/types'

/**
 * How long one played alert occupies the audio channel.
 *
 * 1500ms is a burst-coalescing window, deliberately NOT a rate limit and deliberately NOT a
 * user setting. It is long enough to fold the simultaneous cases the owner named (a
 * multi-buff fade, a zone-in, an AoE) into one utterance, and short enough that two things
 * that genuinely happened at different moments still both speak — a typical alert sound is
 * ~0.6-1.2s, so the next alert is audible as soon as the previous one has stopped talking
 * rather than queuing behind it. Making it configurable would be offering the user a dial for
 * "how much of my own log do I want to miss"; the per-alert opt-out below is the honest knob.
 */
export const AUDIO_COALESCE_MS = 1500

/** The def fields the throttle reads. Any AlertDef satisfies it. */
export type ThrottledDef = Pick<AlertDef, 'alwaysPlay'>

export interface ThrottleDecision {
  /** may this firing make a sound (and/or speak)? */
  play: boolean
  /** the caller's new `lastAudioMs` cell — write it back verbatim. */
  lastAudioMs: number | null
}

/**
 * Decide whether this firing's audio plays, and what the audio channel's occupancy becomes.
 *
 * THE OPT-OUT BYPASSES **AND DOES NOT OCCUPY** (deliberate, of the two honest rules):
 * `alwaysPlay` marks an alert the user has said must never be swallowed — a raid wipe call, a
 * charm break. If such an alert also OPENED a window, the very act of protecting it would
 * silence the ordinary alert behind it, and two `alwaysPlay` alerts firing together would
 * silence each other — precisely the alerts that must not be silenced. So an opted-out firing
 * is transparent to the window in both directions: it ignores one, and it leaves whatever
 * window was already open exactly as it found it (a burst of ordinary alerts is still coalesced
 * around it).
 */
export function coalesceAudio(
  def: ThrottledDef,
  now: number,
  lastAudioMs: number | null
): ThrottleDecision {
  if (def.alwaysPlay === true) return { play: true, lastAudioMs }
  if (lastAudioMs !== null && now - lastAudioMs < AUDIO_COALESCE_MS) {
    return { play: false, lastAudioMs }
  }
  return { play: true, lastAudioMs: now }
}
