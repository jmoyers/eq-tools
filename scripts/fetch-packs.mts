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

const BASE = 'https://raw.githubusercontent.com/PeonPing/og-packs/main'

interface CespSound {
  file: string
  label: string
  sha256?: string
}
interface CespManifest {
  display_name?: string
  license?: string
  categories: Record<string, { sounds: CespSound[] }>
}

/** Category → the label prefix our manifest uses so the picker reads well. */
const CATEGORY_LABEL: Record<string, string> = {
  'session.start': 'Start',
  'task.acknowledge': 'Acknowledge',
  'task.complete': 'Complete',
  'task.error': 'Error',
  'input.required': 'Input',
  'resource.limit': 'Limit',
  'user.spam': 'Spam'
}

/**
 * Source-filename → our stable soundId. Keyed by basename so it's independent of
 * the `sounds/` prefix. These reproduce the committed manifests exactly.
 */
const ID_MAP: Record<string, Record<string, string>> = {
  peon: {
    'PeonReady1.wav': 'ready',
    'PeonWhat4.wav': 'need-doing',
    'PeonYes1.wav': 'ack-cando',
    'PeonYes2.wav': 'ack-happy',
    'PeonYes4.wav': 'ack-okie',
    'PeonYesAttack3.wav': 'ack-try',
    'PeonWorkComplete.wav': 'complete-work',
    'PeonYes3.wav': 'complete-workwork',
    'PeonAngry4.wav': 'error-notthatorc',
    'PeonDeath.wav': 'error-ugh',
    'PeonWhat2.wav': 'input-hmm',
    'PeonWhat3.wav': 'input-whatyouwant',
    'PeonWhat1.wav': 'input-yes',
    'PeonWarcry1.wav': 'limit-whynot',
    'PeonAngry1.wav': 'spam-whaaat',
    'PeonAngry2.wav': 'spam-leavemealone',
    'PeonAngry3.wav': 'spam-notime'
  },
  sc_marine: {
    'YouWannaPieceOfMe.mp3': 'start-pieceofme',
    'GoGoGo.mp3': 'ack-gogogo',
    'LetsMove.mp3': 'ack-letsmove',
    'Outstanding.mp3': 'ack-outstanding',
    'RockAndRoll.mp3': 'ack-rockandroll',
    'JackedUpAndGoodToGo.mp3': 'complete-jackedup',
    'GimmeSomethingToShoot.mp3': 'complete-shoot',
    'Death1.mp3': 'error-ugh',
    'Death2.mp3': 'error-ahh',
    'Commander.mp3': 'input-commander',
    'StandinBy.mp3': 'input-standinby',
    'WeGottaMove.mp3': 'limit-wegottamove',
    'GiveMeOrders.mp3': 'spam-orders',
    'HesWhacked.mp3': 'spam-whacked',
    'FragCommander.mp3': 'spam-frag',
    'GetOutOfOutfit.mp3': 'spam-outfit'
  }
}

/** Human display names for the pack (matches committed manifests). */
const PACK_NAME: Record<string, string> = {
  peon: 'Orc Peon',
  sc_marine: 'StarCraft Marine'
}

const here = dirname(fileURLToPath(import.meta.url))
const outRoot = join(here, '..', 'resources', 'soundpacks')

function basename(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1]
}

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

  const manifestSounds: Record<string, { file: string; label: string }> = {}
  let downloaded = 0
  let skipped = 0

  for (const [category, group] of Object.entries(cesp.categories)) {
    const prefix = CATEGORY_LABEL[category] ?? category
    for (const s of group.sounds) {
      const name = basename(s.file)
      const soundId = idMap[name]
      if (!soundId) {
        console.warn(`  ! ${pack}: no soundId mapping for ${name} — skipping`)
        continue
      }
      const relFile = `sounds/${name}`
      manifestSounds[soundId] = { file: relFile, label: `${prefix} · ${s.label}` }

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
