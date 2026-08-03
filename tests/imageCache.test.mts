// Permanent image cache (src/main/imageCache.ts) — the pure half.
//
// `parseEqImgUrl` is the ONLY thing that turns a renderer-supplied string into a filesystem
// path AND (on the `url` route) the only thing that decides what the app is allowed to
// FETCH, so it is the whole security boundary of this feature. A crafted `<img src>` must
// never be able to (a) name a file outside `<userData>/image-cache`, (b) name a file inside
// it that we didn't derive ourselves, or (c) make the app talk to a host that isn't on the
// allowlist. These tests pin that boundary, the path derivation on top of it, and the image
// sniff that decides whether bytes are allowed to become a PERMANENT cache entry (a wiki
// error page must not be cached forever).
//
// No Electron, no network, no fixtures — Electron is injected into the impure half
// (`installImageCacheProtocol` takes `protocol` + the userData dir), so this suite is as
// cheap and as unskippable as overlayLayout/storeMigrations.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  CACHE_EXTENSIONS,
  EQIMG_SCHEME,
  IMAGE_CACHE_DIR_NAME,
  IMAGE_URL_ALLOWLIST,
  cacheCandidateNames,
  cacheCandidatePaths,
  cacheFileName,
  cachePathFor,
  cacheStem,
  extForMime,
  imageCacheDir,
  normalizeUpstreamImageUrl,
  parseEqImgUrl,
  sniffImageMime,
  upstreamUrlFor,
  urlCacheHash,
  wikiItemIconUrl
} from '../src/main/imageCache'

const USER_DATA = join('C:', 'Users', 'someone', 'AppData', 'Roaming', 'everquest-companion')

/** A real boss portrait from bosses.json — the exact shape BossView now wraps. */
const BOSS = 'https://wiki.project1999.com/images/thumb/Npc_lord_nagafen.png/300px-Npc_lord_nagafen.png'

/** What `lib/imageUrl.ts cachedImageUrl` emits. Spelled out here (rather than imported from
 *  the renderer) so this suite proves the two halves agree on the wire format by CONTENT —
 *  a change to either side that forgets the other fails here. */
const wrap = (u: string): string => `eqimg://url/${encodeURIComponent(u)}`

test('parseEqImgUrl accepts exactly the shape the renderer emits', () => {
  assert.deepEqual(parseEqImgUrl('eqimg://item/1234'), { kind: 'item', id: '1234' })
  assert.deepEqual(parseEqImgUrl('eqimg://item/0'), { kind: 'item', id: '0' })
  // Chromium may normalize/append a trailing slash or a query on a `standard` scheme.
  assert.deepEqual(parseEqImgUrl('eqimg://item/1234/'), { kind: 'item', id: '1234' })
  assert.deepEqual(parseEqImgUrl('eqimg://item/1234?v=2'), { kind: 'item', id: '1234' })
  assert.deepEqual(parseEqImgUrl('eqimg://item/1234#x'), { kind: 'item', id: '1234' })
  // The scheme itself is case-insensitive per RFC 3986 / Chromium normalization.
  assert.deepEqual(parseEqImgUrl('EQIMG://ITEM/77'), { kind: 'item', id: '77' })
})

test('parseEqImgUrl rejects every traversal / escape shape', () => {
  const hostile = [
    'eqimg://item/../../secrets',
    'eqimg://item/..',
    'eqimg://item/./7',
    'eqimg://item/%2e%2e%2fsecrets',
    'eqimg://item/..%5Cwindows%5Csystem32',
    'eqimg://item/C:/Windows/System32/config/SAM',
    'eqimg://item//server/share/file',
    'eqimg://item/7/../8',
    'eqimg://item/7.png', // we derive the extension; callers never supply one
    'eqimg://item/7a',
    'eqimg://item/-7',
    'eqimg://item/7 8',
    'eqimg://item/', // no id
    'eqimg://item', // no id at all
    'eqimg://', // nothing
    'eqimg://spell/7', // unknown kind
    'eqimg://item/7/extra', // too many segments
    `eqimg://item/${'9'.repeat(64)}`, // absurd id, length-capped
    'https://eqlwiki.com/index.php?title=Special:Redirect/file/Item_7.png', // wrong scheme
    'file:///C:/Windows/System32/config/SAM',
    'eqimgx://item/7',
    ''
  ]
  for (const url of hostile) {
    assert.equal(parseEqImgUrl(url), null, `should reject: ${url}`)
  }
})

test('parseEqImgUrl is total over junk input', () => {
  // The handler feeds it whatever Chromium hands over; it must never throw.
  for (const junk of [undefined, null, 42, {}, [], Symbol('x')] as unknown[]) {
    assert.equal(parseEqImgUrl(junk as string), null)
  }
})

