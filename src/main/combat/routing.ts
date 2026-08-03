// ATTRIBUTION + ROUTING — where a parsed combat line lands. Extracted verbatim from
// engine.ts.
//
// `classify()` is the pure attribution decision (you / your pet / incoming / not our
// fight); the route* functions fold the line into the current encounter and the zone
// aggregate under that decision, refresh the presence axis, and push the timeline instant.
// Nothing here decides when a fight OPENS or CLOSES — that is lifecycle.ts.

import { idKey } from '../log/parser'
import { ensureEncounter } from './lifecycle'
import { ACTIVE_MS, type Encounter } from './encounter'
import type { DamageEvent, SourceRef } from './aggregate'
import type { HealAccum, HealInput } from './healing'
import type { EngineState } from './state'
import type { HealEvent, MissEvent, MissType, MitigationEvent, ResistEvent } from '../../shared/logEvents'
import type { DamageCategory, HealSourceKind, SourceKind } from '../../shared/combat'

/** How a damage event `A → B` is attributed given the pet-name set. */
export type Attribution =
  | { kind: 'out-you' }
  | { kind: 'out-pet'; petKey: string; petName: string; ambiguous: boolean }
  | { kind: 'incoming' }
  | { kind: 'ignore' }

/**
 * Pure attribution decision — the whole point is same-name twin handling.
 * `petNames` is a Set of canonical (lowercased) keys for ALL of your live pets,
 * charmed AND summoned: both attribute identically (as "your pet"), so this
 * function never needs to know which kind it is.
 *
 * Rules (decided with the user):
 *   You → pet-name : ALWAYS outgoing to a hostile twin (never dropped as FF).
 *   pet-name → You : ALWAYS incoming.
 *   pet-name → same-name (A==B, pet) : pet outgoing, but AMBIGUOUS
 *     (could be your pet hitting a hostile twin, or a hostile twin hitting your
 *      pet) — attribute to the pet and flag it.
 *   pet-name → other : pet outgoing (existing rule).
 *   You → other : outgoing.  other → You : incoming.  else ignore.
 */
export function classify(ev: DamageEvent, petNames: ReadonlySet<string>): Attribution {
  const aKey = idKey(ev.attacker)
  const bKey = idKey(ev.target)
  const aYou = aKey === 'you'
  const bYou = bKey === 'you'
  const aPet = !aYou && petNames.has(aKey)
  const bPet = !bYou && petNames.has(bKey)

  if (aYou) {
    // You → anything (including a pet name = a hostile twin) is outgoing.
    return bYou ? { kind: 'ignore' } : { kind: 'out-you' }
  }
  if (aPet) {
    // Your pet is the attacker.
    if (bYou) return { kind: 'incoming' } // pet-name → You is always incoming
    const ambiguous = aKey === bKey // same-name twin: can't tell pet from twin
    return { kind: 'out-pet', petKey: aKey, petName: ev.attacker, ambiguous }
  }
  if (bYou) return { kind: 'incoming' }
  // Attacker not friendly, target not you. If target is a pet, this is a mob
  // hitting your pet — not tracked as our incoming (existing behavior: ignore).
  void bPet
  return { kind: 'ignore' }
}

/**
 * The outgoing meter ROW for an attributed you/pet action — the (aggregate id, display
 * name, kind) triple the damage, miss and resist paths all need and all resolved
 * identically. A pet is resolved to its pet INSTANCE so twin pets stay distinct.
 */
function outSource(st: EngineState, attacker: string, isYou: boolean, ts: number): SourceRef {
  const kind: SourceKind = isYou ? 'you' : 'pet'
  if (isYou) return { id: 'you', name: 'You', kind }
  const petInst = st.world.petInstance(attacker) ?? st.world.resolve(attacker, ts, true)
  return { id: `pet:${petInst.instanceId}`, name: st.world.label(petInst), kind }
}

