import { existsSync, readdirSync, statSync } from 'fs'
import { basename, join } from 'path'
import type { CharacterRef } from '../../shared/types'

/** Default EverQuest Legends install root on this machine. */
export const EQ_ROOT =
  'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'

export const EQ_LOGS_DIR = join(EQ_ROOT, 'Logs')

/** Parse "eqlog_<Character>_<server>.txt" into a CharacterRef. */
function parseLogName(logPath: string): CharacterRef | null {
  const m = /^eqlog_(.+?)_(.+?)\.txt$/i.exec(basename(logPath))
  if (!m) return null
  return { name: m[1], server: m[2], logPath }
}

/**
 * Locate the active character log. Preference order:
 * 1. an explicit override (env EQ_LOG_PATH)
 * 2. the most recently modified eqlog_*.txt in the Logs dir
 */
export function resolveActiveCharacter(): CharacterRef | null {
  const override = process.env.EQ_LOG_PATH
  if (override && existsSync(override)) {
    return parseLogName(override) ?? { name: 'Unknown', server: 'unknown', logPath: override }
  }
  if (!existsSync(EQ_LOGS_DIR)) return null

  const candidates = readdirSync(EQ_LOGS_DIR)
    .filter((f) => /^eqlog_.+\.txt$/i.test(f))
    .map((f) => join(EQ_LOGS_DIR, f))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)

  if (candidates.length === 0) return null
  return parseLogName(candidates[0].p)
}