test('cache paths are derived from the validated id, inside the cache dir', () => {
  const req = parseEqImgUrl('eqimg://item/1234')!
  assert.equal(cacheFileName(req, 'image/png'), 'item-1234.png')
  assert.equal(imageCacheDir(USER_DATA), join(USER_DATA, IMAGE_CACHE_DIR_NAME))
  assert.equal(
    cachePathFor(USER_DATA, req, 'image/png'),
    join(USER_DATA, IMAGE_CACHE_DIR_NAME, 'item-1234.png')
  )
  // The item route's name is fully determined by the id — the sniff gates WHETHER we write,
  // not what we call it — so one `existsSync` resolves a read.
  assert.deepEqual(cacheCandidateNames(req), ['item-1234.png'])
  assert.equal(cacheFileName(req, 'image/jpeg'), 'item-1234.png')
  // Whatever the URL was, the resulting path is a direct child of the cache dir — the
  // property the traversal rejections above exist to guarantee.
  for (const url of ['eqimg://item/0', 'eqimg://item/999999999999']) {
    const r = parseEqImgUrl(url)!
    const p = cachePathFor(USER_DATA, r, 'image/png')
    assert.equal(p, join(imageCacheDir(USER_DATA), cacheFileName(r, 'image/png')))
    assert.ok(!cacheFileName(r, 'image/png').includes('..'))
    assert.ok(!/[\\/]/.test(cacheFileName(r, 'image/png')))
  }
})

test('the upstream URL is built from the id and nowhere else', () => {
  assert.equal(
    wikiItemIconUrl('1234'),
    'https://eqlwiki.com/index.php?title=Special:Redirect/file/Item_1234.png'
  )
  assert.equal(upstreamUrlFor(parseEqImgUrl('eqimg://item/1234')!), wikiItemIconUrl('1234'))
  assert.equal(EQIMG_SCHEME, 'eqimg')
})

// ── the `url` route (eqimg://url/<encodeURIComponent(absolute url)>) ────────────────────
//
// This route takes a renderer-supplied URL, so the allowlist IS the security boundary: it is
// the only thing standing between an `<img src>` and an outbound request to an arbitrary
// host. Everything below is about that one property.

test('the url route accepts exactly the wrapped boss portraits bosses.json holds', () => {
  const req = parseEqImgUrl(wrap(BOSS))
  assert.deepEqual(req, { kind: 'url', url: BOSS, hash: urlCacheHash(BOSS) })
  assert.equal(upstreamUrlFor(req!), BOSS)

  // Every host on the allowlist, plus the shapes real bosses.json entries actually take:
  // a percent-escape already IN the source URL (Npc_coercer_t%60vala.png) must round-trip
  // through encodeURIComponent → decodeURIComponent → new URL untouched, or the cache key
  // and the fetched URL would silently disagree with the wiki.
  const accepted = [
    'https://wiki.project1999.com/images/Npc_master_yael.png',
    'https://wiki.project1999.com/images/Npc_coercer_t%60vala.png',
    'https://wiki.project1999.com/images/Innoruuk.PNG',
    'https://wiki.project1999.com/images/Npc_dracoliche.jpg',
    'https://eqlwiki.com/index.php?title=Special:Redirect/file/Item_7.png'
  ]
  for (const u of accepted) {
    const r = parseEqImgUrl(wrap(u))
    assert.ok(r, `should accept: ${u}`)
    assert.equal(r!.kind === 'url' && r!.url, u, `should round-trip unchanged: ${u}`)
  }
})

