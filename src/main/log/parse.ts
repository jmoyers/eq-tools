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
// Capture the item and the source mob (from "<mob>'s corpse").
const LOOT_RE = /^--You have looted (?:an? )?(.+?)(?: from (.+?) corpse)?\.--$/
// Dashless fallback for servers/cases that omit the surrounding dashes.
const LOOT_RE_PLAIN = /^You have looted (?:an? )?(.+?)(?: from (.+?) corpse)?\.$/

function cleanMob(s?: string): string | undefined {
  if (!s) return undefined
  return s.replace(/['`’]s$/i, '').trim() || undefined
}

/** Extract a self-loot event from a parsed line, or null. */
export function matchLoot(line: LogLine): LootEvent | null {
  const m = LOOT_RE.exec(line.text) ?? LOOT_RE_PLAIN.exec(line.text)
  if (!m) return null
  return { ts: line.ts, item: m[1].trim(), source: cleanMob(m[2]) }
}

// "You have entered The Oasis of Marr."
const ZONE_RE = /^You have entered (.+?)\.$/
export function matchZone(line: LogLine): string | null {
  const m = ZONE_RE.exec(line.text)
  return m ? m[1].trim() : null
}

// Kills, for drop-rate denominators:
//   "You have slain a spectre!"
//   "Maestro of Rancor has been slain by Innoruuk`s Chosen!"
const SLAIN_SELF_RE = /^You have slain (.+?)!$/
const SLAIN_BY_RE = /^(.+?) has been slain by .+?!$/
export function matchKill(line: LogLine): string | null {
  const self = SLAIN_SELF_RE.exec(line.text)
  if (self) return self[1].trim()
  const by = SLAIN_BY_RE.exec(line.text)
  if (by && !/^you\b/i.test(by[1])) return by[1].trim()
  return null
}

// Turn-ins: "You offered 1 Sphinx Claw to Dason Goldblade." then
//           "You complete the trade with Dason Goldblade."
const OFFER_RE = /^You offered [\d,]+ (.+?) to (.+?)\.$/
export function matchOffer(line: LogLine): { item: string; npc: string } | null {
  const m = OFFER_RE.exec(line.text)
  return m ? { item: m[1].trim(), npc: m[2].trim() } : null
}

const TRADE_DONE_RE = /^You complete the trade with (.+?)\.$/
export function matchTradeComplete(line: LogLine): string | null {
  const m = TRADE_DONE_RE.exec(line.text)
  return m ? m[1].trim() : null
}

// "You have gained a level! Welcome to level 26!"
const LEVEL_RE = /^You have gained a level! Welcome to level (\d+)!$/
export function matchLevelUp(line: LogLine): number | null {
  const m = LEVEL_RE.exec(line.text)
  return m ? Number(m[1]) : null
}

// "You have gained an ability point!  You now have 7 ability points."
// "You have gained 2 ability point(s)!  You now have 3 ability point(s)."
const AA_RE = /^You have gained (an|\d+) ability point(?:\(s\))?!\s+You now have (\d+) ability point/
export function matchAA(line: LogLine): { amount: number; nowHave: number } | null {
  const m = AA_RE.exec(line.text)
  if (!m) return null
  return { amount: m[1] === 'an' ? 1 : Number(m[1]), nowHave: Number(m[2]) }
}

// EQ Legends encodes instance difficulty in the zone name:
//   base (no suffix) = d0, "(Awakened)" = d1, "(Adaptive)" = d2,
//   "(Fused)" = d3, "(Refined)" = d4. Also strips "- Solo"/"- Group N".
const TIER_ADJ: Record<string, number> = { awakened: 1, adaptive: 2, fused: 3, refined: 4 }
export const TIER_LABELS = ['d0', 'd1 · Awakened', 'd2 · Adaptive', 'd3 · Fused', 'd4 · Refined']

export function zoneTier(zone: string): { base: string; tier: number } {
  const adj = /\(([A-Za-z]+)\)\s*$/.exec(zone)
  const tier = adj ? TIER_ADJ[adj[1].toLowerCase()] ?? 0 : 0
  const base = zone
    .replace(/\s*-\s*(Solo|Group)\b.*$/i, '')
    .replace(/\s+\d+\s*\([^)]*\)\s*$/, '')
    .replace(/\s+\([^)]*\)\s*$/, '')
    .trim()
  return { base, tier }
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
