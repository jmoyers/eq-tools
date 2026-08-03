// Electron runtime trust boundary (src/main/security.ts) — the pure half.
//
// These three functions are the only things standing between attacker-shaped text and three
// powerful sinks: `shell.openExternal` (the OS opens it — a `file:` URL EXECUTES), a window
// navigation (whatever loads inherits this app's preload bridge and its whole IPC surface),
// and a `join()` onto the soundpack roots. The text that reaches the first two is built from
// WIKI PAGE TITLES (shared/wiki.ts, fed by itemLookup's scraped `page` field), so "the only
// producer today spells it https://eqlwiki.com/…" is a convention, not a boundary — these
// tests are the boundary.
//
// No Electron, no network, no fixtures (the imageCache.test.mts precedent), so this suite
// never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  EXTERNAL_LINK_ALLOWLIST,
  allowedExternalUrl,
  isInsideDir,
  isInternalPageUrl,
  isSafePackId
} from '../src/main/security'

const WIN = process.platform === 'win32'

// ---- allowedExternalUrl: what the OS may be asked to open -----------------------------

test('allowedExternalUrl accepts exactly the links the app produces today', () => {
  // shared/wiki.ts wikiPageUrl output, in both of its shapes.
  assert.equal(
    allowedExternalUrl('https://eqlwiki.com/Rod_of_Insidious_Glamour'),
    'https://eqlwiki.com/Rod_of_Insidious_Glamour'
  )
  assert.equal(
    allowedExternalUrl('https://eqlwiki.com/Enchanter_Plane_of_Sky_Tests'),
    'https://eqlwiki.com/Enchanter_Plane_of_Sky_Tests'
  )
  // Query + fragment survive (a wiki section link is legitimate).
  assert.equal(
    allowedExternalUrl('https://eqlwiki.com/Plane_of_Sky?action=raw#Quests'),
    'https://eqlwiki.com/Plane_of_Sky?action=raw#Quests'
  )
  // Every allowlisted host, exactly as listed.
  for (const host of EXTERNAL_LINK_ALLOWLIST) {
    assert.equal(allowedExternalUrl(`https://${host}/x`), `https://${host}/x`)
  }
  // An explicit :443 is redundant — WHATWG strips it, so this is the default port, not a
  // different service.
  assert.equal(allowedExternalUrl('https://eqlwiki.com:443/x'), 'https://eqlwiki.com/x')
})

test('allowedExternalUrl refuses every scheme but https — the RCE-adjacent shapes', () => {
  // `shell.openExternal('file:///…exe')` RUNS it. This is the one that matters most.
  assert.equal(allowedExternalUrl('file:///C:/Windows/System32/calc.exe'), null)
  assert.equal(allowedExternalUrl('file://attacker.example/share/payload.lnk'), null)
  // Registered protocol handlers reach arbitrary local software.
  assert.equal(allowedExternalUrl('ms-msdt:/id PCWDiagnostic'), null)
  assert.equal(allowedExternalUrl('search-ms:query=x&crumb=location:\\\\attacker\\share'), null)
  assert.equal(allowedExternalUrl('mailto:someone@example.com'), null)
  assert.equal(allowedExternalUrl('javascript:alert(1)'), null)
  assert.equal(allowedExternalUrl('data:text/html,<script>alert(1)</script>'), null)
  assert.equal(allowedExternalUrl('vbscript:msgbox(1)'), null)
  // Plain http is a downgrade, even on an allowlisted host.
  assert.equal(allowedExternalUrl('http://eqlwiki.com/x'), null)
  // Our own scheme is for <img src>, never for the OS.
  assert.equal(allowedExternalUrl('eqimg://item/1234'), null)
})

