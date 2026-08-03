// EverQuest Legends install-root DISCOVERY (pure, dependency-free core).
//
// A friend installing the game should need zero config: the app sweeps sensible
// candidate install roots and picks the first one that actually holds a `Logs`
// directory with an `eqlog_*.txt` in it. A manual override (persisted in
// electron-store) always wins — that lives in config.ts's `resolveEqDir`, which
// is the ONLY consumer that needs the store. This module stays free of the store
// (and thus of electron) so the discovery logic is unit-testable under plain node.
//
// Discovery order (first hit wins, see `discoverEqRoot`):
//   1. `extraCandidates()` — env escape hatch, then registry InstallLocations.
//   2. `<drive>\<Daybreak subpath>` across every fixed drive.
// On THIS machine (2026-08) there are no Daybreak/EverQuest registry keys — the
// game lives at the public path — so discovery resolves via the drive sweep.

import { execFileSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

/** The canonical Daybreak install root on a default EQ Legends install. */
export const EQ_ROOT =
  'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'

/** Relative sub-paths (below a drive root) where a Daybreak install commonly lands. */
const DAYBREAK_SUBPATHS = [
  'Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends',
  'Daybreak Game Company\\Installed Games\\EverQuest Legends',
  'Program Files\\Daybreak Game Company\\Installed Games\\EverQuest Legends',
  'Program Files (x86)\\Daybreak Game Company\\Installed Games\\EverQuest Legends',
  // Legacy Sony Online Entertainment layout (pre-Daybreak rename), just in case.
  'Users\\Public\\Sony Online Entertainment\\Installed Games\\EverQuest Legends',
  'Program Files (x86)\\Sony Online Entertainment\\Installed Games\\EverQuest Legends'
]

// ---------------------------------------------------------------------------
// Pure discovery core (injectable probes → unit-testable without a real disk /
// registry). The exported wrappers below bind the real fs + `reg query`.
// ---------------------------------------------------------------------------

export interface DiscoveryProbes {
  /** True if `<root>\Logs` exists AND contains at least one `eqlog_*.txt`. */
  hasLogs: (root: string) => boolean
  /** Ordered candidate roots to try before the drive sweep (env, registry). */
  extraCandidates: () => string[]
  /** Fixed-drive letters to sweep, e.g. ['C:', 'D:']. */
  fixedDrives: () => string[]
}

/** Does `<root>\Logs` hold at least one character log? The discovery predicate. */
export function rootHasLogs(root: string): boolean {
  const logsDir = join(root, 'Logs')
  if (!existsSync(logsDir)) return false
  try {
    return readdirSync(logsDir).some((f) => /^eqlog_.+\.txt$/i.test(f))
  } catch {
    return false
  }
}

/** Count the `eqlog_*.txt` files under a Logs dir (0 if the dir is absent). */
export function countCharacterLogs(logsDir: string): number {
  if (!existsSync(logsDir)) return 0
  try {
    return readdirSync(logsDir).filter((f) => /^eqlog_.+\.txt$/i.test(f)).length
  } catch {
    return 0
  }
}

/**
 * Pure ordered discovery: return the first candidate root whose `Logs` dir holds
 * an `eqlog_*.txt`, or null if none match. Candidates, in order:
 *   1. `extraCandidates()` (env override, then registry InstallLocations)
 *   2. `<drive>\<subpath>` for every fixed drive × every Daybreak subpath
 * Duplicates are collapsed so a candidate is probed at most once.
 */
export function discoverEqRoot(probes: DiscoveryProbes): string | null {
  const seen = new Set<string>()
  const candidates: string[] = []
  const push = (c: string | undefined | null): void => {
    if (!c) return
    const key = c.replace(/[\\/]+$/, '').toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(c)
  }

  for (const c of probes.extraCandidates()) push(c)
  for (const drive of probes.fixedDrives()) {
    const d = drive.replace(/[\\/]+$/, '')
    for (const sub of DAYBREAK_SUBPATHS) push(`${d}\\${sub}`)
  }

  for (const c of candidates) if (probes.hasLogs(c)) return c
  return null
}

// ---------------------------------------------------------------------------
// Real-environment probes (fs + registry). Defensive: absent keys / drives are
// fine and never throw.
// ---------------------------------------------------------------------------

/** Enumerate fixed-drive roots (e.g. ['C:', 'D:']). Falls back to ['C:']. */
export function fixedDrives(): string[] {
  const found: string[] = []
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const letter = String.fromCharCode(code)
    if (existsSync(`${letter}:\\`)) found.push(`${letter}:`)
  }
  return found.length > 0 ? found : ['C:']
}

/**
 * Pull an install path out of ONE `reg query /s` output line: we grep the
 * "InstallLocation"/"InstallPath"/"InstallDir" REG_SZ lines. Returns null when the
 * line isn't one of those (or carries an empty value).
 */
function installPathFromRegLine(line: string): string | null {
  const m = /\b(?:InstallLocation|InstallPath|InstallDir)\b\s+REG_SZ\s+(.+?)\s*$/i.exec(line)
  if (!m) return null
  const p = m[1].trim()
  return p ? p : null
}

/**
 * Probe the Windows registry (defensively) for an EverQuest / Daybreak install
 * location. Checks the standard Uninstall hives (both HKLM 64/32-bit views and
 * HKCU) plus Daybreak/SOE launcher keys. Returns any `InstallLocation` /
 * `InstallPath` string values found — most machines have none (the game is a
 * public-folder install), which is fine.
 */
export function registryInstallCandidates(): string[] {
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Daybreak Game Company',
    'HKLM\\SOFTWARE\\WOW6432Node\\Daybreak Game Company',
    'HKCU\\SOFTWARE\\Daybreak Game Company',
    'HKLM\\SOFTWARE\\WOW6432Node\\Sony Online Entertainment',
    'HKCU\\SOFTWARE\\Sony Online Entertainment'
  ]
  const out: string[] = []
  for (const key of keys) {
    // Search the subtree for value names holding an install path. `reg query /s`
    // walks recursively; we grep the "InstallLocation"/"InstallPath" REG_SZ lines
    // (see installPathFromRegLine).
    let stdout = ''
    try {
      stdout = execFileSync('reg', ['query', key, '/s', '/f', 'EverQuest', '/t', 'REG_SZ'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      // Absent key or no match → reg exits non-zero. Fine; try the next.
      continue
    }
    for (const line of stdout.split(/\r?\n/)) {
      const p = installPathFromRegLine(line)
      if (p) out.push(p)
    }
  }
  return out
}
