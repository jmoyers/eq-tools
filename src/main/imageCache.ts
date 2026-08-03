// imageCache.ts — PERMANENT on-disk cache for every image the app downloads.
//
// THE PROBLEM. The app downloads two classes of image: EQ item icons (eqlwiki, keyed by a
// numeric file id) and raid-boss portraits (`bosses.json` carries 29 absolute
// wiki.project1999.com URLs). Both used to be `<img src="https://…">`, so every hover
// tooltip, every loot dialog, every overlay window and every visit to the Raid Targets tab
// re-asked a volunteer-run wiki. Chromium's HTTP cache is ephemeral (it is evicted, it lives
// inside the channel's Chromium profile, and it is not shared between renderer processes in
// any way the user can rely on), and the wikis answer through redirects that are not
// aggressively cacheable. Net effect: the same handful of KB fetched over and over, forever,
// against hosts we have promised to be polite to (AGENTS.md "Scraper etiquette (LAW)").
//
// THE SHAPE. A custom protocol handled in MAIN, backed by a plain directory. TWO routes,
// one handler, one cache:
//
//     <img src="eqimg://item/1234">                    an eqlwiki item icon, by file id
//     <img src="eqimg://url/https%3A%2F%2Fwiki…png">   any allowlisted absolute image URL
//        └► protocol.handle('eqimg')     main process, ONE handler for every window
//             ├► <userData>/image-cache/<name> exists ⇒ serve the bytes, no network
//             └► else fetch upstream once (polite UA), write ATOMICALLY, then serve
//
// WHY A PROTOCOL and not an IPC "give me a data URL" call: `<img src>` is the natural idiom,
// it needs no async plumbing in the renderer, and the SAME handler serves the main window
// and every overlay window for free — they all use the default session. (Verified: nothing
// in src/main constructs a window with a custom `partition`/`session`, so `protocol.handle`
// on the default session covers all of them.)
//
// WHY THE `url` ROUTE EXISTS AT ALL rather than a second id-keyed route: boss portraits are
// SCRAPED DATA. `bosses.json` holds the real upstream URLs (that is what the scraper found
// and what a human re-checks against the wiki), and inventing an app-private id for each one
// would mean a lookup table that has to be regenerated whenever the scrape changes. The
// WRAPPING is the app's concern, so the renderer wraps at render time
// (`lib/imageUrl.ts cachedImageUrl`) and the data file stays honest.
//
// PERMANENT means permanent. No TTL, no eviction, no size cap. A wiki file URL maps to one
// immutable image; anything fetched once must never be fetched again. Two rules keep that
// safe:
//   * ATOMIC WRITES. Bytes land in `<name>.<pid>.<rand>.tmp` and are renamed into place.
//     A half-written PNG cached forever is exactly the failure "permanent" must not create
//     (a torn file has no expiry to save it), and rename is atomic within a directory.
//   * NEVER CACHE A NEGATIVE. A 404/offline/timeout responds 404 to the renderer (whose
//     existing `onError` hides the image) and writes nothing, so the next load retries.
//     Permanence is for successes only.
//
// SECURITY. `parseEqImgUrl` is the ONLY thing that turns a renderer string into a filesystem
// path, and for the `url` route it is also the only thing that decides what the app is
// allowed to FETCH — a renderer-supplied URL is attacker-shaped input the moment any wiki
// text or scraped field reaches it. Two independent boundaries:
//   * WHAT WE FETCH: `normalizeUpstreamImageUrl` decodes the segment, parses it with
//     `new URL()`, and demands `protocol === 'https:'`, no credentials, the default port,
//     and a hostname that EXACTLY equals an entry of `IMAGE_URL_ALLOWLIST`. Exact equality,
//     never `includes`/`endsWith`: `wiki.project1999.com.evil.com` and
//     `evil.com/?x=wiki.project1999.com` both have to fail, and they do. Everything else
//     404s having touched the network zero times.
//   * WHAT WE NAME: the file name is DERIVED, never taken. `item` ids are digits-only and
//     length-capped; a `url` entry is named by the sha256 of its normalized URL, so no
//     amount of `../`, drive letters, UNC prefixes, NTFS reserved names or 300-char paths
//     in the input can name a file we didn't choose.
//
// TESTABILITY. Everything pure (URL parse, allowlist, path derivation, image sniffing) is
// exported and unit-tested in tests/imageCache.test.mts; Electron is INJECTED (the caller
// passes `protocol` and the userData dir), so the tests need no Electron and never skip —
// the storeMigrations.ts / overlayLayout.ts precedent.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The scheme the renderer asks for. */
export const EQIMG_SCHEME = 'eqimg'

