// security.ts — the pure half of the Electron runtime's trust boundary.
//
// THE PROBLEM. Three of this app's windows-and-links behaviors take a string that ORIGINATES
// OUTSIDE the app and hand it to something powerful:
//
//   * `setWindowOpenHandler` → `shell.openExternal(url)`. openExternal hands the URL to the
//     OS. On Windows that means `file:///C:/…/evil.exe` LAUNCHES it, `ms-msdt:`/`search-ms:`/
//     `mailto:` and every other registered protocol handler is reachable, and a UNC path
//     (`file://attacker/share/x.lnk`) makes the machine authenticate to a remote SMB host.
//     The URLs that reach it are built from WIKI PAGE TITLES (`shared/wiki.ts`, fed by
//     `itemLookup`'s scraped `page` field and by the event feed) — i.e. text this app did not
//     author. That is the classic RCE-adjacent Electron hole, and "today's producer happens
//     to prefix https://eqlwiki.com/" is a convention, not a boundary.
//   * `will-navigate`. Nothing in this app should ever navigate a window away from its
//     bundled page; if something does, the app's own preload bridge (`window.eq`, full IPC
//     surface) would be exposed to whatever loaded.
//   * `sounds:getData`'s `packId`, which is `join()`ed onto the soundpack roots.
//
// THE SHAPE. Every rule here is a TOTAL, PURE function over arbitrary input, so it can be
// unit-tested without Electron (tests/security.test.mts) — the imageCache.ts / storeMigrations.ts
// precedent. The Electron wiring that CALLS them (`app.on('web-contents-created')`, the
// permission handlers) lives in windows.ts next to the window construction it guards, and is
// installed from the composition root (index.ts) before the first window exists.
//
// DENY BY DEFAULT is the rule in all three: an input that isn't recognized is rejected, never
// "passed through because it looked harmless".

import { sep } from 'node:path'

/**
 * The complete set of hosts a link in this app may open in the user's browser.
 *
 *   eqlwiki.com          — every in-app external link today (`shared/wiki.ts wikiPageUrl`):
 *                          the item dialog's Source link, PoskyView's class-quest links and
 *                          the event-log overlay's headline links.
 *   www.eqlwiki.com      — same site; the wiki answers on both.
 *   wiki.project1999.com — the other wiki this app already talks to (boss portraits, see
 *                          imageCache.ts's IMAGE_URL_ALLOWLIST). Listed so a future boss link
 *                          works, not because one exists today.
 *
 * Adding a host here is a deliberate decision to let renderer-supplied text cause the OS to
 * open something. Deliberately NOT shared with imageCache's list: that one governs what the
 * MAIN process will fetch bytes from, this one governs what the OS will be asked to open —
 * two different powers that should be widened independently.
 */
export const EXTERNAL_LINK_ALLOWLIST: readonly string[] = [
  'eqlwiki.com',
  'www.eqlwiki.com',
  'wiki.project1999.com'
]

const ALLOWED_LINK_HOSTS = new Set(EXTERNAL_LINK_ALLOWLIST)

/** Longest URL we will even look at. Real links are ~60 chars; this only exists so a
 *  megabyte of `<a href>` can't be pushed through `new URL()`. */
const MAX_LINK_LEN = 2048

/**
 * Validate a URL a window asked to open externally. Returns the NORMALIZED URL that is safe
 * to hand to `shell.openExternal`, or null — in which case nothing is opened at all.
 *
 * Each check, and why it is a check and not a nicety:
 *   * `https:` ONLY        — this is the whole point. `file:` executes, `mailto:`/`ms-*:`/
 *                            `search-ms:` reach arbitrary registered protocol handlers, and
 *                            `http:` would be a silent downgrade. One scheme, no exceptions.
 *   * no credentials       — `https://eqlwiki.com@evil.com/x` parses with hostname
 *                            `evil.com` (the host test already rejects it), and refusing
 *                            userinfo outright means we never hand the OS one either.
 *   * default port only    — `:8080` on an allowlisted host is a different service.
 *   * EXACT hostname match — never `includes`/`endsWith`: `eqlwiki.com.evil.com` and
 *                            `evil-eqlwiki.com` must fail, and they do. `new URL()`
 *                            lowercases + punycodes the host, so a homoglyph domain can
 *                            never compare equal to an ASCII entry.
 *
 * The href is returned rather than the caller's raw string so what we open is what we
 * validated (WHATWG normalization already applied), never the original spelling.
 */
export function allowedExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LINK_LEN) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  if (u.username !== '' || u.password !== '') return null
  if (u.port !== '') return null
  if (!ALLOWED_LINK_HOSTS.has(u.hostname)) return null
  return u.toString()
}

