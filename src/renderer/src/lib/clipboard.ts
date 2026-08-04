// clipboard.ts — copy text to the OS clipboard from the renderer.
//
// ONE HOP, NO WEB API. `navigator.clipboard.writeText` cannot work in this app: it is gated on
// Chromium's 'clipboard-sanitized-write' permission and `hardenSession` (src/main/windows.ts)
// denies every web permission wholesale, so it rejects with `NotAllowedError: Write permission
// denied.` in every window — measured in the real app. The old fallback to
// `document.execCommand('copy')` is gone with it: it was deprecated platform surface kept alive
// only to paper over that rejection, and main's clipboard needs neither half.
//
// The write goes to main (`clipboard:write` → Electron's `clipboard` module, a Node API that
// consults no permission), which VALIDATES the text at the handler — non-empty string, length
// cap — and answers false for anything it refused. So the boolean means "this text is on the
// clipboard", not "a call was made"; callers show their snackbar / checkmark from it.
//
// NOTE ON EMPTY TEXT: `clipboard.writeText('')` would CLEAR the user's clipboard, so main
// refuses an empty payload by design and this returns false. A caller that can produce an empty
// string must decide what "nothing to copy" means for its UI — neither of today's callers can
// (both encode a prefixed share envelope).
//
// Never throws: an IPC rejection is a failed copy, not an exception for the UI to handle.

export async function copyText(text: string): Promise<boolean> {
  try {
    return await window.eq.writeClipboard(text)
  } catch {
    return false
  }
}