/** Cache directory, relative to the channel's userData root. */
export const IMAGE_CACHE_DIR_NAME = 'image-cache'

/** Same polite identity every scraper in this repo sends (AGENTS.md scraper etiquette). */
const UA = 'everquest-companion/0.1 (personal quest tracker)'

const FETCH_TIMEOUT_MS = 10_000

/** Item ids are wiki `lucy_img_ID`s — small integers. Cap the length so nothing absurd can
 *  reach the filesystem even if the digits check somehow passed a 10 KB string. */
const MAX_ID_LEN = 12

/** Longest absolute upstream URL we will look at, decoded. Real entries are ~90 chars; this
 *  only exists so a megabyte of `<img src>` can't be pushed through `new URL()` + sha256. */
const MAX_URL_LEN = 512

/** …and the encoded segment before decoding (percent-encoding can triple the length). */
const MAX_ENCODED_URL_LEN = MAX_URL_LEN * 3

/**
 * THE SECURITY BOUNDARY of the `url` route: the complete set of hosts this app will fetch an
 * image from. Exact hostname equality only — see `normalizeUpstreamImageUrl`.
 *
 *   wiki.project1999.com — raid-boss portraits (`bosses.json`, scraped)
 *   eqlwiki.com          — item icons and anything else scraped from the EQL wiki
 *
 * Adding a host here is a deliberate decision to let the renderer cause traffic to it.
 */
export const IMAGE_URL_ALLOWLIST: readonly string[] = ['wiki.project1999.com', 'eqlwiki.com']

const ALLOWED_HOSTS = new Set(IMAGE_URL_ALLOWLIST)

/** eqlwiki serves item icons at a stable redirect path keyed by the page's lucy_img_ID.
 *  This is the ONE place that upstream URL is spelled out (the renderer no longer knows it). */
export function wikiItemIconUrl(id: string): string {
  return `https://eqlwiki.com/index.php?title=Special:Redirect/file/Item_${id}.png`
}

/**
 * Validate + canonicalize a renderer-supplied absolute image URL. Returns the NORMALIZED URL
 * (the thing we fetch and the thing we hash), or null if it is not one this app may fetch.
 *
 * Total over arbitrary input — `new URL()` throws, and this is fed whatever a `<img src>`
 * contained. The checks, and why each one is a check and not a nicety:
 *   * `https:` only        — an http URL would be a silent downgrade the CSP can no longer
 *                            see (img-src lists `eqimg:`, not the upstream scheme), and a
 *                            `file:`/`data:` URL here would be a local-file read primitive.
 *   * no credentials       — `https://wiki.project1999.com@evil.com/x` parses with hostname
 *                            `evil.com`; the hostname test alone already rejects it, but
 *                            refusing userinfo outright means we never send one either.
 *   * default port only    — `:8080` on an allowlisted host is a different service; WHATWG
 *                            URL strips a redundant `:443`, so an explicit default is fine.
 *   * EXACT hostname match — `.endsWith('project1999.com')` would accept
 *                            `evil-project1999.com`; `.includes(...)` would accept
 *                            `wiki.project1999.com.evil.com`. Both are rejected here.
 *                            `new URL()` also lowercases and IDNA/punycodes the host, so a
 *                            homoglyph domain can never compare equal to an ASCII entry.
 *
 * The fragment is dropped: it never reaches the server, so keeping it would only split one
 * set of bytes across two permanent cache entries. The query is KEPT — it is part of what we
 * ask for, hence part of the identity.
 */
export function normalizeUpstreamImageUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LEN) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  if (u.username !== '' || u.password !== '') return null
  if (u.port !== '') return null
  if (!ALLOWED_HOSTS.has(u.hostname)) return null
  u.hash = ''
  return u.toString()
}

/** Stable, filesystem-safe identity for an upstream URL: sha256, truncated to 96 bits of hex.
 *  Truncation is safe here — this is a cache key, not a signature, and 2^96 keyspace over a
 *  few dozen wiki images has no collision story worth telling. */
export function urlCacheHash(normalizedUrl: string): string {
  return createHash('sha256').update(normalizedUrl, 'utf8').digest('hex').slice(0, 24)
}