/** A hostile (or the pet) hit YOU. Resolve the attacker to an instance so twins are
 *  distinct in the incoming list, and lane the instant under the attacker's skill. */
function routeIncomingDamage(st: EngineState, enc: Encounter, ev: DamageEvent): void {
  const attInst = st.world.resolve(ev.attacker, ev.ts)
  const id = attInst.instanceId
  const name = st.world.label(attInst)
  enc.agg.addInc(id, name, ev)
  st.zoneAgg.addInc(id, name, ev)
  enc.engaged.add(id)
  enc.engagedSeen.set(id, ev.ts)
  // Timeline: an incoming instant lanes under the attacker's skill (its own row).
  st.pushTimeline(enc, {
    ts: ev.ts, lane: ev.skill, category: ev.category, amount: ev.amount,
    crit: ev.crit, modifiers: ev.modifiers, kind: 'enemy'
  })
  st.log(ev.ts, ev.dtype, 'enemy', `${name} → You  ${ev.amount}${ev.crit ? '*' : ''}  ${ev.skill}`)
}

/** You or your pet landed a hit. */
function routeOutgoingDamage(st: EngineState, enc: Encounter, ev: DamageEvent, at: Attribution): void {
  const isYou = at.kind === 'out-you'
  const src = outSource(st, ev.attacker, isYou, ev.ts)
  if (!isYou) {
    // The pet is trading blows with its target — record that engagement for the
    // death-disambiguation rule (case 2b).
    st.world.notePetEngagement(ev.attacker, idKey(ev.target))
  }
  const ambiguous = at.kind === 'out-pet' && at.ambiguous
  // POISON-TYPED DAMAGE (Task #64): the game states the damage TYPE on every typed spell
  // line ("… for 53 points of POISON damage by Asp Venom Strike."), so a poison lane is a
  // fact the log printed, not a name-matched guess. Outgoing only — a mob's poison DoT on
  // you is not a proc of ours. Additive: this is a second index over damage already counted,
  // so no total moves.
  if (ev.dclass === 'poison') {
    enc.agg.procs.addPoisonDamage(ev.skill, ev.amount)
    st.zoneAgg.procs.addPoisonDamage(ev.skill, ev.amount)
  }
  // Resolve the target to an instance. For a same-name ambiguous pet hit the
  // target is the HOSTILE twin (preferCharmed=false picks the hostile instance).
  const tgtInst = st.world.resolve(ev.target, ev.ts)
  const tgtId = tgtInst.instanceId
  const tgtName = st.world.label(tgtInst)
  enc.agg.addOut(src, ev, ambiguous)
  enc.agg.bumpTarget(tgtId, tgtName, ev.amount)
  st.zoneAgg.addOut(src, ev, ambiguous)
  st.zoneAgg.bumpTarget(tgtId, tgtName, ev.amount)
  enc.engaged.add(tgtId)
  enc.engagedSeen.set(tgtId, ev.ts)
  // LIVE-name tracking (Task #54): the current fight is named after whatever you're
  // presently swinging at (most recent outgoing target). Finalize switches to the
  // largest target (encounterName()); until then this drives the live label.
  enc.lastOutTarget = tgtName
  // Timeline: an outgoing instant lanes under the skill/spell name. `target` carries the
  // INSTANCE-RESOLVED defender label (same value bumpTarget aggregates under, so twins stay
  // distinct) — it drives the tooltip AND the dashboard's per-mob breakdown, which needs
  // per-event defenders to answer "what did I land on THIS mob". Miss/resist ticks already
  // carried it; damage ticks did not, which made per-mob damage underivable renderer-side.
  st.pushTimeline(enc, {
    ts: ev.ts, lane: ev.skill, category: ev.category, amount: ev.amount,
    crit: ev.crit, modifiers: ev.modifiers, kind: src.kind, target: tgtName
  })
  const cat = ambiguous ? 'ambiguous' : ev.dtype
  const mark = ambiguous ? '~' : ev.crit ? '*' : ''
  st.log(ev.ts, cat, src.kind, `${src.name} → ${tgtName}  ${ev.amount}${mark}  ${ev.skill}`)
}