test('allowedExternalUrl matches the host EXACTLY (no endsWith/includes hole)', () => {
  assert.equal(allowedExternalUrl('https://eqlwiki.com.evil.com/x'), null)
  assert.equal(allowedExternalUrl('https://evil-eqlwiki.com/x'), null)
  assert.equal(allowedExternalUrl('https://evil.com/?u=https://eqlwiki.com/x'), null)
  assert.equal(allowedExternalUrl('https://evil.com/#https://eqlwiki.com/x'), null)
  assert.equal(allowedExternalUrl('https://sub.eqlwiki.com/x'), null)
  // Credentials: this parses with hostname `evil.com` — and we refuse userinfo outright.
  assert.equal(allowedExternalUrl('https://eqlwiki.com@evil.com/x'), null)
  assert.equal(allowedExternalUrl('https://user:pw@eqlwiki.com/x'), null)
  // A non-default port on an allowlisted host is a different service.
  assert.equal(allowedExternalUrl('https://eqlwiki.com:8443/x'), null)
  // Case + trailing-dot spellings must not sneak past the Set lookup (WHATWG lowercases the
  // host but keeps a trailing dot, which is a DIFFERENT hostname).
  assert.equal(allowedExternalUrl('https://EQLWIKI.COM/x'), 'https://eqlwiki.com/x')
  assert.equal(allowedExternalUrl('https://eqlwiki.com./x'), null)
})

test('allowedExternalUrl is total over garbage input', () => {
  assert.equal(allowedExternalUrl(undefined), null)
  assert.equal(allowedExternalUrl(null), null)
  assert.equal(allowedExternalUrl(42), null)
  assert.equal(allowedExternalUrl({ url: 'https://eqlwiki.com/' }), null)
  assert.equal(allowedExternalUrl(''), null)
  assert.equal(allowedExternalUrl('not a url'), null)
  assert.equal(allowedExternalUrl('/relative/path'), null)
  assert.equal(allowedExternalUrl('//eqlwiki.com/x'), null) // protocol-relative: no scheme
  assert.equal(allowedExternalUrl(`https://eqlwiki.com/${'a'.repeat(4000)}`), null)
})

// ---- isInternalPageUrl: where a window may navigate -----------------------------------

const RENDERER_DIR = WIN ? join('C:', 'app', 'out', 'renderer') : '/app/out/renderer'
/** `file://` form of a path inside RENDERER_DIR, the way Electron spells loadFile()'s result. */
const fileUrl = (rel: string): string =>
  WIN ? `file:///C:/app/out/renderer/${rel}` : `file:///app/out/renderer/${rel}`

test('isInternalPageUrl allows the bundled pages (packaged: no dev server)', () => {
  const o = { rendererDir: RENDERER_DIR }
  assert.equal(isInternalPageUrl(fileUrl('index.html'), o), true)
  assert.equal(isInternalPageUrl(fileUrl('overlay.html'), o), true)
  // loadFile(..., {search}) — the overlay's ?kind= is part of the real URL.
  assert.equal(isInternalPageUrl(fileUrl('overlay.html?kind=heal-fight'), o), true)
  assert.equal(isInternalPageUrl(fileUrl('assets/index-abc123.js'), o), true)
})

test('isInternalPageUrl allows the dev server ORIGIN, and nothing that merely looks like it', () => {
  // The port is whatever electron-vite took (5173, or 5174 when it was busy) — which is why
  // the caller passes the server's own URL instead of a hardcoded port.
  for (const dev of ['http://localhost:5173', 'http://localhost:5174']) {
    const o = { devServerUrl: dev, rendererDir: RENDERER_DIR }
    assert.equal(isInternalPageUrl(`${dev}/`, o), true)
    assert.equal(isInternalPageUrl(`${dev}/index.html`, o), true)
    assert.equal(isInternalPageUrl(`${dev}/overlay.html?kind=fight`, o), true)
    // HMR full reloads and the did-fail-load retry both go back to this origin.
    assert.equal(isInternalPageUrl(`${dev}/src/main.tsx`, o), true)
    // …but a different port is a different origin, and so is a lookalike host.
    assert.equal(isInternalPageUrl('http://localhost:9999/', o), false)
    assert.equal(isInternalPageUrl('http://localhost.evil.com:5173/', o), false)
    assert.equal(isInternalPageUrl('https://localhost:5173/', o), false)
  }
  // In a packaged app there is no dev server, so an http page is never internal.
  assert.equal(isInternalPageUrl('http://localhost:5173/', { rendererDir: RENDERER_DIR }), false)
})