/** A parsed, VALIDATED `eqimg://` request. */
export type EqImgRequest =
  | {
      readonly kind: 'item'
      /** Digits only, length-capped — safe to interpolate into a file name. */
      readonly id: string
    }
  | {
      readonly kind: 'url'
      /** The NORMALIZED, allowlisted upstream URL — safe to fetch. */
      readonly url: string
      /** `urlCacheHash(url)` — hex only, so it is safe to interpolate into a file name. */
      readonly hash: string
    }

/**
 * Parse the two routes the renderer may emit — anything else → null.
 *
 *   eqimg://item/<digits>                        → {kind:'item', id}
 *   eqimg://url/<encodeURIComponent(https URL)>  → {kind:'url', url, hash}
 *
 * Deliberately hand-rolled rather than `new URL()`-driven at the OUTER level: whether the
 * scheme is registered as `standard` changes how WHATWG URL splits host vs path
 * (`eqimg://item/7` is host='item',path='/7' when standard, host='',path='//item/7' when
 * not), and this must be a total function over arbitrary renderer input either way. The
 * INNER url — the part that decides what we fetch — is parsed with `new URL()` precisely
 * because that is the parser Chromium/curl/the server would agree with, and guessing at its
 * quirks by hand is how host-confusion bugs are written.
 *
 * The encoded payload survives Chromium's canonicalization intact: `encodeURIComponent`
 * escapes `/` and `:` (so the segment can never split), emits UPPERCASE hex (which is what
 * Chromium normalizes to anyway) and never emits a character Chromium's path escaper would
 * re-encode. Query/hash on the OUTER url are ignored; everything else must be exactly two
 * segments.
 */
export function parseEqImgUrl(raw: string): EqImgRequest | null {
  if (typeof raw !== 'string') return null
  const prefix = `${EQIMG_SCHEME}://`
  if (raw.slice(0, prefix.length).toLowerCase() !== prefix) return null
  let rest = raw.slice(prefix.length)
  // Drop query + fragment (Chromium may append neither, but the renderer could).
  const cut = rest.search(/[?#]/)
  if (cut >= 0) rest = rest.slice(0, cut)
  const segments = rest.split('/').filter((s) => s.length > 0)
  if (segments.length !== 2) return null
  const [kind, payload] = segments
  switch (kind.toLowerCase()) {
    case 'item': {
      if (!/^\d+$/.test(payload) || payload.length > MAX_ID_LEN) return null
      return { kind: 'item', id: payload }
    }
    case 'url': {
      if (payload.length > MAX_ENCODED_URL_LEN) return null
      let decoded: string
      try {
        decoded = decodeURIComponent(payload)
      } catch {
        // Malformed percent-escapes (`%`, `%2`, `%ZZ`, a lone surrogate) throw URIError.
        return null
      }
      const url = normalizeUpstreamImageUrl(decoded)
      if (!url) return null
      return { kind: 'url', url, hash: urlCacheHash(url) }
    }
    default:
      return null
  }
}

/** The upstream URL a validated request resolves to. The ONLY thing that ever gets fetched. */
export function upstreamUrlFor(req: EqImgRequest): string {
  return req.kind === 'item' ? wikiItemIconUrl(req.id) : req.url
}

/** `<userData>/image-cache` — the whole cache, one flat directory. */
export function imageCacheDir(userData: string): string {
  return join(userData, IMAGE_CACHE_DIR_NAME)
}

/**
 * Extension-less cache identity of a request. Derived entirely from validated fields
 * (digits, or hex) — never from user text — which is what makes every path below a direct
 * child of the cache dir no matter what the renderer sent. Also the in-flight dedupe key.
 */
export function cacheStem(req: EqImgRequest): string {
  return req.kind === 'item' ? `item-${req.id}` : `url-${req.hash}`
}

/** The extensions the cache can produce, in probe order (png first — it is ~all of them). */
export const CACHE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'gif', 'webp']

/** File extension for a mime `sniffImageMime` can return. Unknown ⇒ 'png' is unreachable:
 *  callers only ever pass a sniff result, and the sniffer returns exactly these four. */
export function extForMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    default:
      return 'png'
  }
}

/**
 * The name a fetched entry is WRITTEN under, once its bytes have been sniffed.
 *
 * EXTENSION SCHEME (the read side is `cacheCandidateNames`): the extension states what the
 * bytes actually are, so `<userData>/image-cache/` stays a folder a human can open and
 * browse. It is not authoritative — the served `content-type` is re-sniffed from the bytes
 * on every read — it is just an honest label.
 *
 *   item — always `.png`. The upstream is a `…/file/Item_<id>.png` redirect and the id alone
 *          determines the name, so a single `existsSync` resolves it. (Kept fixed on purpose:
 *          entries written by earlier builds stay findable.)
 *   url  — `.` + the sniffed extension. The URL says nothing reliable about the payload
 *          (p1999 serves `.png`, `.PNG` and `.jpg`), so the bytes decide.
 *
 * A `url` READ therefore probes up to four names — a bounded constant, not a directory scan,
 * so lookup stays O(1). The alternative (one uniform `.bin` extension, or a sidecar file
 * holding the type) would make reads exactly one stat but turn the cache into an opaque blob
 * pile; four stats on a local directory is not a cost worth that.
 */
