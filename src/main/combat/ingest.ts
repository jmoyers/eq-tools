// THE INGEST SWITCH — one canonical LogEvent in, one state transition out. Extracted
// verbatim from engine.ts and split along the three event FAMILIES the original switch
// already grouped its cases into:
//
//   ingestWorld    — epoch / zone / charm / petClaim / uncharm / cc / death: the entity and
//                    segmentation lifecycle.
//   ingestCombat   — damage / heal / mitigation / miss / resist: the meter itself.
//   ingestModifier — stance / invocation / coats / procs / dispel landings: annotations.
//
// The families are disjoint on `ev.kind`, so the chain is exactly the old switch: each tries
// its own cases and reports whether it consumed the event. Any other kind is ignored.

import { idKey } from '../log/parser'
import { damageCategory } from './taxonomy'
import { evalClosure, ensureEncounter, finalizeCurrent, finalizeZoneSession } from './lifecycle'
import { classify, route, routeHeal, routeMiss, routeMitigation, routeResist } from './routing'
import {
  applyStance,
  routeCoat,
  routeDispelLanding,
  routeDry,
  routeProc,
  routeProcBuffApply,
  routeProcBuffWearOff
} from './procRouting'
import { QUICK_BUFF_AA, isCastless, isCastlessHeal, noteCast, procEligibleDamage } from './procDetect'
import { CC_HOLD_MS } from './encounter'
import { Agg, type DamageEvent } from './aggregate'
import type { WindowFold } from './procWindows'
import type { EngineState } from './state'
import type {
  CcEvent,
  DamageEventE,
  DeathEvent,
  HealEvent,
  LogEvent,
  MissEvent,
  MitigationEvent
} from '../../shared/logEvents'

/**
 * Crowd control (mez/root, not charm). Evaluate any pending closure at this
 * ts first (a CC on a fresh pull shouldn't attach to a stale fight), then
 * mark the CC'd instance engaged + CC-held so the encounter stays OPEN across
 * the mez-and-wait gap. A CC'd instance counts as "alive" for closure.
 */
function ingestCc(st: EngineState, ev: CcEvent): void {
  evalClosure(st, ev.ts)
  const inst = st.world.resolve(ev.mob, ev.ts)
  if (inst.instanceId === 'you') return
  const enc = ensureEncounter(st, ev.ts)
  enc.engaged.add(inst.instanceId)
  enc.engagedSeen.set(inst.instanceId, ev.ts)
  enc.ccActiveUntil.set(inst.instanceId, ev.ts + CC_HOLD_MS)
  st.lastActivityTs = ev.ts
  const tag = ev.refresh ? 'refresh' : 'applied'
  st.log(ev.ts, 'cc', 'info', `✜ CC ${tag}: ${st.world.label(inst)}${ev.spell ? ` (${ev.spell})` : ''}`)
}

function ingestDeath(st: EngineState, ev: DeathEvent): void {
  const key = idKey(ev.name)
  const killerKey = ev.bySelf ? 'you' : ev.killer ? idKey(ev.killer) : undefined
  const res = st.world.death(ev.name, ev.ts, killerKey)
  // Keep the fast pet-name set in lockstep: only drop the name from the
  // set when NO pet instance of it remains live.
  if (!st.world.petInstance(ev.name)) st.petNames.delete(key)
  // The retired instance stays in `engaged` (so an in-fight heal on the corpse
  // still counts) — closure consults world.isRetired(), not set membership.
  // Clear any CC hold on the dead instance so it can't keep the fight open.
  if (res.retired) st.current?.ccActiveUntil.delete(res.retired.instanceId)
  const petNote = res.wasPet ? ' (pet)' : ''
  const ambNote = res.ambiguous ? ' ~ambiguous' : ''
  st.log(ev.ts, 'death', 'info', `☠ ${ev.name} died${petNote}${ambNote} — ${res.reason}`)
}