export function route(st: EngineState, ev: DamageEvent): void {
  if (ev.amount <= 0) return
  const at = classify(ev, st.petNames)
  if (at.kind === 'ignore') return

  // Twin evidence: You→pet-name or same-name→same-name proves a hostile twin
  // co-exists with the pet; ensure the world model has a second instance so the
  // pet and the hostile twin resolve to distinct identities.
  if (at.kind === 'out-you' && st.petNames.has(idKey(ev.target))) {
    st.world.noteTwinEvidence(ev.target, ev.ts)
  }
  if (at.kind === 'out-pet' && at.ambiguous) {
    st.world.noteTwinEvidence(ev.target, ev.ts)
  }

  const enc = ensureEncounter(st, ev.ts)
  // Active-time accrual: add the gap since the previous attributed hit, capped at
  // ACTIVE_MS (standard meter convention — a long lull between hits counts as at
  // most one "active" tick, not the whole idle stretch). First hit adds 0.
  if (enc.prevDamageTs !== undefined) {
    enc.activeMs += Math.min(Math.max(0, ev.ts - enc.prevDamageTs), ACTIVE_MS)
  }
  enc.prevDamageTs = ev.ts
  enc.lastTs = ev.ts
  st.lastActivityTs = ev.ts
  // Zone-session timing (Task #54): first/last attributed damage in this zone session, for the
  // zone-session summary's disambiguation timing (start clock + relative age + span).
  if (st.zoneStartTs === 0) st.zoneStartTs = ev.ts
  st.zoneLastTs = ev.ts

  if (at.kind === 'incoming') {
    routeIncomingDamage(st, enc, ev)
    return
  }
  routeOutgoingDamage(st, enc, ev, at)
}

/** A miss YOU or your pet swung. */
function routeOutgoingMiss(
  st: EngineState,
  enc: Encounter | null,
  probe: { ts: number; attacker: string; target: string; mtype: MissType },
  isYou: boolean
): void {
  const src = outSource(st, probe.attacker, isYou, probe.ts)
  enc?.agg.addOutMiss(src, probe.mtype, 'Melee')
  st.zoneAgg.addOutMiss(src, probe.mtype, 'Melee')
  // Timeline: a miss tick lanes under "Melee" (hollow/red mark in the renderer). The
  // defender goes through defenderLabel() so it matches the INSTANCE label the damage
  // path writes — a raw name made every whiff at a twin pile onto a phantom bare row.
  const tgtName = enc ? st.defenderLabel(enc, probe.target, probe.ts) : probe.target
  if (enc) st.pushTimeline(enc, {
    ts: probe.ts, lane: 'Melee', category: 'melee', amount: 0, crit: false, kind: src.kind,
    outcome: 'miss', detail: probe.mtype, target: tgtName
  })
  st.log(probe.ts, 'miss', src.kind, `${src.name} ✕ ${tgtName} (${probe.mtype})`)
}

/**
 * Consume a miss (avoided swing) with the same attribution rules as damage.
 * We synthesize a zero-amount DamageEvent to reuse classify(); a melee skill
 * name isn't in the miss line, so avoided swings bucket under a "Melee" skill.
 */
