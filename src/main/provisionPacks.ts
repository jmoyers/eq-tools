// provisionPacks.ts — self-provisioning of the shipped voice packs (Task #39).
//
// The imported CC-BY-NC voice packs (peon, sc_marine) are gitignored, so a CI-built
// installer ships WITHOUT them — a fresh install would then have a seeded charm-break
// alert pointing at a missing `peon/error-notthatorc` sound. To make "processing happen
// by itself", at startup we check listPacks() for each shipped default id and, for any
// that's missing, silently download it from the same og-packs source into
// <userData>/soundpacks/<id>/ using the SAME CESP→manifest conversion + fixed id map the
// dev fetch-packs script uses (so the soundIds match and the seeded alert resolves).
//
// Non-blocking, best-effort, silent: called after the window is up. Errors go to the
// error log only (never the UI) and simply retry next startup. On success we invalidate
// the renderer's sound caches + re-list packs the same way a registry install does, so a
// provisioned pack becomes selectable/playable live without a restart.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logError } from './errorLog'
import { cespToManifestSounds, listPacks, packBasename, userPacksRoot, type CespManifest } from './sounds'
import { DEFAULT_PACK_IDS, OG_PACKS_BASE, PACK_ID_MAP, PACK_NAME } from './data/defaultPacks'
import type { SoundPackManifest } from '../shared/types'

/** GET a URL as bytes (throws on non-2xx). Uses the global fetch (Node ≥18 / Electron). */
async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`)
  return Buffer.from(await res.arrayBuffer())
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`)
  return res.text()
}

/**
 * Download one default pack from og-packs into <userData>/soundpacks/<id>/, converting
 * its CESP openpeon.json into our manifest with the pack's FIXED id map. Staged into a
 * `.installing` sibling and atomically renamed so a mid-download failure never leaves a
 * half-written pack shadowing anything. Returns true on success.
 */
async function provisionPack(packId: string, packsRoot: string): Promise<boolean> {
  const idMap = PACK_ID_MAP[packId]
  if (!idMap) return false

  const cesp = JSON.parse(await fetchText(`${OG_PACKS_BASE}/${packId}/openpeon.json`)) as CespManifest

  // Same conversion the CLI + registry installer use, keyed by the pack's fixed id map so
  // the produced soundIds byte-match the committed manifest (seeded alerts depend on them).
  const manifestSounds = cespToManifestSounds(cesp, (_category, file) => idMap[packBasename(file)] ?? null)
  if (Object.keys(manifestSounds).length === 0) throw new Error(`${packId}: no sounds after conversion`)

  const packDir = join(packsRoot, packId)
  const stageDir = `${packDir}.installing`
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(join(stageDir, 'sounds'), { recursive: true })

  // Download only the mapped source files (skip anything without a stable id).
  let wrote = 0
  for (const group of Object.values(cesp.categories ?? {})) {
    const sounds = Array.isArray(group) ? [] : (group.sounds ?? [])
    for (const s of sounds) {
      if (!s || typeof s.file !== 'string') continue
      const name = packBasename(s.file)
      if (!idMap[name]) continue
      const bytes = await fetchBytes(`${OG_PACKS_BASE}/${packId}/${s.file}`)
      writeFileSync(join(stageDir, 'sounds', name), bytes)
      wrote++
    }
  }
  if (wrote === 0) {
    rmSync(stageDir, { recursive: true, force: true })
    throw new Error(`${packId}: no audio files downloaded`)
  }

  const manifest: SoundPackManifest = {
    id: packId,
    name: PACK_NAME[packId] ?? cesp.display_name ?? packId,
    license: cesp.license ?? 'CC-BY-NC-4.0',
    sounds: manifestSounds
  }
  writeFileSync(join(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  if (existsSync(packDir)) rmSync(packDir, { recursive: true, force: true })
  renameSync(stageDir, packDir)
  return true
}

/**
 * Ensure every shipped default pack is present. For each id NOT already surfaced by
 * listPacks() (bundled or user), download it in the background. Best-effort: a failure
 * on one pack is logged and skipped; the next startup retries. Resolves to the number of
 * packs newly provisioned so the caller can refresh sound caches only when something
 * actually changed.
 */
export async function provisionDefaultPacks(opts?: {
  /** Override the target packs root (defaults to <userData>/soundpacks). For the validation harness. */
  packsRoot?: string
  /** Override which pack ids count as already-present (defaults to listPacks()). For the harness. */
  installedIds?: Set<string>
}): Promise<number> {
  const packsRoot = opts?.packsRoot ?? userPacksRoot()

  let installed: Set<string>
  if (opts?.installedIds) {
    installed = opts.installedIds
  } else {
    try {
      installed = new Set(listPacks().map((p) => p.id))
    } catch (err) {
      logError('main:provisionPacks', { message: 'listPacks failed; skipping provisioning', err })
      return 0
    }
  }

  const missing = DEFAULT_PACK_IDS.filter((id) => !installed.has(id))
  if (missing.length === 0) return 0

  let count = 0
  for (const id of missing) {
    try {
      if (await provisionPack(id, packsRoot)) count++
    } catch (err) {
      // Silent by design — never surface to the UI; retry next startup.
      logError('main:provisionPacks', { message: `provisioning '${id}' failed`, err })
    }
  }
  return count
}
