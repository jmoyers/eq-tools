// IPC: the one door to the OS clipboard.
//
// WHY MAIN OWNS THE CLIPBOARD. The renderer's obvious tool, `navigator.clipboard.writeText`,
// is permission-gated in Chromium ('clipboard-sanitized-write') and this app denies every web
// permission wholesale (`hardenSession` in ../windows.ts, `setPermissionCheckHandler(() =>
// false)`). Measured in the real app: the promise rejects with
//   NotAllowedError: Failed to execute 'writeText' on 'Clipboard': Write permission denied.
// and `navigator.permissions.query({name:'clipboard-write'})` answers 'denied'. Widening the
// permission handler for a copy button would trade a structural boundary for a convenience, so
// the copy comes here instead: Electron's `clipboard` module is a main-process Node API, not a
// web API, and consults no permission at all.
//
// The text is VALIDATED AT THE HANDLER (the trust-boundary rule in AGENTS.md) — a renderer
// string is a renderer string whether or not today's only caller is the app's own UI:
//   * must be a string      — anything else is a caller bug, and Electron would stringify it.
//   * must be non-empty     — `clipboard.writeText('')` CLEARS the clipboard, so an empty
//                             payload would silently destroy whatever the user had copied.
//                             Nothing to copy ⇒ copy nothing.
//   * bounded length        — the biggest real payload is a fight breakdown (a few KB). The cap
//                             exists so a runaway serializer can't hand the OS a megabyte-scale
//                             blob (and the copy of it that main then holds) by accident.
// Rejected input answers `false` and writes nothing; the caller shows no "copied" affordance.

import { clipboard, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'

/** Longest text this app will put on the clipboard, in UTF-16 code units (~1MB of ASCII). */
const MAX_CLIPBOARD_CHARS = 1_000_000

export function registerClipboardIpc(): void {
  ipcMain.handle(IPC.clipboardWrite, (_e, text: unknown): boolean => {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_CLIPBOARD_CHARS) {
      return false
    }
    clipboard.writeText(text)
    return true
  })
}
