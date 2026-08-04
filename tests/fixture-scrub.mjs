// SHARED FIXTURE SCRUB — the single gate every fixture extractor routes through.
//
// THIS FILE IS A SHIM, NOT A SECOND OPINION. The drop list, the families, the two carve-outs
// and the drop-never-rewrite law all live in `src/shared/logScrub.ts` now, because the SAME
// definition of "third-party chat/social" has to govern two artifacts:
//
//   1. `tests/fixtures/*.log` — committed to a PUBLIC repo by `tests/extract-*.mjs` (here).
//   2. the log slice a user attaches to an in-app feedback report (src/main/feedback/slice.ts).
//
// Read `src/shared/logScrub.ts` for the full rationale: the five enumerated DROP families,
// what is KEPT and why, the pet-claim carve-out, and the self-`/who` carve-out. Nothing about
// what a fixture keeps or drops changed in the promotion — this file's job is now only to bind
// the `selfName` parameter to the character whose log the fixtures are cut from.
//
// CONSEQUENCE FOR EXTRACTORS: because the shared module is TypeScript, the extractors must run
// under the tsx loader —
//
//     node --import tsx tests/extract-combat-fixtures.mjs "<path-to-eqlog>"
//
// which is what the `fixtures:*` npm scripts do. Running one with a bare `node` fails at the
// import, loudly, before it can write a fixture.

import {
  PET_CLAIM_RE,
  isThirdPartyChat as sharedIsThirdPartyChat,
  scrubKeep as sharedScrubKeep
} from '../src/shared/logScrub.ts'

export { PET_CLAIM_RE }

/** The character every committed fixture is cut from — their own identity may stay in their
 *  own repo, so their `/who` row (the ONLY line stating the class loadout) survives. */
export const SELF_NAME = 'Primitive'

/** True when the line is third-party chat/social and must be dropped from a committed fixture. */
export const isThirdPartyChat = (line) =>
  sharedIsThirdPartyChat(line, { selfName: SELF_NAME })

/** Convenience inverse — `lines.filter(scrubKeep)`. */
export const scrubKeep = (line) => sharedScrubKeep(line, { selfName: SELF_NAME })
