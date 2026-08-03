// packRegistry.ts — in-app openpeon.com sound-pack registry (Task #29).
//
// Three jobs:
//   1. fetchRegistry() — GET the registry index.json, reconcile against installed
//      packs, cache it (24h in-memory + on-disk in userData), tolerate offline by
//      falling back to the cache (or an empty list) with an `error` field set.
//   2. installPack(name, onProgress) — download the pack's GitHub release tarball
//      (Node https, following redirects), gunzip it (zlib), extract with a minimal
//      hand-rolled tar reader, write only the `{source_path}/` subtree into
//      <userData>/soundpacks/<name>/, and convert the CESP openpeon.json into our
//      manifest.json (keeping openpeon.json alongside). Rejects path traversal.
//   3. uninstallPack(name) — remove the userData pack dir (bundled packs, which
//      live under resources/, are never in the registry and can't be uninstalled).
//
// A pack is "installed" if listPacks() already surfaces its id (name === id).

import { get as httpsGet } from 'node:https'
import { gunzipSync } from 'node:zlib'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { app } from 'electron'
import { logError } from './errorLog'
import {
  cespToManifestSounds,
  deriveSoundId,
  listPacks,
  userPacksRoot,
  type CespManifest
} from './sounds'
import type {
  PackInstallProgress,
  PackPreviewList,
  PackPreviewSound,
  RegistryListResult,
  RegistryPack,
  RegistryPackView,
  SoundData,
  SoundPackManifest
} from '../shared/types'

const REGISTRY_URL = 'https://peonping.github.io/registry/index.json'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h
const MAX_REDIRECTS = 5
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024 // 100MB sanity cap
const PREVIEW_CACHE_MAX = 20 // LRU cap for previewed audio bytes
const AUDIO_MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg'
}

interface RegistryIndex {
  version?: number
  packs: RegistryPack[]
}

// ---- in-memory + on-disk cache ------------------------------------------------

let memCache: { at: number; packs: RegistryPack[] } | null = null

function cacheFile(): string {
  return join(app.getPath('userData'), 'registry-cache.json')
}

function readDiskCache(): { at: number; packs: RegistryPack[] } | null {
  try {
    const raw = readFileSync(cacheFile(), 'utf8')
    const parsed = JSON.parse(raw) as { at: number; packs: RegistryPack[] }
    if (parsed && Array.isArray(parsed.packs)) return parsed
  } catch {
    // no/invalid cache
  }
  return null
}

function writeDiskCache(packs: RegistryPack[]): void {
  try {
    writeFileSync(cacheFile(), JSON.stringify({ at: Date.now(), packs }), 'utf8')
  } catch (err) {
    logError('main:packRegistry', { message: 'failed writing registry cache', err })
  }
}

// ---- HTTPS helpers (follow redirects) -----------------------------------------

/** GET a URL and buffer the whole body. Follows up to MAX_REDIRECTS redirects. */
function httpGetBuffer(
  url: string,
  onProgress?: (received: number, total: number | null) => void,
  redirects = 0
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const req = httpsGet(url, { headers: { 'User-Agent': 'everquest-companion' } }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume() // drain
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error(`too many redirects (${url})`))
          return
        }
        const next = new URL(res.headers.location, url).toString()
        httpGetBuffer(next, onProgress, redirects + 1).then(resolvePromise, reject)
        return
      }
      if (status < 200 || status >= 300) {
        res.resume()
        reject(new Error(`GET ${url} → ${status}`))
        return
      }
      const totalHeader = res.headers['content-length']
      const total = totalHeader ? Number(totalHeader) : null
      const chunks: Buffer[] = []
      let received = 0
      res.on('data', (c: Buffer) => {
        received += c.length
        if (received > MAX_DOWNLOAD_BYTES) {
          req.destroy()
          reject(new Error('download exceeded size cap'))
          return
        }
        chunks.push(c)
        onProgress?.(received, total)
      })
      res.on('end', () => resolvePromise(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

// ---- minimal tar reader -------------------------------------------------------

interface TarEntry {
  name: string
  type: string // '0'/'\0' = file, '5' = dir, 'x'/'g'/'L' = pax/longname (skipped)
  size: number
  data: Buffer
}

/** Parse an octal numeric tar header field (space/NUL terminated). */
function parseOctal(buf: Buffer, offset: number, length: number): number {
  const s = buf.toString('ascii', offset, offset + length).replace(/[\0 ]+$/, '').trim()
  if (!s) return 0
  const n = parseInt(s, 8)
  return Number.isFinite(n) ? n : 0
}

/**
 * Read a (already-gunzipped) tar archive into file entries. 512-byte headers;
 * name (0..100) + optional prefix (345..500) joined; size at 124; typeflag at 156.
 * pax/global/GNU-longname entries ('x','g','L','K') are skipped defensively (their
 * data block is consumed but not interpreted) — we don't need long names for these
 * packs. Two consecutive zero blocks end the archive.
 */
function readTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = []
  let off = 0
  let zeroBlocks = 0
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    // End-of-archive: a full zero block.
    if (header.every((b) => b === 0)) {
      zeroBlocks++
      off += 512
      if (zeroBlocks >= 2) break
      continue
    }
    zeroBlocks = 0

    const name = header.toString('ascii', 0, 100).replace(/\0.*$/, '')
    const prefix = header.toString('ascii', 345, 500).replace(/\0.*$/, '')
    const fullName = prefix ? `${prefix}/${name}` : name
    const size = parseOctal(header, 124, 12)
    const type = String.fromCharCode(header[156] || 0x30) // '0' default
    off += 512

    const dataStart = off
    const padded = Math.ceil(size / 512) * 512
    off += padded

    // Skip pax extended headers / GNU long-name entries defensively.
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') continue
    // Only regular files ('0' or NUL) carry usable content; skip dirs/links.
    if (type !== '0' && type !== '\0') continue

    out.push({
      name: fullName,
      type,
      size,
      data: buf.subarray(dataStart, dataStart + size)
    })
  }
  return out
}