test('the url route fetches ONLY allowlisted hosts — exact hostname, https, no credentials', () => {
  // Each of these must yield null: not a fetch to a different host, not a fetch at all.
  const hostile = [
    // wrong host outright
    'https://evil.com/x.png',
    'https://example.com/images/Npc_lord_nagafen.png',
    // LOOKALIKES — the reason the check is `===` and never includes/endsWith/startsWith
    'https://wiki.project1999.com.evil.com/x.png',
    'https://wiki.project1999.com.evil.com/wiki.project1999.com/x.png',
    'https://evil-wiki.project1999.com.br/x.png',
    'https://notwiki.project1999.com/x.png',
    'https://eqlwiki.com.evil.com/x.png',
    'https://evileqlwiki.com/x.png',
    'https://eqlwiki.co/x.png',
    // the allowlisted name appearing anywhere BUT the host
    'https://evil.com/wiki.project1999.com/x.png',
    'https://evil.com/?u=https://eqlwiki.com/x.png',
    'https://evil.com/x.png#wiki.project1999.com',
    // credentials — parses with hostname evil.com; rejected twice over
    'https://wiki.project1999.com@evil.com/x.png',
    'https://user:pass@wiki.project1999.com/x.png',
    'https://wiki.project1999.com:pass@evil.com/x.png',
    // non-default ports on an otherwise allowlisted host
    'https://wiki.project1999.com:8080/x.png',
    'https://wiki.project1999.com:8443/x.png',
    'https://eqlwiki.com:80/x.png',
    // wrong scheme — a downgrade the CSP can no longer see, or a local-read primitive
    'http://wiki.project1999.com/x.png',
    'ftp://wiki.project1999.com/x.png',
    'file:///C:/Windows/System32/config/SAM',
    'data:image/png;base64,iVBORw0KGgo=',
    'javascript:alert(1)',
    'eqimg://item/7',
    // not absolute at all
    '/images/x.png',
    '//wiki.project1999.com/x.png',
    'wiki.project1999.com/x.png',
    // trailing-dot FQDN: fails closed rather than being normalized into the allowlist
    'https://wiki.project1999.com./x.png',
    // IDN homoglyph (Cyrillic і) — new URL() punycodes it to xn--wki-jhd.project1999.com, so
    // it can never compare equal to the ASCII entry.
    'https://wіki.project1999.com/x.png',
    ''
  ]
  for (const u of hostile) {
    assert.equal(normalizeUpstreamImageUrl(u), null, `must not be fetchable: ${u}`)
    assert.equal(parseEqImgUrl(wrap(u)), null, `must not parse: ${u}`)
  }
  // …and the allowlist is exactly the two documented hosts (a silent third entry is the
  // failure this pins).
  assert.deepEqual([...IMAGE_URL_ALLOWLIST].sort(), ['eqlwiki.com', 'wiki.project1999.com'])
})

test('url normalization is canonical: default port folded, fragment dropped, query kept', () => {
  // An explicit :443 IS the default port — WHATWG strips it, so this is the same resource and
  // must land on the same cache entry, not a second permanent copy.
  assert.equal(normalizeUpstreamImageUrl('https://eqlwiki.com:443/a.png'), 'https://eqlwiki.com/a.png')
  // Host case is not significant; path case is.
  assert.equal(normalizeUpstreamImageUrl('https://EQLWIKI.COM/a.PNG'), 'https://eqlwiki.com/a.PNG')
  // The fragment never reaches the server, so keeping it would split one set of bytes across
  // two entries.
  assert.equal(normalizeUpstreamImageUrl('https://eqlwiki.com/a.png#frag'), 'https://eqlwiki.com/a.png')
  // The query IS part of what we ask for (the item route's own URL is query-only).
  assert.equal(
    normalizeUpstreamImageUrl('https://eqlwiki.com/index.php?title=X'),
    'https://eqlwiki.com/index.php?title=X'
  )
  // Same normalized URL ⇒ same cache identity, from any of its spellings.
  const stems = [
    'https://eqlwiki.com:443/a.png#one',
    'https://EQLwiki.com/a.png',
    'https://eqlwiki.com/a.png#two'
  ].map((u) => cacheStem(parseEqImgUrl(wrap(u))!))
  assert.equal(new Set(stems).size, 1, stems.join(' / '))
})