export function routeMiss(st: EngineState, ev: MissEvent): void {
  const { ts, attacker, target, mtype } = ev
  const probe: DamageEvent = {
    ts, attacker, target, amount: 0, dtype: 'melee', skill: 'Melee', crit: false,
    category: 'melee', modifiers: []
  }
  const at = classify(probe, st.petNames)
  if (at.kind === 'ignore') return
  // A miss doesn't open or extend an encounter (closure is death/CC/fallback driven),
  // but it attaches to the in-progress fight if one is fresh (so hit% is per-fight).
  // Otherwise it still counts toward the zone aggregate.
  const enc = st.freshEncounter(ts)
  // PRESENCE (Task #55): a swing exchanged with an already-engaged mob proves it's
  // still in the fight even though nothing landed — the mob on an incoming miss, the
  // mob we whiffed at on an outgoing one. Liveness only; no damage timing moves.
  st.notePresence(at.kind === 'incoming' ? attacker : target, ts)

  if (at.kind === 'incoming') {
    const attInst = st.world.resolve(attacker, ts)
    const id = attInst.instanceId
    const name = st.world.label(attInst)
    enc?.agg.addIncMiss(id, name, mtype, 'Melee')
    st.zoneAgg.addIncMiss(id, name, mtype, 'Melee')
    // ABSORPTION (Task #59): an incoming swing absorbed by YOUR rune is also a mitigation
    // instant. `incoming` means the defender is YOU (a swing at your pet classifies as
    // 'ignore'), so this can't pick up a pet's or a mob's own rune. It is the SECOND source
    // for the same line family the parser's 'absorbSwing' mitigation event covers: whichever
    // of MISS_RE / SKIN_ABSORB_BLOW_RE claims the line, exactly ONE event is emitted, so the
    // two paths can never double-count — and the count survives the pending MISS_RE fix.
    if (mtype === 'absorb') {
      enc?.agg.heal.addAbsorbedSwing()
      st.zoneAgg.heal.addAbsorbedSwing()
    }
    st.log(ts, 'miss', 'enemy', `${name} ✕ You (${mtype})`)
    return
  }
  routeOutgoingMiss(st, enc, { ts, attacker, target, mtype }, at.kind === 'out-you')
}

/** YOUR (or your pet's) detrimental spell was resisted. */
function routeOutgoingResist(
  st: EngineState,
  enc: Encounter | null,
  cast: { ts: number; caster: string; target: string; spell: string; category: DamageCategory },
  isYou: boolean
): void {
  const src = outSource(st, cast.caster, isYou, cast.ts)
  enc?.agg.addOutResist(src, cast.spell, cast.category)
  st.zoneAgg.addOutResist(src, cast.spell, cast.category)
  // Same instance resolution as the miss/damage paths (see defenderLabel) — a resisted
  // cast at a twin must land on that twin's per-mob row, not a bare-named ghost.
  const tgtName = enc ? st.defenderLabel(enc, cast.target, cast.ts) : cast.target
  if (enc) st.pushTimeline(enc, {
    ts: cast.ts, lane: cast.spell, category: cast.category, amount: 0, crit: false, kind: src.kind,
    outcome: 'resist', detail: 'resisted', target: tgtName
  })
  st.log(cast.ts, 'resist', src.kind, `${src.name}'s ${cast.spell} resisted by ${tgtName}`)
}

/**
 * Consume a spell RESIST (Task #51 v2) — the caster-side analogue of a miss. Attribution:
 *   caster='you'  → outgoing 'you'.
 *   caster=<name> that resolves to one of our pets → outgoing pet.
 *   incoming (You resisted a mob's spell) → incoming, attributed to the mob (the caster).
 *   any other caster (a hostile mob's spell resisted by another mob) → IGNORED, mirroring
 *     classify()'s rule that non-you/pet attackers are out of scope for the meter.
 * The resisted spell is rank-normalized (spellCanonKey) ONLY for the lane display we keep;
 * we lane by the DISPLAY spell name so the resist tick lands in the same lane as landed
 * casts of that spell. Resists carry no damage → damage totals are untouched (tripwire).
 */