/** epoch / zone / charm / petClaim / uncharm / cc / death. Returns true if consumed. */
function ingestWorld(st: EngineState, ev: LogEvent): boolean {
  switch (ev.kind) {
    case 'epoch': {
      // Character rebirth (Task #49): a same-name character was wiped/recreated. The DPS
      // meter is session-scoped (the user's live encounter history + the zone aggregate,
      // reset on every zone line already), so we deliberately KEEP it — a rebirth is not a
      // reason to lose the current session's fights. But the beta character's charmed/pet
      // world state is stale, so finalize any open fight and clear the pet sets as a cheap
      // safety (a zone line after the rebirth login would clear it anyway; this makes the
      // boundary explicit and independent of that ordering).
      finalizeCurrent(st)
      st.petNames = new Set()
      st.world.reset()
      // An epoch severs every active-state span: the beta character's stances, coats and buffs
      // are not this character's. CENSORED, never 'observed' (proc-analytics §3.1 boundaries).
      st.stateTimeline.censorAll(ev.ts)
      return true
    }
    case 'zone': {
      finalizeCurrent(st)
      // Freeze the just-left zone's aggregate into the capped history (Task #54) BEFORE
      // resetting, so its overall meter stays selectable. A zone session with no attributed
      // damage is dropped (nothing to show), matching the empty-encounter drop rule.
      finalizeZoneSession(st)
      st.zone = ev.zone
      st.zoneAgg = new Agg()
      st.zoneFinalizedMs = 0
      st.zoneActiveMs = 0
      st.zoneStartTs = 0
      st.zoneLastTs = 0
      // Charm cannot survive a zone transition, and hostile mobs don't follow —
      // both are retired. SUMMONED class pets DO persist across zones (real-log
      // verified), so world.zone() returns the survivors (summoned pets only) and we
      // rebuild the fast pet-name set from them — which keeps a summoned pet fully
      // attributable after zoning while dropping stale charmed/hostile names.
      const survivors = st.world.zone(ev.ts)
      st.petNames = new Set(survivors.map((i) => i.nameKey))
      st.log(ev.ts, 'zone', 'info', `▸ entered ${ev.zone}`)
      return true
    }
    case 'charm': {
      const inst = st.world.charm(ev.mob, ev.ts)
      st.petNames.add(idKey(ev.mob))
      st.log(ev.ts, 'charm', 'info', `⚡ charmed ${st.world.label(inst)} [${inst.instanceId}]`)
      return true
    }
    case 'petClaim': {
      // A pet addressed you as master → the named entity is your pet. Bind it as
      // a SUMMONED pet (idempotent; a charmed mob sends this tell too — the real log
      // shows both — and world.claim() leaves an already-charmed instance's petKind
      // alone, so a charmed pet is never reclassified as summoned). This is the ONLY
      // binding signal for random-named class pets. It adds the name to the
      // ATTRIBUTION set only — a summoned pet is NEVER a charmed pet.
      const inst = st.world.claim(ev.name, ev.ts)
      st.petNames.add(idKey(ev.name))
      st.log(ev.ts, 'pet', 'info', `⚡ pet claim ${st.world.label(inst)} [${inst.instanceId}]`)
      return true
    }
    case 'uncharm': {
      st.world.uncharm(ev.mob, ev.ts)
      st.petNames.delete(idKey(ev.mob))
      st.log(ev.ts, 'uncharm', 'info', `✕ charm broke: ${ev.mob}`)
      return true
    }
    case 'cc':
      ingestCc(st, ev)
      return true
    case 'death':
      ingestDeath(st, ev)
      return true
    default:
      return false
  }
}

/** The engine's internal damage record for a canonical `damage` LogEvent (attacker already
 *  proven non-null by the caller). */
function toDamageEvent(ev: DamageEventE, attacker: string): DamageEvent {
  const modifiers = ev.modifiers ?? []
  return {
    ts: ev.ts, attacker, target: ev.target, amount: ev.amount,
    dtype: ev.dtype, dclass: ev.dclass, skill: ev.skill, crit: ev.crit, modifier: ev.modifier,
    // Prefer the parse-time category; derive as a fallback so pre-#51 events (or
    // any path that omits it) still aggregate under the right axis.
    category: ev.category ?? damageCategory(ev.dtype, modifiers),
    modifiers
  }
}

