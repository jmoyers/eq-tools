// uiPrefs.ts — the renderer's half of a settings bundle.
//
// Main owns the electron-store half (alerts, alert prefs, overlay configs); the renderer
// owns localStorage. Rather than teach main about localStorage, every share call carries
// this map in and gets merged values back out.
//
// The set of keys is the WHITELIST in src/shared/profiles.ts (UI_PREF_SPECS) — read it
// there. Anything not listed (notably `eq.view`, the last-open tab) is machine-local and
// never leaves. Reading is defensive: a missing key is simply absent from the map.

import { UI_PREF_SPECS } from '@shared/profiles'

/** Snapshot the whitelisted localStorage prefs. Never throws (private-mode / quota). */
export function readUiPrefs(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const spec of UI_PREF_SPECS) {
    try {
      const v = localStorage.getItem(spec.key)
      if (v != null && v !== '') out[spec.key] = v
    } catch {
      // A single unreadable key just drops out of the bundle.
    }
  }
  return out
}

/**
 * Write back the values an import produced. Only whitelisted keys are honoured even if
 * main somehow returned something else — the renderer re-checks rather than trusting the
 * round trip. Returns how many keys actually changed.
 */
export function writeUiPrefs(values: Record<string, string>): number {
  const allowed = new Set(UI_PREF_SPECS.map((s) => s.key))
  let n = 0
  for (const [k, v] of Object.entries(values ?? {})) {
    if (!allowed.has(k) || typeof v !== 'string') continue
    try {
      if (localStorage.getItem(k) === v) continue
      localStorage.setItem(k, v)
      n++
    } catch {
      // Ignore quota/permission failures; the rest of the import still applies.
    }
  }
  return n
}