test('url cache paths are hash-derived, stable, and stay inside the cache dir', () => {
  const req = parseEqImgUrl(wrap(BOSS))!
  const hash = urlCacheHash(BOSS)

  // STABILITY: the hash is a pure function of the normalized URL — same input, same name,
  // across runs and processes. A drift here silently orphans every entry on every user's
  // disk and re-downloads the whole set.
  assert.equal(hash, urlCacheHash(BOSS))
  assert.equal(hash, urlCacheHash(normalizeUpstreamImageUrl(BOSS)!))
  assert.match(hash, /^[0-9a-f]{24}$/)
  assert.equal(cacheStem(req), `url-${hash}`)
  assert.notEqual(urlCacheHash(BOSS), urlCacheHash(BOSS.replace('300px', '200px')))

  // A FROZEN value (sha256 of a real bosses.json URL, first 24 hex). Unlike a log-derived
  // number this can never rot — it is a pure function of a constant string — and it is the
  // only thing that catches "the hash still looks fine but it isn't the same hash any more",
  // which would orphan every entry on every user's disk and re-download the whole set.
  assert.equal(
    urlCacheHash('https://wiki.project1999.com/images/Npc_master_yael.png'),
    '4fddb18e081439c8f015e708'
  )

  // NAMING: the extension states what the bytes sniffed as; the stem never does.
  assert.equal(cacheFileName(req, 'image/png'), `url-${hash}.png`)
  assert.equal(cacheFileName(req, 'image/jpeg'), `url-${hash}.jpg`)
  assert.equal(cacheFileName(req, 'image/gif'), `url-${hash}.gif`)
  assert.equal(cacheFileName(req, 'image/webp'), `url-${hash}.webp`)
  // …and a read probes exactly those four, in a fixed order — a bounded constant, never a
  // directory scan, so lookup stays O(1).
  assert.deepEqual(cacheCandidateNames(req), CACHE_EXTENSIONS.map((e) => `url-${hash}.${e}`))
  assert.equal(cacheCandidateNames(req).length, 4)
  // Every name the sniffer can produce is one the reader probes (the invariant that keeps a
  // written entry findable).
  for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    assert.ok(cacheCandidateNames(req).includes(cacheFileName(req, mime)), mime)
    assert.equal(extForMime(mime), cacheFileName(req, mime).split('.').pop())
  }

  // CONTAINMENT: every candidate path is a direct child of the cache dir, for every accepted
  // URL — no traversal, no separators, whatever the URL contained.
  for (const u of [BOSS, 'https://eqlwiki.com/a/b/c/../../x.png', 'https://eqlwiki.com/%2e%2e%2fx.png']) {
    const r = parseEqImgUrl(wrap(u))
    if (!r) continue
    for (const p of cacheCandidatePaths(USER_DATA, r)) {
      assert.equal(p, join(imageCacheDir(USER_DATA), p.split(/[\\/]/).pop()!))
      assert.ok(p.startsWith(join(USER_DATA, IMAGE_CACHE_DIR_NAME)))
    }
    for (const n of cacheCandidateNames(r)) {
      assert.match(n, /^url-[0-9a-f]{24}\.(png|jpg|gif|webp)$/)
    }
  }
})

test('the url route decodes totally — junk in the segment is a 404, never a throw', () => {
  // decodeURIComponent throws URIError on these; the handler feeds it whatever Chromium
  // hands over, so parse must absorb every one of them.
  const junk = [
    'eqimg://url/%',
    'eqimg://url/%2',
    'eqimg://url/%ZZ',
    'eqimg://url/%E0%A4%A',
    'eqimg://url/%C3%28',
    'eqimg://url/%ED%A0%80', // lone surrogate
    'eqimg://url/not-a-url',
    'eqimg://url/https%3A%2F%2F', // decodes fine, then fails new URL()
    'eqimg://url/', // no payload
    'eqimg://url', // no payload at all
    'eqimg://url/https%3A%2F%2Feqlwiki.com%2Fa.png/extra', // too many segments
    `eqimg://url/${'%41'.repeat(2000)}`, // absurd payload, length-capped before decoding
    `eqimg://url/${encodeURIComponent(`https://eqlwiki.com/${'a'.repeat(1000)}.png`)}` // long URL
  ]
  for (const u of junk) {
    assert.doesNotThrow(() => parseEqImgUrl(u), u)
    assert.equal(parseEqImgUrl(u), null, `should reject: ${u}`)
  }
  // …and normalizeUpstreamImageUrl is total over non-strings too (it is exported, so it will
  // eventually be called by something that hasn't checked).
  for (const j of [undefined, null, 42, {}, [], Symbol('x')] as unknown[]) {
    assert.equal(normalizeUpstreamImageUrl(j as string), null)
  }
})

test('the two routes cannot collide on disk', () => {
  // `item-` and `url-` prefixes plus fixed-shape payloads (digits / hex) mean no item id can
  // ever name a url entry's file, or vice versa.
  const item = cacheStem(parseEqImgUrl('eqimg://item/1234')!)
  const url = cacheStem(parseEqImgUrl(wrap(BOSS))!)
  assert.ok(item.startsWith('item-') && url.startsWith('url-'))
  assert.notEqual(item, url)
})

test('sniffImageMime gates what may become a permanent cache entry', () => {
  const pad = (head: number[]): Uint8Array => {
    const b = new Uint8Array(16)
    b.set(head)
    return b
  }
  assert.equal(sniffImageMime(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
  assert.equal(sniffImageMime(pad([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffImageMime(pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif')
  const webp = pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  assert.equal(sniffImageMime(webp), 'image/webp')

  // The failures that MUST NOT be cached forever: an HTML error page, an empty body, a
  // truncated download too short to identify.
  assert.equal(sniffImageMime(new TextEncoder().encode('<!DOCTYPE html><html>404')), null)
  assert.equal(sniffImageMime(new Uint8Array(0)), null)
  assert.equal(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e])), null)
})
