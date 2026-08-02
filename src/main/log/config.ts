import { existsSync, readdirSync, statSync } from 'fs'
import { basename, join } from 'path'
import type { CharacterRef } from '../../shared/types'
import { getEqInstallDir } from '../store'
import {
  EQ_ROOT,
  countCharacterLogs,
  discoverEqRoot,
  fixedDrives,
  registryInstallCandidates,
  rootHasLogs,
  type DiscoveryProbes
} from './discovery'

/**
 * EQ install-dir resolution. The pure, store-free discovery core lives in
 * `discovery.ts` (unit-tested); this module binds it to the persisted override
 * (electron-store `eqInstallDir`) and exposes the ONE resolver every path
 * consumer uses (`effectiveEqRoot` / `eqLogsDir`). Do NOT hardcode the Daybreak
 * path anywhere else — route through here so the override + discovery apply
 * uniformly to log listing/tailing AND the inventory scan.
 */

// Re-export the canonical default + pure discovery pieces so existing importers of
// `../log/config` keep working (EQ_ROOT was imported by inventory/parseInventory).
export { EQ_ROOT, discoverEqRoot, rootHasLogs, countCharacterLogs, type DiscoveryProbes }

/** The env escape hatch: an explicit install dir (tests/dev), highest priority. */
function envCandidates(): string[] {
  const out: string[] = []
  const dir = process.env.EQ_INSTALL_DIR
  if (dir) out.push(dir)
  // EQ_LOG_PATH points at a log FILE; its grandparent is the install root
  // (<root>\Logs\eqlog_*.txt). Kept for back-compat with the old override.
  const logPath = process.env.EQ_LOG_PATH
  if (logPath) out.push(join(logPath, '..', '..'))
  return out
}

/** The real-environment discovery probes (env → registry → drive sweep). */
function realProbes(): DiscoveryProbes {
  return {
    hasLogs: rootHasLogs,
    extraCandidates: () => [...envCandidates(), ...registryInstallCandidates()],
    fixedDrives
  }
}

// ---------------------------------------------------------------------------
// Effective-root resolver — the ONE entry point every path consumer uses.
// ---------------------------------------------------------------------------

export type EqDirSource = 'manual' | 'auto' | 'default'

export interface ResolvedEqDir {
  /** The effective install root in use. */
  root: string
  /** The `<root>\Logs` directory. */
  logsDir: string
  /** How `root` was chosen: a saved override, auto-discovery, or the fallback. */
  source: EqDirSource
  /** Number of `eqlog_*.txt` character logs found under `logsDir` (0 = none). */
  characterCount: number
}

/**
 * Resolve the effective EQ install root: the persisted manual override if set,
 * else auto-discovery, else the canonical default (so the UI always has a path
 * to show even on a machine with no install yet). This is the single source of
 * truth for `effectiveEqRoot()` / `eqLogsDir()` and the Settings panel.
 */
export function resolveEqDir(): ResolvedEqDir {
  const override = getEqInstallDir()
  let root: string
  let source: EqDirSource
  if (override && override.trim()) {
    root = override
    source = 'manual'
  } else {
    const discovered = discoverEqRoot(realProbes())
    if (discovered) {
      root = discovered
      source = 'auto'
    } else {
      root = EQ_ROOT
      source = 'default'
    }
  }
  const logsDir = join(root, 'Logs')
  return { root, logsDir, source, characterCount: countCharacterLogs(logsDir) }
}

/** The effective install root (override ?? discovery ?? default). */
export function effectiveEqRoot(): string {
  return resolveEqDir().root
}

/** The effective `<root>\Logs` directory every log consumer reads from. */
export function eqLogsDir(): string {
  return resolveEqDir().logsDir
}

// ---------------------------------------------------------------------------
// Character-log listing / active-character resolution (now dir-resolver-driven).
// ---------------------------------------------------------------------------

/** Parse "eqlog_<Character>_<server>.txt" into a CharacterRef. */
export function parseLogName(logPath: string): CharacterRef | null {
  const m = /^eqlog_(.+?)_(.+?)\.txt$/i.exec(basename(logPath))
  if (!m) return null
  const lastPlayed = existsSync(logPath) ? statSync(logPath).mtimeMs : undefined
  return { name: m[1], server: m[2], logPath, lastPlayed }
}

/** Stable id for a character (used to key per-character progress). */
export function characterId(c: CharacterRef): string {
  return `${c.name}_${c.server}`.toLowerCase()
}

/** All detected character logs, most-recently-played first. */
export function listCharacters(): CharacterRef[] {
  const logsDir = eqLogsDir()
  if (!existsSync(logsDir)) return []
  return readdirSync(logsDir)
    .filter((f) => /^eqlog_.+\.txt$/i.test(f))
    .map((f) => parseLogName(join(logsDir, f)))
    .filter((c): c is CharacterRef => c !== null)
    .sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
}

/**
 * Locate the active character log. Preference order:
 * 1. an explicit override (env EQ_LOG_PATH)
 * 2. the most recently modified eqlog_*.txt in the effective Logs dir
 * Returns null when nothing is found (fresh machine — the UI shows an empty
 * state pointing at the Settings gear rather than erroring).
 */
export function resolveActiveCharacter(): CharacterRef | null {
  const override = process.env.EQ_LOG_PATH
  if (override && existsSync(override)) {
    return parseLogName(override) ?? { name: 'Unknown', server: 'unknown', logPath: override }
  }
  const logsDir = eqLogsDir()
  if (!existsSync(logsDir)) return null

  const candidates = readdirSync(logsDir)
    .filter((f) => /^eqlog_.+\.txt$/i.test(f))
    .map((f) => join(logsDir, f))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)

  if (candidates.length === 0) return null
  return parseLogName(candidates[0].p)
}