export function cacheFileName(req: EqImgRequest, mime: string): string {
  return req.kind === 'item' ? `${cacheStem(req)}.png` : `${cacheStem(req)}.${extForMime(mime)}`
}

/** Every name a cached entry for `req` could be sitting under, in probe order. */
export function cacheCandidateNames(req: EqImgRequest): string[] {
  const stem = cacheStem(req)
  return req.kind === 'item' ? [`${stem}.png`] : CACHE_EXTENSIONS.map((e) => `${stem}.${e}`)
}

/** Absolute on-disk path a fetched entry is written to. */
export function cachePathFor(userData: string, req: EqImgRequest, mime: string): string {
  return join(imageCacheDir(userData), cacheFileName(req, mime))
}

/** Absolute on-disk paths to probe before fetching. */
export function cacheCandidatePaths(userData: string, req: EqImgRequest): string[] {
  const dir = imageCacheDir(userData)
  return cacheCandidateNames(req).map((n) => join(dir, n))
}

/**
 * Content type from the bytes themselves. The wiki redirect is named `.png` but serves
 * whatever the uploader uploaded, and an `<img>` fed the wrong type still renders — this is
 * only so the response is honest. Unknown/garbage ⇒ null, which the caller treats as a
 * FAILED fetch (nothing that isn't recognizably an image is ever written to a permanent
 * cache).
 */
export function sniffImageMime(buf: Uint8Array): string | null {
  if (buf.length < 12) return null
  const b = buf
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  // RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45)
    return 'image/webp'
  return null
}

// ---- the impure half (Electron injected) --------------------------------------------

/** The slice of Electron's `protocol` module this file uses. Structural, so tests could
 *  pass a stub and the real `Electron.Protocol` satisfies it. */
export interface ProtocolLike {
  registerSchemesAsPrivileged(schemes: { scheme: string; privileges?: Record<string, boolean> }[]): void
  handle(scheme: string, handler: (request: GlobalRequest) => GlobalResponse | Promise<GlobalResponse>): void
}

/**
 * Declare the scheme's privileges. MUST be called at module/import time — before the app's
 * `ready` event — which is why it is separate from `installImageCacheProtocol`.
 *
 *   standard  : gives the scheme normal URL semantics (host/path parsing, a real origin) so
 *               Chromium treats `eqimg://item/7` as a subresource URL like any other.
 *   secure    : a secure-context page (our renderer) may load it without a mixed-content
 *               downgrade warning.
 *   supportFetchAPI + stream: allow fetch()/streamed responses, which `protocol.handle`'s
 *               Response-based API is built on.
 *
 * bypassCSP is deliberately NOT set: the renderer's own CSP lists `eqimg:` under img-src, so
 * the policy stays explicit and auditable in index.html/overlay.html.
 */
export function registerImageCacheSchemes(protocol: ProtocolLike): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: EQIMG_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

/** Options for the handler (injected so tests/other callers never touch `app`). */
export interface ImageCacheOptions {
  /** The channel's userData root — `app.getPath('userData')`. */
  readonly userData: string
  /** Override for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch
  /** Override for tests; defaults to console.log. */
  readonly log?: (msg: string) => void
  /** Override for tests; defaults to console.error via the caller. */
  readonly onError?: (msg: string, err: unknown) => void
}

const NOT_FOUND = (): GlobalResponse => new Response(null, { status: 404, statusText: 'Not Found' })

/**
 * Install the `eqimg://` handler on the default session. Call ONCE, after `app.whenReady()`
 * and before any window loads a page that references an icon (creating the window in the
 * same tick is fine — the handler is registered synchronously here).
 */
