// telemetry/ring.ts — `<userData>/telemetry.json`, the local event ring.
//
// TWO HALVES, split for the same reason `storeMigrations.ts` splits its runner from its file
// I/O: the RING ITSELF is pure and node-testable (`pushCapped`, `parseRingFile`), and the file
// half is a thin, Electron-dependent shell over it.
//
// WHY NOT electron-store (a decision, not an oversight — the same one feedback/state.ts made):
// the store-migration law exists so the SETTINGS file written by any past build loads in
// today's build, indefinitely. Buffered telemetry is disposable by design — the whole feature
// is "counts we would like to have" — and paying the migration tax for it would be wrong twice
// over. So: its own file, its own tiny `version` integer, corrupt ⇒ start from empty.
//
// The user's PREFERENCES (enabled / noticeShown / analyticsId) do live in the settings store,
// behind schema migration 5 → 6, because those are not disposable: forgetting that a user
// turned analytics off would be the worst bug this feature could have.
//
// Everything resolves through `app.getPath('userData')`, so channel.ts's decision redirects it
// automatically: the dev app, the installed app and an e2e run can never share a ring.

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TELEMETRY_BUFFER_CAP,
  type TelemetryBatch,
  type TelemetryRecord
} from '../../shared/telemetry'
import { validateRecord } from '../../shared/telemetryValidate'
import { logError, logInfo } from '../errorLog'

/** Bumped only if this file's shape changes. Unreadable/older ⇒ start empty, never migrate. */
export const TELEMETRY_RING_VERSION = 1

const RING_FILE = 'telemetry.json'

export interface TelemetryRing {
  version: number
  /** Oldest first. At most `TELEMETRY_BUFFER_CAP`; the oldest is dropped, never the newest. */
  events: TelemetryRecord[]
  /**
   * The last batch this install actually SENT, kept so Preferences can show it verbatim (T4).
   * PERMANENTLY null while the build is dark — there is no transport — and the pane says so
   * rather than rendering an empty box the user has to interpret.
   */
  lastBatch: TelemetryBatch | null
}

export function emptyRing(): TelemetryRing {
  return { version: TELEMETRY_RING_VERSION, events: [], lastBatch: null }
}

/**
 * Append with the cap applied — THE ring's whole behavior, as a pure function.
 *
 * A full ring drops the OLDEST record. That is the honest choice for a counter feed: the
 * newest events describe the session someone is actually having, and refusing to record
 * anything once 500 have piled up would silently stop measuring exactly the long sessions
 * most worth measuring. Never mutates its input.
 */
export function pushCapped(
  events: readonly TelemetryRecord[],
  next: TelemetryRecord,
  cap = TELEMETRY_BUFFER_CAP
): TelemetryRecord[] {
  if (cap <= 0) return []
  const out = [...events, next]
  return out.length <= cap ? out : out.slice(out.length - cap)
}

/**
 * Shape check, not a migration: anything unexpected means "start fresh". Individual records are
 * re-validated through the SHARED validator, so a hand-edited file cannot smuggle a field the
 * schema does not have into a batch — the ring is an input like any other.
 */
export function parseRingFile(raw: unknown): TelemetryRing | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.version !== TELEMETRY_RING_VERSION) return null
  if (!Array.isArray(o.events)) return null
  const events: TelemetryRecord[] = []
  for (const entry of o.events) {
    const rec = validateRecord(entry)
    if (rec.ok) events.push(rec.value)
  }
  return {
    version: TELEMETRY_RING_VERSION,
    events: events.slice(Math.max(0, events.length - TELEMETRY_BUFFER_CAP)),
    // The last-sent batch is display-only; a malformed one is simply forgotten.
    lastBatch: null
  }
}

// ------------------------------------------------------------------ the file half

function ringPath(): string {
  return join(app.getPath('userData'), RING_FILE)
}

let cached: TelemetryRing | null = null

/** Read (and memoize) the ring. Missing or corrupt ⇒ empty, and nothing is written until the
 *  first record arrives — a user who turned analytics off never grows the file at all. */
export function readRing(): TelemetryRing {
  if (cached) return cached
  const path = ringPath()
  if (existsSync(path)) {
    try {
      const parsed = parseRingFile(JSON.parse(readFileSync(path, 'utf8')) as unknown)
      if (parsed) {
        cached = parsed
        return cached
      }
      logInfo('[everquest-companion] telemetry.json unreadable/foreign — starting from empty')
    } catch (err) {
      logError('main:telemetryRing', { message: 'telemetry.json parse failed; starting empty', err })
    }
  }
  cached = emptyRing()
  return cached
}

/** Persist atomically (temp file + rename). Best effort: losing counters is not an app failure. */
export function writeRing(next: TelemetryRing): void {
  cached = next
  const path = ringPath()
  const tmp = `${path}.tmp`
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    logError('main:telemetryRing', { message: 'telemetry.json write failed', err })
  }
}

/**
 * DROP EVERYTHING, now — the buffer AND the file. This is what "turn it off" means, and what a
 * rotation means: a switch that left 500 events sitting on disk would be a switch that lied.
 */
export function dropRing(): void {
  cached = emptyRing()
  try {
    rmSync(ringPath(), { force: true })
  } catch (err) {
    logError('main:telemetryRing', { message: 'telemetry.json delete failed', err })
  }
}

/** Test/dev seam: forget the memoized ring so the next read hits disk again. */
export function resetRingCache(): void {
  cached = null
}
