// Pure boss-status derivation shared by BossView (cards + confetti) and App (the
// app-wide "raid target defeated" snackbar), so both agree on exactly what counts
// as a defeat and when a NEW defeat happened.

import type { KillMap, RaidTarget } from '@shared/types'

export interface TargetStatus {
  target: RaidTarget
  killed: boolean
  bestTier: number
  count: number
  firstTs: number
  lastTs: number
}

/**
 * Canonical match key: lowercase + strip a single leading article. EQ writes the
 * same mob with a capitalized article at sentence start ("A thunder spirit
 * princess" on slain-by lines) and lowercase mid-sentence, and roster `match`
 * names ("Thunder Spirit Princess") carry no article at all — so both sides must
 * be article-insensitive or the princess (killed by a charmed pet, hence a
 * slain-by line) reads as undefeated.
 */
function matchKey(name: string): string {
  return name.toLowerCase().replace(/^(?:an?|the) /, '').trim()
}

/**
 * Re-key a KillMap by the article-insensitive match key. Kill-map keys are already
 * canonical lowercase (kills module keys via idKey), so this only strips leading
 * articles; if two article variants ever collide, the higher-count entry wins.
 */
export function lowerKillMap(kills: KillMap): KillMap {
  const m: KillMap = {}
  for (const [name, info] of Object.entries(kills)) {
    const k = matchKey(name)
    const prev = m[k]
    if (!prev || info.count > prev.count) m[k] = info
  }
  return m
}

/** Fold a target's roster `match` names against the (article-insensitive) kill map. */
export function statusFor(target: RaidTarget, killByLower: KillMap): TargetStatus {
  let bestTier = 0
  let count = 0
  let firstTs = 0
  let lastTs = 0
  let killed = false
  for (const name of target.match) {
    const info = killByLower[matchKey(name)]
    if (info) {
      killed = true
      bestTier = Math.max(bestTier, info.bestTier)
      count += info.count
      firstTs = firstTs ? Math.min(firstTs, info.firstTs) : info.firstTs
      lastTs = Math.max(lastTs, info.lastTs)
    }
  }
  return { target, killed, bestTier, count, firstTs, lastTs }
}

export function allStatuses(targets: RaidTarget[], kills: KillMap): TargetStatus[] {
  const lower = lowerKillMap(kills)
  return targets.map((t) => statusFor(t, lower))
}

/**
 * ANY roster-boss kill (Task #24): a target whose total kill `count` increased
 * since the previous snapshot — including a REPEAT kill at the same-or-lower tier
 * (which `newDefeats` deliberately ignores). Drives confetti + card flash +
 * snackbar for every kill. Compares a previous status snapshot (keyed by target
 * name) to the current one; returns the targets that were just killed again.
 */
export function bossKills(
  prev: Map<string, TargetStatus>,
  next: TargetStatus[]
): TargetStatus[] {
  const out: TargetStatus[] = []
  for (const s of next) {
    if (!s.killed) continue
    const before = prev.get(s.target.name)
    const prevCount = before?.count ?? 0
    if (s.count > prevCount) out.push(s)
  }
  return out
}

/**
 * A NEW defeat = a boss that just went from unkilled → killed (prev count 0), or
 * whose best instance tier increased. Compares a previous status snapshot (keyed
 * by target name) to the current one; returns the targets that newly qualify.
 * This is the subset of `bossKills` that additionally earns the bossDefeat sound —
 * a first defeat at a new tier only, so repeat kills stay silent (Task #24).
 */
export function newDefeats(
  prev: Map<string, TargetStatus>,
  next: TargetStatus[]
): TargetStatus[] {
  const out: TargetStatus[] = []
  for (const s of next) {
    if (!s.killed) continue
    const before = prev.get(s.target.name)
    const wasKilled = before?.killed ?? false
    const prevTier = before?.bestTier ?? 0
    if (!wasKilled || s.bestTier > prevTier) out.push(s)
  }
  return out
}
