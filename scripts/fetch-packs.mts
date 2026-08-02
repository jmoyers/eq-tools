// fetch-packs.mts — download the shipped voice pack(s) (src/main/data/defaultPacks.ts)
// into resources/soundpacks/, converting the source CESP `openpeon.json` into OUR
// manifest.json shape. Run:
//
//   export PATH="/c/Program Files/nodejs:$PATH"   # this machine
//   npm run fetch:packs
//
// WHY THIS EXISTS: the pack audio is gitignored (it stays out of the repo), so a fresh
// clone runs this to restore it before `npm run dist`. The app ALSO self-provisions the
// same pack at runtime (src/main/provisionPacks.ts) for installs that ship without it —
// this script is the dev/source-build path. Idempotent: re-running re-downloads only
// missing/short files and rewrites the manifest, so deleting a file and re-running
// restores it.
//
// SHAPE MAPPING: the source groups sounds by CESP category (session.start,
// task.acknowledge, …). Our manifest flattens them to stable soundId keys with a human
// label prefixed by the category ("Complete · It is done."). Ids come from the SHARED
// deriveSoundId — the same function the in-app registry installer and the runtime
// self-provisioner use — and the pack is pinned to a release TAG, so every path produces
// byte-identical ids (the seeded alerts reference them; see defaultPacks.ts).
//
// ETIQUETTE (AGENTS.md LAW): sequential, delayed between requests, retried with
// exponential backoff, and cache-skipping (a present non-empty file is never re-fetched).

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// Reuse the shared CESP→our-manifest conversion so registry installs (packRegistry.ts),
// the runtime provisioner and this CLI produce byte-identical manifests.
import { cespToManifestSounds, deriveSoundId, packBasename, type CespManifest } from '../src/main/sounds'
// The pack list lives in ONE place, shared with the app's runtime self-provisioner.
import { DEFAULT_PACKS, packRawBase } from '../src/main/data/defaultPacks'
import type { RegistryPack } from '../src/shared/types'

const here = dirname(fileURLToPath(import.meta.url))
const outRoot = join(here, '..', 'resources', 'soundpacks')

/** Polite delay between file requests. */
const REQUEST_DELAY_MS = 250
const MAX_ATTEMPTS = 4
const RETRY_BASE_MS = 1_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** GET with exponential backoff; honors Retry-After on 429/503. */
async function fetchWithBackoff(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null
    try {
      res = await fetch(url)
      if (res.ok) return res
      if (res.status < 500 && res.status !== 429) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`)
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err
    }
    if (attempt >= MAX_ATTEMPTS) throw new Error(`GET ${url} → ${res?.status ?? 'network error'} (gave up)`)
    const retryAfter = Number(res?.headers.get('retry-after') ?? 0)
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : RETRY_BASE_MS * 2 ** (attempt - 1)
    console.warn(`  … ${url} failed (attempt ${attempt}) — retrying in ${waitMs}ms`)
    await sleep(waitMs)
  }
}

async function fetchText(url: string): Promise<string> {
  return (await fetchWithBackoff(url)).text()
}

async function fetchBytes(url: string): Promise<Buffer> {
  return Buffer.from(await (await fetchWithBackoff(url)).arrayBuffer())
}

async function fetchPack(pack: RegistryPack): Promise<void> {
  const base = packRawBase(pack)
  const cesp = JSON.parse(await fetchText(`${base}/openpeon.json`)) as CespManifest

  const packDir = join(outRoot, pack.name)
  const soundsDir = join(packDir, 'sounds')
  mkdirSync(soundsDir, { recursive: true })

  // Convert with the SHARED helper + SHARED id derivation so the generated manifest
  // matches what an in-app install of the same tag produces.
  const taken = new Set<string>()
  const manifestSounds = cespToManifestSounds(cesp, (category, file) => deriveSoundId(category, file, taken))

  let downloaded = 0
  let skipped = 0
  for (const group of Object.values(cesp.categories)) {
    const sounds = Array.isArray(group) ? [] : (group.sounds ?? [])
    for (const s of sounds) {
      if (!s || typeof s.file !== 'string') continue
      const name = packBasename(s.file)
      const dest = join(soundsDir, name)
      // Idempotent: skip if a non-empty file already exists.
      if (existsSync(dest) && statSync(dest).size > 0) {
        skipped++
        continue
      }
      writeFileSync(dest, await fetchBytes(`${base}/${s.file}`))
      downloaded++
      await sleep(REQUEST_DELAY_MS)
    }
  }

  const manifest = {
    id: pack.name,
    name: pack.display_name || cesp.display_name || pack.name,
    license: cesp.license ?? pack.license ?? 'see source repo',
    sounds: manifestSounds,
    source: { repo: pack.source_repo, ref: pack.source_ref }
  }
  writeFileSync(join(packDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  console.log(
    `${pack.name}: ${Object.keys(manifestSounds).length} sounds (${downloaded} downloaded, ${skipped} already present) → ${packDir}`
  )
}

async function main(): Promise<void> {
  console.log(`Fetching ${DEFAULT_PACKS.length} soundpack(s) …`)
  for (const pack of DEFAULT_PACKS) await fetchPack(pack)
  console.log('Done. (Pack audio is gitignored — not committed.)')
}

main().catch((err) => {
  console.error('fetch-packs failed:', err)
  process.exitCode = 1
})
