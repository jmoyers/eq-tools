import type { LogLine, LootEvent } from '../../shared/types'

/** Matches the EQ log prefix: "[Sat Aug 01 13:00:28 2026] message". */
const LINE_RE = /^\[(.+?)\]\s?(.*)$/

/**
 * Parse an EQ timestamp like "Sat Aug 01 13:00:28 2026" to epoch millis.
 * Reformatted to an ISO-ish string that Date can parse deterministically.
 */
export function parseEqTimestamp(stamp: string): number {
  // "Sat Aug 01 13:00:28 2026" -> "Aug 01 2026 13:00:28"
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})$/.exec(stamp.trim())
  if (!m) {
    const t = Date.parse(stamp)
    return Number.isNaN(t) ? 0 : t
  }
  const [, mon, day, time, year] = m
  const t = Date.parse(`${mon} ${day} ${year} ${time}`)
  return Number.isNaN(t) ? 0 : t
}

export function parseLine(raw: string): LogLine | null {
  const m = LINE_RE.exec(raw)
  if (!m) return null
  return { ts: parseEqTimestamp(m[1]), text: m[2], raw }
}

// ----- content matchers -----

// Real EQ Legends self-loot lines look like:
//   --You have looted a Mote of Infinitesimal Potential from Bazzzazzt's corpse.--
//   --You have looted an Efreeti War Staff from the Hand of Veeshan's corpse.--
// The optional " from <source> corpse" suffix must be stripped from the item name.
const LOOT_RE = /^--You have looted (?:an? )?(.+?)(?: from .+? corpse)?\.--$/
// Dashless fallback for servers/cases that omit the surrounding dashes.
const LOOT_RE_PLAIN = /^You have looted (?:an? )?(.+?)(?: from .+? corpse)?\.$/

/** Extract a self-loot event from a parsed line, or null. */
export function matchLoot(line: LogLine): LootEvent | null {
  const m = LOOT_RE.exec(line.text) ?? LOOT_RE_PLAIN.exec(line.text)
  if (!m) return null
  return { ts: line.ts, item: m[1].trim() }
}

// ----- combat matchers (stubs for the next milestone) -----
// Left intentionally minimal; the tailer already delivers every parsed line,
// so combat analysis can subscribe to `log:line` without reworking Phase 2.
export interface MeleeHit {
  ts: number
  attacker: string
  target: string
  amount: number
  verb: string
}

const MELEE_RE =
  /^(.+?) (hits|slashes|pierces|crushes|bashes|kicks|bites|claws|gores|mauls|punches|strikes|smashes|slices) (.+?) for (\d+) points? of damage\.$/

export function matchMelee(line: LogLine): MeleeHit | null {
  const m = MELEE_RE.exec(line.text)
  if (!m) return null
  return { ts: line.ts, attacker: m[1], verb: m[2], target: m[3], amount: Number(m[4]) }
}