// ---- registry fetch -----------------------------------------------------------

/**
 * Fetch the registry index (24h cached, offline-tolerant). Always returns a list;
 * on failure it serves the cache (or empty) and sets `error`. Each pack is
 * annotated with `installed` by reconciling against listPacks().
 */
export async function fetchRegistry(force = false): Promise<RegistryListResult> {
  const now = Date.now()
  if (!memCache) memCache = readDiskCache()

  const fresh = memCache && now - memCache.at < CACHE_TTL_MS
  if (!force && fresh && memCache) {
    return { packs: annotate(memCache.packs), fromCache: true }
  }

  try {
    const body = await httpGetBuffer(REGISTRY_URL)
    const index = JSON.parse(body.toString('utf8')) as RegistryIndex
    const packs = Array.isArray(index.packs) ? index.packs : []
    memCache = { at: now, packs }
    writeDiskCache(packs)
    return { packs: annotate(packs) }
  } catch (err) {
    logError('main:packRegistry', { message: 'registry fetch failed', err })
    const cached = memCache?.packs ?? readDiskCache()?.packs ?? []
    return {
      packs: annotate(cached),
      fromCache: cached.length > 0,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** Set of installed pack ids (bundled + user), used to reconcile the registry. */
function installedIds(): Set<string> {
  return new Set(listPacks().map((p) => p.id))
}

function annotate(packs: RegistryPack[]): RegistryPackView[] {
  const installed = installedIds()
  return packs.map((p) => ({ ...p, installed: installed.has(p.name) }))
}

// ---- preview (list sounds + stream one file, no install) ----------------------
//
// Both read the pack straight off GitHub raw at the release tag. The raw form
// `https://raw.githubusercontent.com/{repo}/{ref}/{path}` works for TAG refs (verified
// against a real pack), so we use it directly rather than the `refs/tags/{ref}` form.
// The manifest listing is cached per pack for the session; previewed audio bytes use
// a small LRU (previews are one-off and can be large-ish).

/** raw.githubusercontent base for a pack's release tree (no trailing slash). */
function rawBase(pack: RegistryPack): string {
  const sub = pack.source_path && pack.source_path !== '.' ? pack.source_path.replace(/\\/g, '/').replace(/^\/|\/$/g, '') : ''
  const root = `https://raw.githubusercontent.com/${pack.source_repo}/${pack.source_ref}`
  return sub ? `${root}/${sub}` : root
}

// Manifest listings cached per pack for the whole session (packs are immutable at a tag).
const previewListCache = new Map<string, PackPreviewSound[]>()
// Previewed audio bytes as a small LRU (Map preserves insertion order → evict oldest).
const previewSoundCache = new Map<string, SoundData>()

function lruGet(cacheKey: string): SoundData | undefined {
  const hit = previewSoundCache.get(cacheKey)
  if (hit) {
    previewSoundCache.delete(cacheKey)
    previewSoundCache.set(cacheKey, hit) // bump to most-recent
  }
  return hit
}

function lruSet(cacheKey: string, data: SoundData): void {
  previewSoundCache.set(cacheKey, data)
  while (previewSoundCache.size > PREVIEW_CACHE_MAX) {
    const oldest = previewSoundCache.keys().next().value
    if (oldest === undefined) break
    previewSoundCache.delete(oldest)
  }
}

/**
 * List a registry pack's sounds WITHOUT installing it: fetch its CESP openpeon.json
 * off GitHub raw at the release tag, run the same CESP→manifest conversion the
 * installer uses (so soundIds + labels match a real install), and return the file
 * path for each (relative to the raw base, e.g. "sounds/foo.mp3"). Cached per pack.
 */
export async function fetchPackSounds(pack: RegistryPack): Promise<PackPreviewList> {
  const cached = previewListCache.get(pack.name)
  if (cached) return { sounds: cached }
  try {
    const body = await httpGetBuffer(`${rawBase(pack)}/openpeon.json`)
    const cesp = JSON.parse(body.toString('utf8')) as CespManifest
    // Run the SAME CESP→manifest conversion the installer uses so soundIds + labels
    // match a real install exactly. As each soundId is derived, capture its ORIGINAL
    // CESP file path (which may already carry a `sounds/` prefix, e.g.
    // "sounds/foo.mp3") — that's the path to fetch relative to the raw base. The
    // converted manifest stores file as `sounds/<basename>`, so we keep the source
    // path separately here.
    const taken = new Set<string>()
    const idToFile = new Map<string, string>()
    const manifestSounds = cespToManifestSounds(cesp, (category, file) => {
      const id = deriveSoundId(category, file, taken)
      idToFile.set(id, file)
      return id
    })
    const sounds: PackPreviewSound[] = Object.entries(manifestSounds).map(([soundId, s]) => ({
      soundId,
      label: s.label,
      file: idToFile.get(soundId) ?? s.file
    }))
    previewListCache.set(pack.name, sounds)
    return { sounds }
  } catch (err) {
    logError('main:packRegistry', { message: `preview list for '${pack.name}' failed`, err })
    return { sounds: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Fetch a single preview audio file's bytes off GitHub raw (same base URL + the
 * manifest's file path). Returns { mime, dataBase64 } like getSoundData so the
 * renderer builds a Blob URL. LRU-cached. `file` is validated against the pack's
 * preview listing to prevent fetching arbitrary repo paths.
 */
export async function fetchPreviewSound(pack: RegistryPack, file: string): Promise<SoundData | null> {
  const listing = await fetchPackSounds(pack)
  if (!listing.sounds.some((s) => s.file === file)) return null

  const cacheKey = `${pack.name}::${file}`
  const cached = lruGet(cacheKey)
  if (cached) return cached

  const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
  const mime = AUDIO_MIME[ext]
  if (!mime) return null

  // Path is one of the manifest's own file entries; still normalize + strip any
  // traversal defensively before joining onto the raw base.
  const safeRel = file.replace(/\\/g, '/').replace(/^\/+/, '')
  if (safeRel.split('/').includes('..')) return null
  try {
    const buf = await httpGetBuffer(`${rawBase(pack)}/${safeRel}`)
    const data: SoundData = { mime, dataBase64: buf.toString('base64') }
    lruSet(cacheKey, data)
    return data
  } catch (err) {
    logError('main:packRegistry', { message: `preview sound '${file}' for '${pack.name}' failed`, err })
    return null
  }
}

/** Resolve a registry pack by name (from the cached/live index). Null if unknown. */
export async function findRegistryPack(name: string): Promise<RegistryPack | null> {
  const reg = await fetchRegistry(false)
  return reg.packs.find((p) => p.name === name) ?? null
}

// ---- install / uninstall ------------------------------------------------------

/** Reject archive entries that would escape the target dir once written. */
function safeJoin(targetRoot: string, relPath: string): string | null {
  const dest = resolve(targetRoot, relPath)
  const rootWithSep = targetRoot.endsWith(sep) ? targetRoot : targetRoot + sep
  if (dest !== targetRoot && !dest.startsWith(rootWithSep)) return null
  return dest
}

/**
 * Install a registry pack end-to-end. Streams progress via `onProgress`. Throws on
 * failure (the IPC layer converts that into a `packs:progress` error + a failed
 * result). `targetRootOverride` lets the validation harness install into a temp dir.
 */
export async function installPack(
  pack: RegistryPack,
  onProgress: (p: PackInstallProgress) => void,
  targetRootOverride?: string
): Promise<void> {
  const name = pack.name
  const packsRoot = targetRootOverride ?? userPacksRoot()
  const packDir = join(packsRoot, name)

  // 1. Download the release tarball.
  onProgress({ name, phase: 'downloading', percent: 0 })
  const tarUrl = `https://github.com/${pack.source_repo}/archive/refs/tags/${pack.source_ref}.tar.gz`
  const gz = await httpGetBuffer(tarUrl, (received, total) => {
    if (total) onProgress({ name, phase: 'downloading', percent: Math.round((received / total) * 100) })
  })

  // 2. Gunzip + tar-extract in memory.
  onProgress({ name, phase: 'extracting' })
  const tarBuf = gunzipSync(gz)
  const entries = readTar(tarBuf)
  if (entries.length === 0) throw new Error('archive contained no files')

  // The archive wraps everything in a single top-level dir (e.g. repo-1.0.1/).
  // Detect it, then the pack root = <topDir>/<source_path>.
  const topDir = entries[0].name.split('/')[0]
  const rawSubPath = pack.source_path && pack.source_path !== '.' ? pack.source_path : ''
  const rootPrefix = rawSubPath ? `${topDir}/${rawSubPath.replace(/\\/g, '/').replace(/\/$/, '')}/` : `${topDir}/`

  // Stage into a fresh dir (write to a temp sibling, then swap) so a mid-install
  // failure never leaves a half-written pack shadowing a good one.
  const stageDir = `${packDir}.installing`
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(join(stageDir, 'sounds'), { recursive: true })

  let cespRaw: string | null = null
  let wrote = 0
  for (const entry of entries) {
    if (!entry.name.startsWith(rootPrefix)) continue
    const rel = entry.name.slice(rootPrefix.length)
    if (!rel || rel.endsWith('/')) continue

    const dest = safeJoin(stageDir, rel)
    if (!dest) {
      rmSync(stageDir, { recursive: true, force: true })
      throw new Error(`unsafe archive path: ${entry.name}`)
    }

    const base = rel.split('/').pop() ?? rel
    if (rel === 'openpeon.json') {
      cespRaw = entry.data.toString('utf8')
      // keep the original alongside for provenance
      writeFileSync(dest, entry.data)
      continue
    }
    // Only keep audio files, flattened under sounds/ (matches our manifest paths).
    if (/\.(wav|mp3|ogg)$/i.test(base)) {
      writeFileSync(join(stageDir, 'sounds', base), entry.data)
      wrote++
    }
  }

  if (!cespRaw) {
    rmSync(stageDir, { recursive: true, force: true })
    throw new Error('pack has no openpeon.json')
  }
  if (wrote === 0) {
    rmSync(stageDir, { recursive: true, force: true })
    throw new Error('pack contained no audio files')
  }

  // 3. Convert CESP → our manifest.
  onProgress({ name, phase: 'converting' })
  let cesp: CespManifest
  try {
    cesp = JSON.parse(cespRaw) as CespManifest
  } catch {
    rmSync(stageDir, { recursive: true, force: true })
    throw new Error('openpeon.json is not valid JSON')
  }

  const taken = new Set<string>()
  const sounds = cespToManifestSounds(cesp, (category, file) => deriveSoundId(category, file, taken))
  if (Object.keys(sounds).length === 0) {
    rmSync(stageDir, { recursive: true, force: true })
    throw new Error('no sounds after conversion')
  }

  const manifest: SoundPackManifest & { source?: { repo: string; ref: string } } = {
    id: name,
    name: pack.display_name || cesp.display_name || name,
    sounds,
    license: cesp.license ?? pack.license ?? 'see source repo',
    source: { repo: pack.source_repo, ref: pack.source_ref }
  }
  writeFileSync(join(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  // 4. Atomically swap the staged dir into place.
  if (existsSync(packDir)) rmSync(packDir, { recursive: true, force: true })
  // rename can fail across-device; both are under packsRoot so a plain rename is safe.
  const { renameSync } = await import('node:fs')
  renameSync(stageDir, packDir)

  onProgress({ name, phase: 'done' })
}

/**
 * Uninstall a user-installed pack (remove its <userData>/soundpacks/<name>/ dir).
 * Bundled packs live under resources/ and are not reachable here, so they're never
 * uninstallable. Returns false if the pack dir doesn't exist under userData.
 */
export function uninstallPack(name: string): boolean {
  const packDir = join(userPacksRoot(), name)
  // Guard against traversal via a crafted name.
  const safe = safeJoin(userPacksRoot(), name)
  if (!safe || safe !== packDir) return false
  if (!existsSync(packDir)) return false
  try {
    rmSync(packDir, { recursive: true, force: true })
    return true
  } catch (err) {
    logError('main:packRegistry', { message: `failed removing pack ${name}`, err })
    return false
  }
}