/** The classification-ring line for an absorption/mitigation event. */
function mitigationLine(ev: MitigationEvent): string {
  if (ev.mtype === 'rune') return `⛊ rune +${ev.amount} absorption`
  if (ev.mtype === 'absorbSwing') return `⛊ absorbed ${ev.source ?? '?'}'s blow`
  return `⛊ absorbed ${ev.source ?? '?'}'s damage shield`
}

/**
 * PROC ANALYTICS for one attributed damage line (docs/plans/proc-analytics.md §4).
 *
 * PURELY ADDITIVE, and it must stay that way: everything below is a COUNT or an INDEX over
 * damage the meter already counted. Nothing here calls an `add*` that moves a damage total,
 * so every total stays byte-identical (law 8's tripwire).
 *
 * `activeDeltaMs` is the ENGINE'S OWN per-hit active-time accrual, measured by the caller as
 * the difference route() just made to `Encounter.activeMs` — not a re-derivation. That is what
 * "reuse the active-time definition verbatim" means here: the two can never drift, because
 * there is only one computation.
 *
 * The three judgements, each with its gate:
 *   - OUTGOING-YOURS only. A pet's damage is not your swing and not your proc.
 *   - SWING = a melee or slay HIT (misses are added by the miss path). Slay counts because a
 *     Slay Undead proc rides an ordinary swing — it IS a swing.
 *   - PROC = a `dtype: 'spell'` line with no own cast behind it. `dot` is never eligible (its
 *     ticks are cast-detached by construction), which is the one gate that keeps this
 *     inference honest.
 */
interface DamageAnalytics {
  /** Attributed to YOU (not a pet, not incoming). */
  mine: boolean
  /** 1 when this was one of your logged swing attempts. */
  swing: number
  /** A cast-less spell effect of yours. */
  proc: boolean
}

/** The three judgements, separated from the accumulation so each stays readable. `null` means
 *  "the meter ignored this line", in which case the ledgers must ignore it too. */
function damageAnalytics(st: EngineState, ev: DamageEvent): DamageAnalytics | null {
  if (ev.amount <= 0) return null
  const at = classify(ev, st.petNames)
  if (at.kind === 'ignore') return null
  if (at.kind !== 'out-you') return { mine: false, swing: 0, proc: false }
  const swing = ev.category === 'melee' || ev.category === 'slay' ? 1 : 0
  const proc = procEligibleDamage(ev.dtype) && isCastless(st.recentCasts, ev.skill, ev.ts)
  return { mine: true, swing, proc }
}

/**
 * Fold one judgement into BOTH ledgers this segment has — the zone aggregate and the fresh
 * encounter, if any. Every proc counter is written through here so the two can never disagree
 * about a line, and so the per-state split below is fed from exactly one place.
 *
 * `active` is the state timeline's O(1) open set, read at the event's own instant. It is passed
 * (not re-read) into every accumulator, because the whole point of folding on ingest is that
 * "what was on when this fired" is knowable only now.
 */
function foldBoth(st: EngineState, ts: number, fold: (agg: Agg, active: ReadonlySet<string>) => void): void {
  const active = st.stateTimeline.active
  const enc = st.freshEncounter(ts)
  fold(st.zoneAgg, active)
  if (enc) fold(enc.agg, active)
}

function foldDamageAnalytics(st: EngineState, ev: DamageEvent, activeDeltaMs: number): void {
  const a = damageAnalytics(st, ev)
  if (!a) return
  const fold: WindowFold = {
    ts: ev.ts,
    activeDeltaMs,
    outDamage: a.mine ? ev.amount : 0,
    procDamage: a.proc ? ev.amount : 0,
    swings: a.swing
  }
  foldBoth(st, ev.ts, (agg, active) => {
    agg.windows.fold(fold, active)
    agg.procs.addActiveMs(activeDeltaMs, active)
    if (a.swing) agg.procs.addSwing(active)
    if (a.proc) agg.procs.addSpellProc({ spell: ev.skill, amount: ev.amount, isHeal: false, active })
  })
}