export function routeResist(st: EngineState, ev: ResistEvent): void {
  const { ts, caster, target, spell, incoming } = ev
  // Resisted detrimental spells are direct spells in the taxonomy (no melee/ds). A DoT
  // that's resisted is rare; we categorize all resists as 'spell' (the detrimental axis)
  // so they sort into the spell lanes — they carry no amount, so category totals are
  // unaffected. The lane is the display spell name.
  const category: DamageCategory = 'spell'
  // Attach to the in-progress fight if fresh (per-fight resist rate), else zone only —
  // mirrors routeMiss. A resist does not open/extend/close an encounter.
  const enc = st.freshEncounter(ts)
  // PRESENCE (Task #55): a resist names a live caster and a live resister. Refresh
  // whichever side is a HOSTILE we're already engaged with — the caster on an incoming
  // resist (the mob just cast at us), the target on our own resisted cast (the mob is
  // standing there shrugging it off). notePresence ignores anything not engaged, so the
  // you/pet side is a no-op — as is the third-party (mob-vs-mob) shape below, UNLESS
  // the resisting mob happens to be one of ours, in which case its presence is real
  // evidence even though the resist itself is dropped from the stats. Liveness only;
  // no damage timing moves.
  st.notePresence(incoming ? caster : target, ts)

  if (incoming) {
    // You resisted a mob's spell — attribute to the mob (incoming caster).
    const attInst = st.world.resolve(caster, ts)
    const id = attInst.instanceId
    const name = st.world.label(attInst)
    enc?.agg.addIncResist(id, name, spell, category)
    st.zoneAgg.addIncResist(id, name, spell, category)
    if (enc) st.pushTimeline(enc, {
      ts, lane: spell, category, amount: 0, crit: false, kind: 'enemy',
      outcome: 'resist', detail: 'resisted', target: 'You'
    })
    st.log(ts, 'resist', 'info', `You resisted ${name}'s ${spell}`)
    return
  }

  const casterKey = idKey(caster)
  const isYou = casterKey === 'you'
  const isPet = !isYou && st.petNames.has(casterKey)
  if (!isYou && !isPet) {
    // A hostile mob's spell resisted by another mob — out of scope for the meter.
    st.log(ts, 'resist', 'dropped', `${caster}'s ${spell} resisted by ${target}`)
    return
  }
  routeOutgoingResist(st, enc, { ts, caster, target, spell, category }, isYou)
}

/** One heal line, already keyed and attributed — the shared argument of both heal folds. */
interface HealRouting {
  ts: number
  target: string
  healerKey: string | null
  healerName: string | null
  heal: HealInput
}

/** Incoming heal to You (or the player by name) / your pet. */
function addFriendlyHeal(st: EngineState, r: HealRouting): void {
  const enc = st.freshEncounter(r.ts)
  const hk = r.healerKey ?? 'unknown'
  const healerName = r.healerName ?? 'Unknown'
  if (r.heal.amount > 0) {
    enc?.agg.addIncHeal(hk, healerName, r.heal.amount)
    st.zoneAgg.addIncHeal(hk, healerName, r.heal.amount)
  }
  // Healing ledger: rank by HEALER. Row id 'you' for self-heals keeps the healing meter's
  // primary row keyed the same way the damage meter's is.
  const kind: HealSourceKind =
    hk === 'you' ? 'you' : st.petNames.has(hk) ? 'pet' : 'other'
  const id = hk === 'you' ? 'you' : `heal:${hk}`
  enc?.agg.heal.addFriendly(id, healerName, kind, r.heal)
  st.zoneAgg.heal.addFriendly(id, healerName, kind, r.heal)
}

/** Heal on a hostile instance we're currently engaged with → enemy healing. */
function addHostileHeal(st: EngineState, r: HealRouting): void {
  const inst = st.world.resolve(r.target, r.ts)
  const enc = st.current
  if (enc?.engaged.has(inst.instanceId)) {
    if (r.heal.amount > 0) {
      enc.agg.addEnemyHeal(inst.instanceId, st.world.label(inst), r.heal.amount)
      st.zoneAgg.addEnemyHeal(inst.instanceId, st.world.label(inst), r.heal.amount)
    }
    // Counter-healing ledger, ranked by the HEALER (a mob healing itself is its own row).
    const hk = r.healerKey ?? 'unknown'
    const healerName = r.healerName ?? 'Unknown'
    enc.agg.heal.addHostile(`heal:${hk}`, healerName, r.heal)
    st.zoneAgg.heal.addHostile(`heal:${hk}`, healerName, r.heal)
    // PRESENCE (Task #55): a heal on an engaged hostile proves BOTH ends are still in
    // the fight — the mob receiving it, and (when a second mob cast it) the healer. The
    // real case this came from: "Baron Telyx V`Zher healed Soldier of V`Zher for 175" —
    // the Baron had landed nothing for seconds while healing his friend, and the old
    // damage-only liveness rule had already written him off. Liveness only; no damage
    // timing moves (enemy healing is an annotation, never damage).
    st.notePresenceId(enc, inst.instanceId, r.ts)
    if (r.healerName) st.notePresence(r.healerName, r.ts)
  }
}

