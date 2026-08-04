// appSchemes.ts — THE ONE `registerSchemesAsPrivileged` call.
//
// Electron allows this exactly once, before `ready`, and a second call is silently ignored.
// That makes it the same shape as `WEB_PREFERENCES()` in windows.ts (AGENTS.md trust
// boundary): a single site that every custom scheme must be declared through, rather than
// each feature reaching for `protocol` and the second one quietly losing.
//
// The privileges themselves stay with the feature that owns the scheme — `imageCache.ts` for
// `eqimg://`, `speech/cache.ts` for `eqspeech://` — because that is where the reasoning about
// them (why `standard`, why not `bypassCSP`) belongs. This file only holds the list.
//
// Called at index.ts MODULE SCOPE, not in whenReady: the declaration has to be in place
// before the app is ready, while each scheme's `protocol.handle` is installed after.

import { EQIMG_SCHEME_PRIVILEGES } from './imageCache'
import { EQSPEECH_SCHEME_PRIVILEGES } from './speech/cache'

/** The slice of Electron's `protocol` module this file uses (structural, so tests can stub). */
export interface SchemeRegistrar {
  registerSchemesAsPrivileged(
    schemes: { scheme: string; privileges?: Record<string, boolean> }[]
  ): void
}

/** Every custom scheme this app serves, with its privileges. */
export const APP_SCHEMES = [EQIMG_SCHEME_PRIVILEGES, EQSPEECH_SCHEME_PRIVILEGES]

export function registerAppSchemes(protocol: SchemeRegistrar): void {
  protocol.registerSchemesAsPrivileged(APP_SCHEMES.map((s) => ({ ...s, privileges: { ...s.privileges } })))
}