/** A heal with no own cast behind it — the healing half of the same inference (`Lifetap
 *  Strike`, 1,814 procs / 52,861 hit points restored, zero casts, in the real log). Gated to
 *  YOUR OWN heals: another player's cast-less heal is their proc, not yours — and to
 *  `isCastlessHeal`, which additionally refuses HoT ticks and Quick Buff bursts (see the two
 *  sweeps in procDetect's header). */
function foldHealAnalytics(st: EngineState, ev: HealEvent): void {
  const spell = ev.spell
  if (!spell || idKey(ev.healer ?? '') !== 'you') return
  if (!isCastlessHeal(st.recentCasts, { spell, ts: ev.ts, overTime: ev.overTime === true, quickBuffTs: st.quickBuffTs })) return
  foldBoth(st, ev.ts, (agg, active) => {
    agg.procs.addSpellProc({ spell, amount: ev.amount, isHeal: true, active })
  })
}

/** YOUR avoided swing. It is still a swing ATTEMPT, and the mechanical proc denominator is
 *  attempts — a proc that cannot fire on a miss still had the chance to. */
function foldMissAnalytics(st: EngineState, ev: MissEvent): void {
  if (idKey(ev.attacker) !== 'you') return
  foldBoth(st, ev.ts, (agg, active) => {
    agg.windows.fold({ ts: ev.ts, swings: 1 }, active)
    agg.procs.addSwing(active)
  })
}

/** One canonical `damage` line: route it, then index it. */
function ingestDamage(st: EngineState, ev: DamageEventE): void {
  // Caster-less other-player DoTs (attacker:null) are not our fight.
  if (ev.attacker === null) {
    st.log(ev.ts, 'other', 'dropped', ev.raw)
    return
  }
  // Close any pending encounter at this ts BEFORE routing, so attributed damage
  // after a closure starts a fresh encounter rather than reviving the old one.
  evalClosure(st, ev.ts)
  const dmgEv = toDamageEvent(ev, ev.attacker)
  // Read the engine's active-time clock either side of route(): the DIFFERENCE is the exact
  // capped-gap delta it accrued for this hit. A fresh encounter (route() opened one)
  // contributes 0, which is precisely what routing.ts does for a first hit.
  const encBefore = st.current
  const activeBefore = encBefore?.activeMs ?? 0
  route(st, dmgEv)
  const delta = st.current === encBefore ? (st.current?.activeMs ?? 0) - activeBefore : 0
  foldDamageAnalytics(st, dmgEv, delta)
}

/** damage / heal / mitigation / miss / resist. Returns true if consumed. */
function ingestCombat(st: EngineState, ev: LogEvent): boolean {
  switch (ev.kind) {
    case 'damage':
      ingestDamage(st, ev)
      return true
    case 'heal':
      routeHeal(st, ev)
      foldHealAnalytics(st, ev)
      st.log(ev.ts, 'heal', 'info', `+ ${ev.healer ?? '?'} → ${ev.target} ${ev.amount}${ev.spell ? ` (${ev.spell})` : ''}`)
      return true
    case 'mitigation':
      routeMitigation(st, ev)
      st.log(ev.ts, 'mitigation', 'info', mitigationLine(ev))
      return true
    case 'miss':
      routeMiss(st, ev)
      foldMissAnalytics(st, ev)
      return true
    case 'resist':
      routeResist(st, ev)
      return true
    default:
      return false
  }
}

