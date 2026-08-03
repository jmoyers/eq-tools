// Golden-window test harness (Task #33). Replays a fixture log excerpt through the REAL
// parser + BuffsModule and returns the module's snapshot, so tests assert a plausible
// world model against hand-verified time spans of the user's actual log.
//
// The fixtures under tests/fixtures/*.log are trimmed excerpts of the real
// eqlog_Primitive_freeport.txt (third-party chat/social dropped by the shared scrub
// tests/fixture-scrub.mjs; every buff/entity-relevant line kept). They are COMMITTED — the
// repo is public, so regenerate them only through tests/extract-*.mjs, which all route
// through that scrub. Each golden test documents the raw line range it was cut from and the sequence
// it hand-verifies. This is the methodology the user mandated: never trust the model —
// pin it to real log windows a human read line-by-line.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { BuffsModule } from '../src/main/modules/buffs'
import type { BuffsSnap } from '../src/shared/types'

const HERE = dirname(fileURLToPath(import.meta.url))
export const FIXTURES = join(HERE, 'fixtures')

export function readFixture(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
}

/**
 * Replay raw log lines through the real parser + BuffsModule and return the final
 * snapshot state. `finalTickMs`, when given, fires one `onTick(finalTickMs)` after the
 * fold — modeling the wall-clock heartbeat the live app runs (so a cast in the last 15s
 * confirms, and overdue actives get swept) at a chosen observation instant.
 *
 * `opts.prime` is an EARLIER real log excerpt replayed through the SAME module first, to
 * establish learned state (everFaded / spell class / recognized landing emotes) before
 * the window — exactly as the full-log replay does ahead of the live tail in production.
 * The long inter-day gap between a priming excerpt and its window naturally trips the
 * ≥30-min session-gap clear, which wipes stale ACTIVES/entities but PRESERVES the learned
 * maps (that's the point of priming): the window starts from a clean active set with a
 * warm classifier.
 */
export function replayBuffs(lines: string[], finalTickMs?: number, opts?: { prime?: string[] }): BuffsSnap {
  // Ensure the shared parser config has NO DB (Task #34): the W1–W6 windows assert the
  // pre-DB cast-timing/emote path. A prior DB-enabled test in the same process would
  // otherwise leave the DB installed and change parser output; clear it deterministically.
  installSpellDb(undefined)
  const mod = new BuffsModule()
  mod.reset()
  let seq = 0
  for (const raw of opts?.prime ?? []) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  if (finalTickMs != null) mod.onTick(finalTickMs)
  return mod.snapshot().state
}

/**
 * DB-ENABLED replay (Task #34): install the real scraped spell DB into the parser config
 * AND give it to the BuffsModule, then replay — exactly what production does. This
 * exercises the message-driven path (buffApply/buffWearOff from exact chat messages,
 * self-heal-by-buff applies, Permanent Illusion). Used by the W7–W9 golden windows.
 * The DB install is process-global, so DB-off tests (W1–W6) must not run interleaved with
 * the DB installed — they don't, because node:test runs files/tests sequentially and these
 * DB tests are in a separate file; still, we keep the plain replayBuffs above DB-free by
 * constructing its own module without a DB (the parser config is the only shared state).
 */
export function replayBuffsWithDb(
  lines: string[],
  finalTickMs?: number,
  opts?: { prime?: string[] }
): BuffsSnap {
  const db = loadSpellDb()
  installSpellDb(db)
  const mod = new BuffsModule(db)
  mod.reset()
  let seq = 0
  for (const raw of opts?.prime ?? []) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  if (finalTickMs != null) mod.onTick(finalTickMs)
  return mod.snapshot().state
}

/** Parse an EQ timestamp out of a raw fixture line (ms epoch), or 0. */
export function tsOf(raw: string): number {
  const ev = parseEvent(raw, 0)
  return ev ? ev.ts : 0
}

/** The ts of the last parseable line in a fixture — a natural "observe now" instant. */
export function lastTs(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = tsOf(lines[i])
    if (t > 0) return t
  }
  return 0
}

/** Find an active buff by (case-insensitive, rank-insensitive) spell name. */
export function findActive(snap: BuffsSnap, spellContains: string): BuffsSnap['active'][number] | undefined {
  const needle = spellContains.toLowerCase()
  return snap.active.find((a) => a.spell.toLowerCase().includes(needle))
}

/** All active spell names, lowercased — for "must NOT contain" assertions. */
export function activeNames(snap: BuffsSnap): string[] {
  return snap.active.map((a) => a.spell.toLowerCase())
}