test('isInternalPageUrl denies everything outside the bundle', () => {
  const o = { devServerUrl: 'http://localhost:5173', rendererDir: RENDERER_DIR }
  // The whole point: a wiki link must not navigate the app window.
  assert.equal(isInternalPageUrl('https://eqlwiki.com/Plane_of_Sky', o), false)
  assert.equal(isInternalPageUrl('javascript:alert(1)', o), false)
  assert.equal(isInternalPageUrl('data:text/html,<script>alert(1)</script>', o), false)
  assert.equal(isInternalPageUrl('about:blank', o), false)
  assert.equal(isInternalPageUrl('eqimg://item/1234', o), false)
  // Other local files, including the user's own log and the store.
  assert.equal(isInternalPageUrl(WIN ? 'file:///C:/Windows/win.ini' : 'file:///etc/passwd', o), false)
  // Traversal out of the bundle dir, raw and percent-encoded.
  assert.equal(isInternalPageUrl(fileUrl('../../../Windows/win.ini'), o), false)
  assert.equal(isInternalPageUrl(fileUrl('..%2f..%2fsecret.txt'), o), false)
  // A sibling directory that merely starts with the same characters.
  assert.equal(
    isInternalPageUrl(WIN ? 'file:///C:/app/out/rendererEVIL/x.html' : 'file:///app/out/rendererEVIL/x.html', o),
    false
  )
  // UNC: a remote path must never read as "inside" a local directory.
  assert.equal(isInternalPageUrl('file://attacker.example/app/out/renderer/index.html', o), false)
  // Total over garbage.
  assert.equal(isInternalPageUrl(undefined, o), false)
  assert.equal(isInternalPageUrl('', o), false)
  assert.equal(isInternalPageUrl(123, o), false)
})

test('isInsideDir is segment-aware, traversal-aware, and platform-correct', () => {
  const dir = WIN ? join('C:', 'app', 'out', 'renderer') : '/app/out/renderer'
  assert.equal(isInsideDir(join(dir, 'index.html'), dir), true)
  assert.equal(isInsideDir(dir, dir), true)
  assert.equal(isInsideDir(join(dir, 'assets', 'x.js'), dir), true)
  assert.equal(isInsideDir(`${dir}EVIL`, dir), false)
  assert.equal(isInsideDir(join(dir, '..', 'main', 'index.js'), dir), false)
  assert.equal(isInsideDir('', dir), false)
  assert.equal(isInsideDir(join(dir, 'x'), ''), false)
  // A trailing separator on the dir must not change the answer.
  assert.equal(isInsideDir(join(dir, 'index.html'), `${dir}${WIN ? '\\' : '/'}`), true)
  if (WIN) {
    // Windows paths are case-insensitive; drive letters and separators vary by producer.
    assert.equal(isInsideDir('c:\\app\\out\\renderer\\index.html', dir), true)
    assert.equal(isInsideDir('C:/app/out/renderer/index.html', dir), true)
  }
})

// ---- isSafePackId: what may be join()ed onto the soundpack roots ----------------------

test('isSafePackId accepts real pack ids and rejects anything path-shaped', () => {
  // The ids actually in play (shipped default + registry packs).
  for (const ok of ['alan-rickman', 'sc_marine', 'peon', 'pack.v2', 'A1']) {
    assert.equal(isSafePackId(ok), true, ok)
  }
  for (const bad of [
    '..',
    '.',
    '.hidden',
    '../../../Users/jmoye/Documents',
    '..\\..\\Windows',
    'a/b',
    'a\\b',
    'C:\\Windows',
    '/etc',
    'pack:stream', // NTFS alternate data stream
    '\\\\server\\share', // UNC
    'pack\0.wav',
    '',
    'x'.repeat(129)
  ]) {
    assert.equal(isSafePackId(bad), false, JSON.stringify(bad))
  }
  assert.equal(isSafePackId(undefined), false)
  assert.equal(isSafePackId(null), false)
  assert.equal(isSafePackId(7), false)
})