/** stance / invocation / coats / procs / dispel landings. */
function ingestModifier(st: EngineState, ev: LogEvent): void {
  switch (ev.kind) {
    case 'stanceChange':
      applyStance(st, 'stance', ev.stance, ev.ts)
      st.log(ev.ts, 'stance', 'info', `▸ stance: ${ev.stance}`)
      return
    case 'invocationChange':
      applyStance(st, 'invocation', ev.invocation, ev.ts)
      st.log(ev.ts, 'invocation', 'info', `▸ invocation: ${ev.invocation}`)
      return
    case 'poisonCoat':
      routeCoat(st, ev)
      return
    case 'poisonDry':
      routeDry(st, ev)
      return
    case 'poisonProc':
      routeProc(st, ev)
      return
    case 'buffApply': {
      // DISPEL LANDINGS on the mobs we are fighting (Task #64) — the "counts of spells (like
      // the dispel variants and such)" ledger. Message-driven and gated to DISPEL_FAMILY; it
      // names NO caster, and the view labels it accordingly.
      const names = ev.candidates.map((c) => c.name)
      routeDispelLanding(st, ev.ts, ev.target, names)
      // The SAME landing stream also carries the tracked proc-buff spans (§3.2). Two disjoint
      // curated gates over one event: DISPEL_FAMILY names a lane on a mob, PROC_BUFF_CATALOG
      // opens a self-buff span. Neither can consume the other's lines.
      routeProcBuffApply(st, ev.ts, ev.target, names)
      return
    }
    case 'buffWearOff':
      // The rare PRINTED end of a tracked proc buff — the only path that can close a buff span
      // 'observed'. In the real log this fires once against 97 landings, which is exactly why
      // EdgeEvidence exists.
      routeProcBuffWearOff(st, ev.ts, ev.candidates)
      return
    case 'aaActivate':
      // THE QUICK BUFF BURST (procDetect's second gate). This AA re-applies every memorized
      // buff and prints their LANDINGS ONLY — no `You begin casting` for any of them — so
      // without this line 254 buff landings in the real log read as cast-less procs. Recording
      // the activation is the whole fix: the burst is cast evidence in a different shape.
      if (idKey(ev.name) === QUICK_BUFF_AA) st.quickBuffTs = ev.ts
      return
    case 'castBegin':
      // The cast-attribution window's only input (§4.1). Only the PLAYER prints
      // `You begin casting <Spell>.`, so this map can never be polluted by a mob's or another
      // player's cast — which is what lets a cast-less effect line be read as a proc.
      noteCast(st.recentCasts, ev.spell, ev.ts)
      return
    case 'playerDeath':
      // A boundary that SEVERS every span. The end is unknowable, so it is 'censored' — never
      // 'observed', and never a fabricated expiry (law 1).
      st.stateTimeline.censorAll(ev.ts)
      // BLADE COATS DIE WITH YOU (corrected 2026-08-04). eqlwiki's Rogue page states poisons
      // "remain active until class swap or death", and the log corroborates it without ever
      // printing a dry line for it: `Your Paralytic Poison spell did not take hold. (Blocked by
      // Neurotoxic Poison.)` at 20:01:47 Aug 03, then — after `You have been slain by a rock
      // golem!` at 21:01:40 — the SAME Paralytic coat lands cleanly at 21:15:23. Something
      // removed Neurotoxic in between and no line said so. Until this, the slot state and the
      // span timeline disagreed at exactly this instant: censorAll ended the coat spans while
      // `coatUtility` kept naming a poison the corpse no longer had, which made the header show
      // a dead coat and `slowExpected` true for pulls that could not slow.
      // NOT modeled, and stated rather than guessed: the wiki's other clearer, a CLASS SWAP.
      // The combat engine sees no loadout signal, so a swap leaves the coats standing.
      st.coatUtility = undefined
      st.coatCombat = []
      return
    default:
      return
  }
}

/**
 * Fold one canonical LogEvent into the state machine. The engine consumes
 * damage/charm/uncharm/death/zone directly (the old internal parse call path is
 * gone). heal/miss are parse-only for now — logged to the classification ring
 * for visibility, but not aggregated. Any other kind is ignored.
 *
 * `live` drives the classification ring (recording): historical replay events
 * mutate state silently; live events are also ring-logged.
 */
export function ingestEvent(st: EngineState, ev: LogEvent, live: boolean): void {
  if (live) {
    st.recording = true
    st.hydrating = false
  }
  if (ingestWorld(st, ev)) return
  if (ingestCombat(st, ev)) return
  ingestModifier(st, ev)
}