export function installImageCacheProtocol(protocol: ProtocolLike, opts: ImageCacheOptions): void {
  const dir = imageCacheDir(opts.userData)
  const doFetch = opts.fetchImpl ?? fetch
  const log = opts.log ?? ((m: string) => console.log(m))
  const onError = opts.onError ?? ((m: string, e: unknown) => console.error(m, e))

  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    onError('[everquest-companion:error] image cache: could not create cache dir', err)
  }

  // In-flight dedupe: five windows hovering the same item (or five boss cards pointing at one
  // portrait) at once must produce ONE request. Keyed by the extension-less cache stem — the
  // name isn't known until the bytes are sniffed — and cleared in a finally so a failure never
  // poisons the next attempt.
  const inFlight = new Map<string, Promise<Uint8Array | null>>()

  /** Fetch the upstream image once and write it atomically. Returns null on any failure —
   *  and writes NOTHING, so the next request retries (negatives are never cached). */
  async function fetchAndStore(req: EqImgRequest): Promise<Uint8Array | null> {
    // NOTE: for the `url` route this is the ALREADY-ALLOWLISTED, normalized URL. `parseEqImgUrl`
    // is the only producer of an EqImgRequest, so nothing unvalidated can reach this fetch.
    const url = upstreamUrlFor(req)
    let res: Response
    try {
      res = await doFetch(url, {
        headers: { 'User-Agent': UA, Accept: 'image/png,image/*;q=0.8,*/*;q=0.5' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
    } catch (err) {
      onError(`[everquest-companion:error] image cache: fetch failed for ${url}`, err)
      return null
    }
    if (!res.ok) {
      onError(`[everquest-companion:error] image cache: ${res.status} for ${url}`, res.statusText)
      return null
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    // A wiki error page / empty body must never become a permanent cache entry.
    const mime = sniffImageMime(bytes)
    if (mime == null) {
      onError(
        `[everquest-companion:error] image cache: ${url} returned ${bytes.length} bytes that are not an image; not caching`,
        null
      )
      return null
    }
    // The name is decided by the SNIFF, not by the URL's spelling (see cacheFileName).
    const name = cacheFileName(req, mime)
    const path = join(dir, name)
    // ATOMIC: write a unique temp file in the SAME directory, then rename over the target.
    // A concurrent writer (another app instance on the same channel — impossible today, but
    // free to be correct about) either wins or loses the rename; neither can produce a torn
    // file, and both bytes are identical anyway.
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    try {
      await writeFile(tmp, bytes)
      await rename(tmp, path)
    } catch (err) {
      onError(`[everquest-companion:error] image cache: could not store ${path}`, err)
      await unlink(tmp).catch(() => {})
      return bytes // still serve this request; we just didn't get to keep it
    }
    // FIRST FETCH ONLY. A steady-state launch prints none of these at all — which is exactly
    // the property "no image is ever downloaded twice" is asserted by.
    log(`[everquest-companion] Image cache: fetched ${name} (${bytes.length} bytes) <- ${url}`)
    return bytes
  }

  protocol.handle(EQIMG_SCHEME, async (request) => {
    const req = parseEqImgUrl(request.url)
    if (!req) return NOT_FOUND()

    // 1. Disk hit — the permanent path. No network, no log line (this is the steady state).
    //    `item` probes one name, `url` probes at most four (one per sniffable type).
    for (const path of cacheCandidatePaths(opts.userData, req)) {
      if (!existsSync(path)) continue
      try {
        const bytes = await readFile(path)
        const mime = sniffImageMime(bytes)
        if (mime) return imageResponse(bytes, mime)
        // A corrupt/truncated entry from some earlier build: drop it and fall through to a
        // fresh fetch rather than serving garbage forever.
        await unlink(path).catch(() => {})
      } catch (err) {
        onError(`[everquest-companion:error] image cache: could not read ${path}`, err)
      }
    }

    // 2. Miss — fetch once, dedupe concurrent askers.
    const key = cacheStem(req)
    let pending = inFlight.get(key)
    if (!pending) {
      pending = fetchAndStore(req).finally(() => inFlight.delete(key))
      inFlight.set(key, pending)
    }
    const bytes = await pending
    if (!bytes) return NOT_FOUND()
    return imageResponse(bytes, sniffImageMime(bytes) ?? 'image/png')
  })
}

/** A cached-forever image response. `immutable` tells Chromium's in-memory cache it never
 *  needs to re-ask us within a session either. */
function imageResponse(bytes: Uint8Array, mime: string): GlobalResponse {
  // Copy into a freshly-owned Uint8Array: `readFile` hands back a Buffer that can be a view
  // into Node's shared pool (and whose ArrayBufferLike doesn't satisfy BodyInit). Icons are
  // ~2 KB, so this is free, and the response body can't be invalidated under us.
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': mime,
      'cache-control': 'public, max-age=31536000, immutable'
    }
  })
}
