// fetch-packs.mts — download the CC-BY-NC voice packs (peon, sc_marine) from
// github.com/PeonPing/og-packs into resources/soundpacks/, converting the source
// CESP `openpeon.json` into OUR manifest.json shape. Run:
//
//   export PATH="/c/Program Files/nodejs:$PATH"   # this machine
//   npm run fetch:packs
//
// WHY THIS EXISTS: the packs are CC-BY-NC game audio, so they're gitignored (they
// stay out of the public repo). A fresh clone runs this to restore them before
// `npm run dist`. Idempotent: re-running re-downloads only missing/short files and
// rewrites the manifest, so deleting a file and re-running restores it.
//
// SHAPE MAPPING: the source groups sounds by CESP category (session.start,
// task.acknowledge, …). Our manifest flattens them to stable soundId keys with a
// human label prefixed by the category ("Start · Ready to work!"). The soundId per
// source file is fixed below (ID_MAP) so the generated manifest byte-matches the
// hand-authored one already committed — alerts reference these ids (e.g. the seeded
// charm-break alert points at peon/error-notthatorc).

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// Reuse the shared CESP→our-manifest conversion so registry installs (packRegistry.ts)
// and this CLI produce byte-identical labels ("Complete · Work complete.").
import { cespToManifestSounds, packBasename, type CespManifest } from '../src/main/sounds'
// The pack id map + names live in ONE place, shared with the app's runtime
// self-provisioner (src/main/provisionPacks.ts), so both write byte-identical manifests.
import { OG_PACKS_BASE as BASE, PACK_ID_MAP as ID_MAP, PACK_NAME } from '../src/main/data/defaultPacks'

const here = dirname(fileURLToPath(import.meta.url))
const outRoot = join(here, '..', 'resources', 'soundpacks')

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`)
  return res.text()
}

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`)
  return Buffer.from(await res.arrayBuffer())
}

async function fetchPack(pack: string): Promise<void> {
  const src = (await fetchText(`${BASE}/${pack}/openpeon.json`)) as string
  const cesp = JSON.parse(src) as CespManifest
  const idMap = ID_MAP[pack]
  if (!idMap) throw new Error(`no ID_MAP for pack '${pack}'`)

  const packDir = join(outRoot, pack)
  const soundsDir = join(packDir, 'sounds')
  mkdirSync(soundsDir, { recursive: true })

  // Convert with the SHARED helper, passing the pack's fixed ID_MAP as the soundId
  // resolver so the generated manifest byte-matches the committed one.
  const manifestSounds = cespToManifestSounds(cesp, (_category, file) => {
    const soundId = idMap[packBasename(file)]
    if (!soundId) console.warn(`  ! ${pack}: no soundId mapping for ${packBasename(file)} — skipping`)
    return soundId ?? null
  })

  let downloaded = 0
  let skipped = 0
  for (const group of Object.values(cesp.categories)) {
    const sounds = Array.isArray(group) ? [] : (group.sounds ?? [])
    for (const s of sounds) {
      const name = packBasename(s.file)
      if (!idMap[name]) continue
      const dest = join(soundsDir, name)
      // Idempotent: skip if a non-empty file already exists.
      if (existsSync(dest) && statSync(dest).size > 0) {
        skipped++
        continue
      }
      const bytes = await fetchBytes(`${BASE}/${pack}/${s.file}`)
      writeFileSync(dest, bytes)
      downloaded++
    }
  }

  const manifest = {
    id: pack,
    name: PACK_NAME[pack] ?? cesp.display_name ?? pack,
    license: cesp.license ?? 'CC-BY-NC-4.0',
    sounds: manifestSounds
  }
  writeFileSync(join(packDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  console.log(
    `${pack}: ${Object.keys(manifestSounds).length} sounds (${downloaded} downloaded, ${skipped} already present) → ${packDir}`
  )
}

async function main(): Promise<void> {
  const packs = Object.keys(ID_MAP)
  console.log(`Fetching ${packs.length} soundpack(s) from ${BASE} …`)
  for (const pack of packs) await fetchPack(pack)
  console.log('Done. (These packs are CC-BY-NC-4.0 and gitignored — not committed.)')
}

main().catch((err) => {
  console.error('fetch-packs failed:', err)
  process.exitCode = 1
})
