// provisionPacks.ts — self-provisioning of the shipped voice pack (Task #39).
//
// The shipped audio is gitignored, so a CI-built installer ships WITHOUT it — a fresh
// install would then have seeded alerts pointing at missing sounds. At startup we check
// listPacks() for each shipped default id and, for any that's missing, silently install
// it into <userData>/soundpacks/<id>/ through the SAME installPack path the in-app
// registry browser uses (release tarball at a pinned tag → CESP→manifest conversion), so
// the soundIds match a user-initiated install exactly and the seeded alerts resolve.
//
// ADDITIVE ONLY: packs already on disk are never touched, re-downloaded, or removed —
// only ids missing from listPacks() are fetched. A user who installed the old peon /
// sc_marine / default packs keeps them (and any alert pointing at them keeps playing).
//
// ETIQUETTE (AGENTS.md "Scraper etiquette" LAW): idempotent (an installed pack skips the
// network entirely), ONE request per missing pack (the release tarball — not 60 file
// GETs), pinned to an immutable tag, spaced by a delay when more than one pack is
// missing, and retried with exponential backoff on failure. A run that fails entirely
// just retries next startup.
//
// Non-blocking, best-effort, silent: called after the window is up. Errors go to the
// error log only (never the UI). On success we invalidate the renderer's sound caches +
// re-list packs the same way a registry install does, so a provisioned pack becomes
// selectable/playable live without a restart.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logError } from './errorLog'
import { listPacks, userPacksRoot } from './sounds'
import { installPack } from './packRegistry'
import { DEFAULT_PACKS, REQUIRED_SOUND_IDS } from './data/defaultPacks'
import type { RegistryPack, SoundPackManifest } from '../shared/types'

/** Attempts per pack before giving up until the next startup. */
const MAX_ATTEMPTS = 3
/** Base backoff between attempts (doubled each retry). */
const RETRY_BASE_MS = 2_000
/** Spacing between packs when more than one is missing. */
const BETWEEN_PACKS_MS = 1_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Post-install sanity check: the ids the shipped alert defs reference must exist in the
 * installed manifest. A mismatch means the upstream pack changed shape under its tag (or
 * our derivation drifted) — log it to file so it's caught here rather than as a silently
 * mute alert. The pack is left in place either way; a partial mismatch still gives the
 * user a working pack in the picker.
 */
function verifyRequiredSounds(packsRoot: string, packId: string): void {
  try {
    const manifestPath = join(packsRoot, packId, 'manifest.json')
    if (!existsSync(manifestPath)) return
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SoundPackManifest
    const missing = REQUIRED_SOUND_IDS.filter((id) => !manifest.sounds?.[id])
    if (missing.length > 0) {
      logError('main:provisionPacks', {
        message: `'${packId}' installed but is missing sounds the shipped alerts reference`,
        missing
      })
    }
  } catch (err) {
    logError('main:provisionPacks', { message: `verify of '${packId}' failed`, err })
  }
}

/**
 * The progress sink a provisioning install gets. Deliberately does nothing: provisioning has
 * no UI surface at all (see the file header — "Non-blocking, best-effort, silent"), so every
 * phase update it would report has nowhere to go.
 */
const swallowProgress = (): void => {
  /* silence on purpose — provisioning is invisible by design */
}

/** Install one default pack, retrying with exponential backoff. True on success. */
async function provisionPack(pack: RegistryPack, packsRoot: string): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Progress is swallowed: provisioning is invisible by design (no UI surface).
      await installPack(pack, swallowProgress, packsRoot)
      verifyRequiredSounds(packsRoot, pack.name)
      return true
    } catch (err) {
      const last = attempt === MAX_ATTEMPTS
      logError('main:provisionPacks', {
        message: `provisioning '${pack.name}' failed (attempt ${attempt}/${MAX_ATTEMPTS})${last ? '' : ' — backing off'}`,
        err
      })
      if (last) return false
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1))
    }
  }
  return false
}

/**
 * Ensure every shipped default pack is present. For each id NOT already surfaced by
 * listPacks() (bundled or user), install it in the background. Best-effort: a failure on
 * one pack is logged and skipped; the next startup retries. Resolves to the number of
 * packs newly provisioned so the caller can refresh sound caches only when something
 * actually changed.
 */
export async function provisionDefaultPacks(opts?: {
  /** Override the target packs root (defaults to <userData>/soundpacks). For the validation harness. */
  packsRoot?: string
  /** Override which pack ids count as already-present (defaults to listPacks()). For the harness. */
  installedIds?: Set<string>
}): Promise<number> {
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

  const missing = DEFAULT_PACKS.filter((p) => !installed.has(p.name))
  if (missing.length === 0) return 0

  // Resolve the target root only once we know we'll write (keeps the no-op path from
  // touching electron's userData at all).
  const packsRoot = opts?.packsRoot ?? userPacksRoot()

  let count = 0
  for (const [i, pack] of missing.entries()) {
    if (i > 0) await sleep(BETWEEN_PACKS_MS)
    if (await provisionPack(pack, packsRoot)) count++
  }
  return count
}