/**
 * Consume a heal. Three things matter for combat stats:
 *   - target is an engaged HOSTILE instance → count as "enemy healing" (it undoes
 *     our damage; effective-DPS context per encounter + zone).
 *   - target is You or one of your pets → count as incoming healing (with top
 *     healers).
 *   - EITHER of those also folds into the meter-grade HEALING ledger (Task #59):
 *     per healer, per spell, with crit / min / max / derived overheal.
 * Other heals (party members healing each other, unrelated NPCs) are ignored for
 * aggregation — the log gives no faction for an arbitrary name.
 *
 * ZERO-EFFECTIVE heals (`… for 0 (2) hit points …`, 1,857 in the real log) are the overheal
 * evidence, so the healing ledger takes them; the pre-existing `enemyHeal`/`incHeal` maps keep
 * their original `amount <= 0` gate so their totals AND their healer lists stay byte-identical.
 */
export function routeHeal(st: EngineState, ev: HealEvent): void {
  const { ts, target, amount } = ev
  if (amount < 0) return
  const healerName = ev.healer ?? null
  const heal: HealInput = { amount, rawAmount: ev.rawAmount, spell: ev.spell, crit: ev.crit }
  const tKey = idKey(target)
  const healerKey = healerName !== null ? idKey(healerName) : null
  const isYouTgt = tKey === 'you'
  const isPetTgt = !isYouTgt && st.petNames.has(tKey)

  st.learnPlayerKey(healerKey, tKey, isYouTgt, isPetTgt)
  const isPlayerTgt = st.playerKey !== undefined && tKey === st.playerKey

  const r: HealRouting = { ts, target, healerKey, healerName, heal }
  if (isYouTgt || isPetTgt || isPlayerTgt) {
    addFriendlyHeal(st, r)
    return
  }
  addHostileHeal(st, r)
}

/**
 * Consume an ABSORPTION / MITIGATION line (Task #59) — damage prevented, not hit points
 * restored, so it never touches a DAMAGE total. It does reach the HEALING total: buildHealingView
 * folds the rune counters in as a row classified 'absorbed' (the two count-only families carry
 * no amount and so reach no total at all). Folded into the current encounter (when one is open
 * and still fresh) and the zone aggregate, exactly like an incoming heal.
 *
 * These lines NEVER open, join or extend an encounter and never move the damage timeline —
 * the same rule miss/resist follow (AGENTS.md world-model law 8). A rune ticking while you
 * stand around out of combat belongs to the zone lane and nowhere else.
 */
export function routeMitigation(st: EngineState, ev: MitigationEvent): void {
  const enc = st.freshEncounter(ev.ts)
  const apply = (a: { heal: HealAccum }): void => {
    if (ev.mtype === 'rune') {
      // Defensive: the amount is required by the regex, but keep the ledger clean if a future
      // shape ever omits it — a rune with no amount is a count we cannot value.
      if (ev.amount != null && ev.amount > 0) a.heal.addRune(ev.amount)
    } else if (ev.mtype === 'absorbSwing') a.heal.addAbsorbedSwing()
    else a.heal.addAbsorbedDamageShield()
  }
  if (enc) apply(enc.agg)
  apply(st.zoneAgg)
}
