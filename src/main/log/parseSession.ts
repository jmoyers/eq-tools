// SESSION family of the parse cascade (see parser.ts for the ordered list): the three lines
// that say whether the character is IN THE WORLD at all — the login, the camp-out intent,
// and the camp cancellation.
//
// Why its own module rather than a branch of parseWorld.ts: these are not world STATE (where
// you are, what you got, what level you are) — they are the frame around it. parseWorld.ts is
// also within a few lines of the 400-line factoring budget, and a family that will grow (the
// reconnect preamble is a known, deliberately-unparsed set — see below) deserves its own home.
//
// EVERY SHAPE IS EXACT AND MEASURED against the real 1,152,483-line log (2026-08-03):
//
//   `Welcome to EverQuest Legends!`                              19 lines → sessionStart
//   `It will take you about 30 seconds to prepare your camp.`    20 lines → campStart
//   `You abandon your preparations to camp.`                      2 lines → campAbort
//
// All 41 were `{kind:'unknown'}` before this module existed (full-log kind histogram diffed
// before/after: `unknown` 219305 → 219264, every other kind byte-identical).
//
// WHAT IS DELIBERATELY LEFT UNKNOWN, and why:
//
//   • THE COUNTDOWN TICKS — `It will take about {25,20,15,10,5} more seconds to prepare your
//     camp.` (78 lines). They restate the campStart and nothing consumes them. Leaving them
//     unparsed is not laziness: they are what makes the RECONNECT-WINDOW rule in
//     sessionDetector.ts safe, because they keep the last-known-online timestamp advancing
//     through the camp instead of freezing at the initiation line.
//   • THE RECONNECT PREAMBLE — `You are not currently assigned to an adventure.` (29),
//     `The Marketplace is unavailable at this time. Please try again later.`, `Channel <X> was
//     too full to join` (52), `Channels: 1=…` (22). These print BEFORE the Welcome, while the
//     client is connecting. Classifying them would be a second opinion on "am I online?" that
//     sessionDetector.ts already answers with a measured window — and it would not even work:
//     other players' CHANNEL CHAT arrives in the same burst (Jul 19 15:30:23, one second
//     before that login's Welcome), and chat is not a preamble shape.
//   • `LOADING, PLEASE WAIT...` (349) — zoning, already covered by `You have entered <zone>.`
//     (world-model law 4). A second zone signal would be exactly the duplicate opinion the
//     model forbids.

import type { LogEvent } from '../../shared/logEvents'
import type { ClassifyCtx } from './parseCommon'

/**
 * The login line. EXACT match, not a prefix: it is the game's own greeting and prints
 * verbatim on every entry into the world, so there is no variant to be permissive about,
 * and an exact test can never drift onto a chat line quoting it (chat is dropped by the
 * fixture scrub, but the RUNTIME parser sees it — `X tells General:1, 'Welcome to EverQuest
 * Legends!'` must not log the player in).
 */
const WELCOME_LINE = 'Welcome to EverQuest Legends!'

/**
 * Camp INITIATION. The full sentence is matched (not just "prepare your camp") so the five
 * `It will take about N more seconds…` ticks — which share the tail — can never claim it.
 */
const CAMP_START_LINE = 'It will take you about 30 seconds to prepare your camp.'

/** Camp CANCELLED. The game says it outright; we never infer an abort (world-model law 1). */
const CAMP_ABORT_LINE = 'You abandon your preparations to camp.'

/**
 * `Welcome to EverQuest Legends!` — the character is in the world (see SessionStartEvent).
 *
 * Gated on the leading `W` before the string compare so the hot path (combat lines) pays a
 * single character test, matching the cheap-discriminator-first convention of the cascade.
 */
export function classifySessionStart({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.charCodeAt(0) !== 87 /* 'W' */ || text !== WELCOME_LINE) return null
  return { kind: 'sessionStart', seq, ts, raw }
}

/**
 * The camp lines — initiation and cancellation. One classifier for both because they are one
 * fact with two outcomes, and because a single `text.length` check rules out every combat line
 * before either compare runs.
 */
export function classifyCamp({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (!text.endsWith('camp.')) return null
  if (text === CAMP_START_LINE) return { kind: 'campStart', seq, ts, raw }
  if (text === CAMP_ABORT_LINE) return { kind: 'campAbort', seq, ts, raw }
  return null
}
