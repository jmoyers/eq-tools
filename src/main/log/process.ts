import type { LogLine, LootEvent, TurnInEvent } from '../../shared/types'
import { getRuleset } from './rulesets'
import { zoneTier } from './parse'

/** Cross-line state carried while processing a log (current zone, pending trade). */
export interface LogState {
  zone?: string
  pendingOffer: { npc: string; items: string[] } | null
}

export function newLogState(): LogState {
  return { zone: undefined, pendingOffer: null }
}

export interface LogHandlers {
  onLoot?(e: LootEvent): void
  onTurnIn?(e: TurnInEvent): void
  onKill?(mob: string, tier: number, ts: number): void
  onZone?(zone: string): void
  onLevelUp?(level: number, ts: number): void
}

/**
 * Dispatch a single parsed line through the active ruleset, updating state and
 * invoking handlers. Shared by the full-log scan and the live tailer so both stay
 * in sync.
 */
export function processLine(line: LogLine, state: LogState, h: LogHandlers, profileId?: string): void {
  const r = getRuleset(profileId)

  const zone = r.matchZone(line)
  if (zone) {
    state.zone = zone
    h.onZone?.(zone)
    return
  }

  const loot = r.matchLoot(line)
  if (loot) {
    loot.zone = state.zone
    h.onLoot?.(loot)
    return
  }

  const kill = r.matchKill(line)
  if (kill) {
    h.onKill?.(kill, zoneTier(state.zone ?? '').tier, line.ts)
    return
  }

  const level = r.matchLevelUp(line)
  if (level != null) {
    h.onLevelUp?.(level, line.ts)
    return
  }

  const offer = r.matchOffer(line)
  if (offer) {
    if (state.pendingOffer && state.pendingOffer.npc === offer.npc) state.pendingOffer.items.push(offer.item)
    else state.pendingOffer = { npc: offer.npc, items: [offer.item] }
    return
  }

  const doneNpc = r.matchTradeComplete(line)
  if (doneNpc) {
    if (state.pendingOffer && state.pendingOffer.npc === doneNpc) {
      h.onTurnIn?.({ ts: line.ts, npc: doneNpc, items: state.pendingOffer.items })
    }
    state.pendingOffer = null
  }
}