/** Where the app's own pages live, for `isInternalPageUrl`. */
export interface InternalPageOrigins {
  /**
   * `process.env.ELECTRON_RENDERER_URL` in dev (electron-vite's HMR server, `http://localhost:5173`
   * — 5174 when 5173 is taken, which is why this is the SERVER'S OWN url and not a hardcoded
   * port). Undefined in a packaged app, where there is no dev server and no http page at all.
   */
  readonly devServerUrl?: string
  /** The directory the bundled renderer pages load from — `join(__dirname, '../renderer')`. */
  readonly rendererDir: string
}

/**
 * Is `raw` one of the app's OWN pages — i.e. may a window navigate there?
 *
 * Exactly two shapes qualify:
 *   * dev: any URL on the electron-vite dev server's origin (an HMR full-reload navigates
 *     back to it, and the overlay loads `<origin>/overlay.html?kind=…`). Origin equality, so
 *     the port is whatever the server actually took and `http://localhost:5173.evil.com`
 *     is not it.
 *   * packaged/dev-without-server: a `file:` URL whose path is inside the renderer bundle dir.
 *
 * Everything else — https, about:blank, data:, javascript:, a file: path anywhere else on
 * disk, a UNC path — is external and gets denied. Prefix-of-rendererDir rather than an exact
 * list of the two page names so a future page/asset needs no change here; the boundary that
 * matters is "inside the bundle we shipped".
 */
export function isInternalPageUrl(raw: unknown, origins: InternalPageOrigins): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (origins.devServerUrl) {
    let dev: URL | null = null
    try {
      dev = new URL(origins.devServerUrl)
    } catch {
      dev = null
    }
    // `origin` is scheme+host+port, already normalized by WHATWG — the correct comparison.
    if (dev && u.origin !== 'null' && u.origin === dev.origin) return true
  }
  if (u.protocol !== 'file:') return false
  const path = fileUrlToLocalPath(u)
  if (path == null) return false
  return isInsideDir(path, origins.rendererDir)
}

/**
 * `file:` URL → local path, or null when it is not a plain local file.
 *
 * A non-empty `host` means UNC (`file://server/share/x`) — refused outright rather than
 * translated, because a remote path must never be able to look "inside" a local directory.
 * `%2e%2e` and friends are decoded here on purpose: the traversal has to be visible to the
 * containment check below, not hidden behind an escape.
 */
export function fileUrlToLocalPath(u: URL): string | null {
  if (u.host !== '') return null
  let p: string
  try {
    p = decodeURIComponent(u.pathname)
  } catch {
    return null // malformed percent-escapes
  }
  if (p.includes('\0')) return null
  // Windows: `/C:/Users/…` → `C:\Users\…`. POSIX: the leading slash is the path.
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
  return process.platform === 'win32' ? p.replace(/\//g, '\\') : p
}

/**
 * Is `path` the directory `dir` itself or something under it? Segment-aware (a trailing
 * separator is enforced, so `…\rendererEVIL` is not "inside" `…\renderer`), traversal-aware
 * (any `..` segment disqualifies — this is a string containment test, not a resolver), and
 * case-insensitive on Windows only.
 */
export function isInsideDir(path: string, dir: string): boolean {
  if (!path || !dir) return false
  const norm = (s: string): string => {
    const swapped = process.platform === 'win32' ? s.replace(/\//g, '\\') : s
    return process.platform === 'win32' ? swapped.toLowerCase() : swapped
  }
  const p = norm(path)
  const d = norm(dir).replace(new RegExp(`\\${sep}+$`), '')
  if (p.split(/[\\/]/).includes('..')) return false
  return p === d || p.startsWith(d + sep)
}

/**
 * Soundpack ids name a DIRECTORY under `<userData>/soundpacks` (and under the bundled
 * roots), and `sounds:getData` takes one straight off the renderer. A crafted id
 * (`../../../Users/x/Documents`) would make `join()` resolve outside those roots, turning the
 * channel into a "read any .wav/.mp3/.ogg next to a manifest.json" primitive.
 *
 * The ids in play are registry pack names (`alan-rickman`, `sc_marine`) — lowercase words,
 * digits, dash, underscore, dot. So this is an ALLOWLIST of characters, not a blocklist of
 * traversal spellings: no separators, no drive letters, no `..`, no absolute paths, and
 * nothing that could be a Windows ADS (`:`) or a UNC prefix can survive it. A leading dot is
 * refused too, so a pack can never be `..` or a hidden dir.
 */
export function isSafePackId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(id)
}
