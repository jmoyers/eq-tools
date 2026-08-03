// clipboard.ts — copy text to the OS clipboard from the renderer.
//
// navigator.clipboard needs a secure context; the packaged app loads from file:// which
// qualifies, but the dev server and the overlay entry have historically been fussier, so
// there's a synchronous execCommand fallback. Never throws — callers show a snackbar based
// on the boolean.

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    // Keep it off-screen and unfocusable-looking so nothing flashes.
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    ta.style.top = '0'
    document.body.appendChild(ta)
    ta.select()
    // Deprecated by the platform and kept ON PURPOSE — it is the fallback for exactly
    // the contexts where navigator.clipboard is unavailable, so "use the modern API
    // instead" is not an option here.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
