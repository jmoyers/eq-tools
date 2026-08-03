// buffs module (Task #19; latency+coverage Task #30; ENTITY-AWARE Task #32; message-driven
// Task #33/#34; 'pet' DE-SPECIALIZED Task #35).
//
// A log-mined buff/debuff-duration model AND a small who/what/when simulation of which
// ENTITY each buff is bound to. All state is derived from events.
//
// THIS FILE is the EqModule surface: it turns log events into calls on the three
// collaborators the model is factored into, and builds the snapshot/delta the UI reads.
//   • buffsInstances.ts — the live (spell, entity) instances: pending / open / active,
//     and every mutation + censoring path over them.
//   • buffsStats.ts     — per-SPELL learned knowledge: duration samples, class, recency, DB.
//   • buffsEntities.ts  — the pet/charm/target identity slots (the who/what).
//   • buffsView.ts / buffsShapes.ts — the ActiveBuff projection and the shared constants.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TASK #35 MODEL (read this before touching anything). A buff INSTANCE is a pair
//   (spell, targetEntity)
// keyed by (spellKey, entityKey) where entityKey is 'self' or a canonical entity-name key.
// The SAME spell can be active on the player AND on the pet AND on a mob simultaneously —
// three independent instances, three independent timers. There is NO special 'pet' class:
//
//   • "pet" is NOT exceptional in the data model. A buff cast on the pet is just a buff
//     bound to the pet's entity key, exactly like a buff on any other entity. The only
//     place "pet" matters is the UI's PRIORITY: show self buffs first, then per-entity
//     groups (the current pet naturally tops that list).
//   • buff vs DEBUFF is a SPELL property: from the DB's spellType (Beneficial vs
//     Detrimental). For a spell absent from the DB we fall back to the plurality of its
//     observed fade-target dispositions. This is what kills the old "class flip" wart
//     (Tashani/Shiftless toggling between pet↔debuff as fades landed on different targets).
//
// A buff binds to the entity the landing MESSAGE named (buffApply carries the target). If
// the pet's name appears in that message, it binds to the pet like anyone else — no
// pet-specific plumbing. A possessive `Your pet's <S> spell has worn off.` fade resolves
// against the CURRENT pet entity's key at fade time.
//
// ─────────────────────────────────────────────────────────────────────────────
// ENTITY LIFECYCLE (generalized, Task #35). The module tracks a tiny entity state
// (charm/petClaim/uncharm/death/zone/single-pet-succession) — conceptually parallel to the
// combat WorldModel, SHARING its pure rules via combat/entityRules.ts. Retiring an entity
// CENSORS every buff instance bound to its key — there are no pet-specific branches; the
// pet is simply the entity currently claimed. Buffs on OTHER players / arbitrary entities
// fall out for free: they're bound to their entity and censored when that entity is retired
// (e.g. left behind on a zone).
//
// CENSORING (the reason the entity model exists): an open cast whose bound entity is retired
// before the fade can NEVER be observed fading → it is DROPPED with no duration sample,
// instead of pairing with a much-later unrelated fade to yield a bogus multi-hour duration.
//
// ─────────────────────────────────────────────────────────────────────────────
// MINING MODEL (byte-identical to Task #30 for the self/pet duration path):
//   castBegin(S)   → S becomes the PENDING cast (replaces prior pending) AND is shown
//                    OPTIMISTICALLY right away (provisional) if S is a known buff/debuff.
//   castFizzle(S) / castInterrupted(S) → clears pending S + retracts its provisional.
//   buffFade(S,target?) → an active instance of S expired on `target`; pairs with the
//                    matching landed cast → duration sample; records the target disposition.
//   playerDeath    → strips ALL self buffs; censors open SELF casts.
//
// LANDING (mining) APPROXIMATION: a pending cast LANDS when neither a fizzle nor interrupt
// of S occurs before EITHER the next castBegin OR 15s of log-time elapse. A buffFade of the
// pending spell also implies it landed. Landed ts = cast-BEGIN ts.

import type { EqModule } from './types'
import type { LogEvent, BuffExpiredEvent } from '../../shared/logEvents'
import type { BuffsDelta, BuffsSnap, MessageOverlay } from '../../shared/types'
import { idKey } from '../log/parser'
import type { SpellDb } from '../data/spellDb'
import { MessageOverlayMiner } from '../data/messageOverlay'
import { charmedPetDiesOnDeathLine } from '../combat/entityRules'
import { BuffInstances } from './buffsInstances'
import { PetEntities } from './buffsEntities'
import { SpellStats } from './buffsStats'
import {
  EMOTE_MIN_OBSERVATIONS,
  EMOTE_WINDOW_MS,
  looksLandingMessage,
  OWN_CAST_WINDOW_MS,
  PERMANENT_ILLUSION,
  QUICK_BUFF,
  QUICK_BUFF_WINDOW_MS,
  SELF_KEY,
  SESSION_GAP_MS,
  spellKey
} from './buffsShapes'

/** One member of the LogEvent union, selected by its `kind` tag. */
type Ev<K extends LogEvent['kind']> = Extract<LogEvent, { kind: K }>

/** A candidate spell carried by an ambiguous landing message (Task #34). */
interface Candidate {
  name: string
  durationMs: number | null
  illusion: boolean
}

export class BuffsModule implements EqModule<BuffsSnap, BuffsDelta> {
  readonly id = 'buffs'
  private seq = 0

  /** Per-SPELL learned knowledge (samples / class / recency / the DB). */
  private readonly stats: SpellStats
  /** The pet/charm/target identity slots (the who/what). */
  private readonly pets = new PetEntities()
  /** The live (spell, entity) instances + every mutation over them. */
  private readonly inst: BuffInstances

  /** ts of the last `You activate Quick Buff.` — burst applies within the window are confident. */
  private quickBuffTs = 0
  /** ts from which the Permanent Illusion AA is owned (self illusions become permanent). */
  private permanentIllusionOwnedTs?: number
  /** Recently-cast spell keys → last cast ts (Task #34), for ambiguous-message resolution. */
  private castHistory = new Map<string, number>()

  // ── emote learning (Task #33): recognize real landing-emote TEXTS ──
  private emoteTextCount = new Map<string, number>()

  // ── session-gap tracking (Task #33, finding #5) ──
  private lastEventTs = 0

  /**
   * The observed-message overlay miner (Task #36). Mines (message, spell) associations from
   * the log to VERIFY / flag-SHARED / flag-CONTRADICTS-WIKI the cast messages, augmenting
   * spells.json with what we actually observe. Seeded with the committed baseline + the
   * persisted user overlay at construction so it starts warm.
   */
  private readonly miner: MessageOverlayMiner

  /**
   * DERIVED-event emitter (Task #47). When the module RESOLVES a wear-off against the live
   * active set (self message wears-off, illusion fade, or a targeted pet/entity fade), it
   * synthesizes a `buffExpired { spell: RESOLVED, target }` event and hands it back to the
   * bus through this callback so the alerts module can match ONE reliable kind for both the
   * "wore off you" and "wore off your pet/target" sides. Optional — tests and the DB-mining
   * script construct the module without an emitter (they capture emissions differently).
   * `live` is threaded through from the primary event so a replayed wear-off stays live:false.
   */
  private emitDerived?: (ev: LogEvent, live: boolean) => void
  /** The (seq, ts, live) of the primary event currently being folded — used to stamp derived events. */
  private curSeq = 0
  private curTs = 0
  private curLive = false

  constructor(
    db?: SpellDb,
    seedOverlays?: (MessageOverlay | null | undefined)[],
    emitDerived?: (ev: LogEvent, live: boolean) => void
  ) {
    this.stats = new SpellStats(db)
    this.inst = new BuffInstances(this.stats, this.pets, (spell, target) => {
      this.emitBuffExpired(spell, target)
    })
    this.emitDerived = emitDerived
    this.miner = new MessageOverlayMiner(db?.byKey)
    // Seed the miner with the committed baseline + the user's persisted overlay (both
    // additive) so it starts warm — a fresh install benefits from the shipped baseline,
    // a returning user keeps everything their own log has taught (Task #36).
    for (const ov of seedOverlays ?? []) this.miner.merge(ov)
  }

  /** Install/replace the derived-event emitter after construction (index.ts wires the bus). */
  setDerivedEmitter(fn: (ev: LogEvent, live: boolean) => void): void {
    this.emitDerived = fn
  }

  /**
   * Synthesize a RESOLVED `buffExpired` derived event (Task #47) onto the bus. `target` is
   * 'self' for a player-side expiry, else the bound entity's display name. Stamped with the
   * primary event's seq/ts/live so it slots into the stream coherently and alerts respects the
   * replay gate. No-op without an emitter (tests/scripts).
   */
  private emitBuffExpired(spell: string, target: string): void {
    if (!this.emitDerived) return
    const who = target === 'self' ? 'you' : target
    const ev: BuffExpiredEvent = {
      kind: 'buffExpired',
      seq: this.curSeq,
      ts: this.curTs,
      // A synthesized human-readable line — this is what the alert's recent-fires panel shows.
      raw: `${spell} wore off ${who}.`,
      spell,
      target
    }
    this.emitDerived(ev, this.curLive)
  }

  /** Serialize the current learned overlay (for debounced persistence in index.ts). */
  overlaySnapshot(): MessageOverlay {
    return this.miner.build()
  }

  reset(): void {
    this.seq = 0
    this.inst.reset()
    this.stats.reset()
    this.emoteTextCount = new Map()
    this.lastEventTs = 0
    this.quickBuffTs = 0
    this.permanentIllusionOwnedTs = undefined
    this.castHistory = new Map()
    this.pets.reset()
  }

  /** Strip the `[timestamp] ` prefix from a raw line → the bare message text (for the overlay). */
  private messageTextOf(raw: string): string {
    const i = raw.indexOf('] ')
    return i >= 0 ? raw.slice(i + 2) : raw
  }

  /**
   * Feed the observed-message overlay miner (Task #36). A castBegin is the association
   * ANCHOR; the message-bearing events (buffApply / spellEmote = landing, buffWearOff /
   * illusionFade / buffFade = wears-off) are candidate messages associated to the nearest
   * anchor within the window. This runs on EVERY event before the switch, so it mines the
   * same way in replay and live.
   */
  private mineForOverlay(ev: LogEvent): void {
    switch (ev.kind) {
      case 'castBegin':
        this.miner.observeCast(ev.spell, ev.ts)
        break
      case 'buffApply':
      case 'spellEmote':
        this.miner.observeMessage(this.messageTextOf(ev.raw), ev.ts, 'landing')
        this.overlayCacheDirty = true
        break
      case 'buffWearOff':
      case 'illusionFade':
      case 'buffFade':
        this.miner.observeMessage(this.messageTextOf(ev.raw), ev.ts, 'wearsOff')
        this.overlayCacheDirty = true
        break
      case 'unknown': {
        // A line the parser classified as NOTHING but that could be an un-catalogued
        // landing message (e.g. Symbol of Pinzarn's real "The symbol of Pinzarn flashes
        // before your eyes." — the wiki's msg_cast_on_you is WRONG, so the DB table never
        // matched it). Feed only flavor-SHAPED lines; the unambiguous-anchor + count rules
        // in the miner discard coincidental pairings, so a wrong candidate never verifies.
        const t = this.messageTextOf(ev.raw)
        if (looksLandingMessage(t)) {
          this.miner.observeMessage(t, ev.ts, 'landing')
          this.overlayCacheDirty = true
        }
        break
      }
    }
  }

  onEvent(ev: LogEvent, live = false): void {
    this.seq = ev.seq
    // A DERIVED buffExpired (Task #47) is our OWN synthesized event — never fold it (that
    // would be a feedback loop). It exists purely for the alerts module to match.
    if (ev.kind === 'buffExpired') return
    // Character rebirth (Task #49): a same-name character was wiped/recreated. Clear ALL LIVE
    // state — actives, open casts, pending, and the entity (pet/charm) bindings — via the
    // same path a 30-min session gap uses. What we KEEP is deliberate: mined durations
    // (samples/stats), the everFaded/class/dispTally maps, learned landing-emote recognition,
    // and the observed-message overlay are GAME-KNOWLEDGE, not character state — a spell's
    // duration and its cast messages are identical across a rebirth, so re-learning them from
    // zero would needlessly cold-start the model. Only the live who/what/when clears.
    if (ev.kind === 'epoch') {
      this.clearAllForGap()
      return
    }
    // Record the primary event's identity so any buffExpired we synthesize while folding it is
    // stamped with the right seq/ts/live (alerts respects the replay gate via `live`).
    this.curSeq = ev.seq
    this.curTs = ev.ts
    this.curLive = live
    if (this.lastEventTs > 0 && ev.ts - this.lastEventTs >= SESSION_GAP_MS) {
      this.clearAllForGap()
    }
    this.lastEventTs = ev.ts
    this.inst.maybeLandPendingByTime(ev.ts)
    this.inst.sweepHygiene(ev.ts)

    // Observed-message overlay mining (Task #36): feed the anchor cast + any candidate
    // message line so the miner accretes (message, spell) associations across replay + live.
    this.mineForOverlay(ev)

    this.dispatch(ev)
  }

  /**
   * Route the event to its handler. The three groups are disjoint by `kind` (a switch over a
   * discriminated union), so the split is purely a factoring of one long switch.
   */
  private dispatch(ev: LogEvent): void {
    if (this.dispatchCast(ev)) return
    if (this.dispatchBuff(ev)) return
    this.dispatchEntity(ev)
  }

  /** Cast lifecycle + activated AA. Returns true when the event was handled. */
  private dispatchCast(ev: LogEvent): boolean {
    switch (ev.kind) {
      case 'castBegin':
        this.onCastBegin(ev)
        return true
      case 'spellEmote':
        this.onSpellEmote(ev)
        return true
      case 'castFizzle':
      case 'castInterrupted':
        this.inst.clearPendingCast(spellKey(ev.spell))
        return true
      case 'aaActivate':
        if (idKey(ev.name) === QUICK_BUFF) this.quickBuffTs = ev.ts
        return true
      case 'aaSpend':
        this.onAaSpend(ev)
        return true
      default:
        return false
    }
  }

  /** Buff application / expiry. Returns true when the event was handled. */
  private dispatchBuff(ev: LogEvent): boolean {
    switch (ev.kind) {
      case 'buffApply':
        this.onBuffApply(ev)
        return true
      case 'buffWearOff':
        this.onBuffWearOff(ev)
        return true
      case 'illusionFade':
        // `Your illusion fades.` (Task #36): the player's active illusion clicked/wore off.
        // Only one illusion is ever active on self, so this removes whichever illusion self
        // buff is active — no spell name needed (the line is 27-way-ambiguous by design).
        this.inst.clearSelfIllusion()
        return true
      case 'heal':
        this.onHeal(ev)
        return true
      case 'buffFade':
        this.onBuffFade(ev)
        return true
      case 'playerDeath':
        this.inst.onPlayerDeath()
        return true
      default:
        return false
    }
  }

  /** Entity lifecycle (the who/what state). */
  private dispatchEntity(ev: LogEvent): void {
    switch (ev.kind) {
      case 'charm':
        this.onCharm(ev)
        break
      case 'petClaim':
        this.onPetClaim(ev)
        break
      case 'uncharm':
        this.onUncharm(ev)
        break
      case 'cc':
        this.pets.petTargetKey = idKey(ev.mob)
        this.pets.petTargetDisplay = ev.mob
        break
      case 'death':
        this.onDeath(ev)
        break
      case 'zone':
        this.inst.onZone()
        break
      default:
        break
    }
  }

  private onCastBegin(ev: Ev<'castBegin'>): void {
    this.inst.landPending(ev.ts)
    const key = spellKey(ev.spell)
    this.castHistory.set(key, ev.ts)
    this.stats.touchLastSeen(key, ev.ts)
    this.inst.beginCast(ev.spell, key, ev.ts)
  }

  private onSpellEmote(ev: Ev<'spellEmote'>): void {
    const p = this.inst.pending
    if (p && ev.ts - p.beganTs <= EMOTE_WINDOW_MS && ev.ts >= p.beganTs && !p.emoteSubjectKey) {
      const n = (this.emoteTextCount.get(ev.text) ?? 0) + 1
      this.emoteTextCount.set(ev.text, n)
      if (n >= EMOTE_MIN_OBSERVATIONS) {
        p.emoteSubjectKey = ev.subject === 'self' ? SELF_KEY : idKey(ev.subject)
      }
    }
  }

  private onAaSpend(ev: Ev<'aaSpend'>): void {
    if (this.permanentIllusionOwnedTs == null && idKey(ev.ability) === PERMANENT_ILLUSION) {
      this.permanentIllusionOwnedTs = ev.ts
    }
  }

  private onBuffApply(ev: Ev<'buffApply'>): void {
    // OWN-CAST GATING (Task #45, the user's rule: "if something isn't cast by me — we
    // shouldn't track it"). Cast-on-other landing emotes (a nearby player's Symbol
    // landing on the mob you're fighting) don't name the caster, so without this gate a
    // STRANGER's buff binds as ours. Require attribution to the player's OWN casting:
    // an own castBegin of the resolved spell within the landing window, OR a Quick Buff
    // activation burst (which applies many spells with no castBegin). No own-cast
    // context → skip the apply entirely (never guess a stranger's buff).
    const r = this.resolveCandidate(ev.candidates)
    if (r && this.ownCastAttributed(spellKey(r.name), ev.ts)) {
      this.inst.applyMessageBuff(r.name, {
        target: ev.target,
        ts: ev.ts,
        illusion: r.illusion,
        durationMs: r.durationMs,
        permanentIllusionOwnedTs: this.permanentIllusionOwnedTs
      })
    }
  }

  private onBuffWearOff(ev: Ev<'buffWearOff'>): void {
    // Authoritative, message-driven expiry. The wears-off emote prints to the buff
    // HOLDER (the player), so it clears the SELF instance of this spell (Task #34/#35).
    // MANY spells share a wears-off message (Task #45): resolve against the ACTIVE self
    // set. EQ stacking keeps at most one candidate of a family active, so exactly one
    // matches the common case; if several somehow match, remove ALL (they share the
    // line — be honest). None active → no-op. Removing by only the first candidate (the
    // old code) MISSED the actually-active buff (e.g. self Quickness/Swift never cleared
    // because the first candidate "Aanya's Quickening" was never the active one).
    this.inst.removeSharedWearOff(ev.candidates, SELF_KEY, ev.ts)
  }

  private onHeal(ev: Ev<'heal'>): void {
    const db = this.stats.db
    if (db && ev.spell && idKey(ev.healer ?? '') === 'you') {
      const key = spellKey(ev.spell)
      const dbSpell = db.byKey.get(key)
      if (dbSpell?.durationMs != null) {
        this.inst.applyMessageBuff(dbSpell.name, {
          target: 'self',
          ts: ev.ts,
          illusion: dbSpell.illusion,
          durationMs: dbSpell.durationMs,
          permanentIllusionOwnedTs: this.permanentIllusionOwnedTs
        })
      }
    }
  }

  private onBuffFade(ev: Ev<'buffFade'>): void {
    const key = spellKey(ev.spell)
    this.stats.everFaded.add(key)
    // Resolve the fade's target entity. A possessive 'pet' form resolves against the
    // CURRENT pet entity's key; a named mob → that mob's key; targetless → self.
    const { entityKey, disp } = this.pets.fadeTargetEntity(ev.target)
    this.stats.tallyFade(key, disp)
    if (this.inst.pending?.key === key) this.inst.landPending(ev.ts)
    this.inst.recordFade(key, entityKey, ev.spell, ev.ts)
    // DERIVED buffExpired (Task #47): buffFade already carries a RESOLVED spell + target
    // (the possessive/named-target worn-off shapes name both). Synthesize the unified
    // resolved event so ONE alert kind covers a fade on your pet/target as well as the
    // self message wears-off above — the "helps you with both by default" the user asked for.
    this.emitBuffExpired(ev.spell, this.pets.buffFadeTargetDisplay(ev.target, entityKey))
  }

  private onCharm(ev: Ev<'charm'>): void {
    const newKey = idKey(ev.mob)
    // DISPOSITION, NOT IDENTITY (Task #37): re-charming the SAME name after a charm break
    // (with no intervening death/zone of that name) is the SAME entity — its buffs are
    // still active on it and it must NOT trigger single-pet succession against itself.
    // A break→re-charm cycle is the common case (seconds apart) and preserves everything.
    const sameAsBroken = this.pets.brokenCharmKey === newKey
    const sameAsCharmed = this.pets.charmedKey === newKey
    if (!sameAsBroken && !sameAsCharmed) {
      // SINGLE-PET INVARIANT: charming a DIFFERENT entity retires the prior pet(s) —
      // including a broken-charm entity that we never re-charmed (you moved on to a new
      // mob, so the old one really is left behind).
      if (this.pets.charmedKey) this.inst.retireEntity(this.pets.charmedKey)
      if (this.pets.brokenCharmKey) this.inst.retireEntity(this.pets.brokenCharmKey)
      if (this.pets.summonedKey) this.inst.retireEntity(this.pets.summonedKey)
      this.pets.petTargetKey = undefined
      this.pets.petTargetDisplay = undefined
    }
    // Re-bind (or bind) the charmed entity. If this reconnects a broken charm, its buff
    // instances were never censored, so they remain active on it.
    this.pets.charmedKey = newKey
    this.pets.charmedDisplay = ev.mob
    this.pets.brokenCharmKey = undefined
    this.pets.brokenCharmDisplay = undefined
  }

  private onPetClaim(ev: Ev<'petClaim'>): void {
    const key = idKey(ev.name)
    const pets = this.pets
    if (key !== pets.charmedKey && key !== pets.summonedKey && key !== pets.brokenCharmKey) {
      // Single-pet succession: claiming a DIFFERENT pet retires the prior pet(s), including
      // a broken-charm entity you never re-charmed (Task #37) — you've moved to a new pet.
      if (pets.summonedKey) this.inst.retireEntity(pets.summonedKey)
      if (pets.charmedKey) this.inst.retireEntity(pets.charmedKey)
      if (pets.brokenCharmKey) this.inst.retireEntity(pets.brokenCharmKey)
      pets.summonedKey = key
      pets.summonedDisplay = ev.name
    }
  }

  private onUncharm(ev: Ev<'uncharm'>): void {
    // CHARM BREAK = DISPOSITION CHANGE, NOT RETIREMENT (Task #37). The mob KEEPS its
    // identity and every buff instance — it's simply hostile-capable now until you
    // re-charm it (the common break→re-charm cycle, seconds apart). We do NOT censor or
    // retire here (the old code called retireEntity, which RESET the pet's buffs — the
    // user-reported bug). Move it to the broken-charm slot so a re-charm of the SAME name
    // reconnects to it with buffs intact; a death or zone of that name in the meantime
    // retires it via the existing paths (making the next charm a genuinely new entity).
    if (this.pets.charmedKey === idKey(ev.mob)) {
      this.pets.brokenCharmKey = this.pets.charmedKey
      this.pets.brokenCharmDisplay = this.pets.charmedDisplay
      this.pets.charmedKey = undefined
      this.pets.charmedDisplay = undefined
    }
  }

  private onDeath(ev: Ev<'death'>): void {
    const key = idKey(ev.name)
    const pets = this.pets
    const killerIsYou = ev.bySelf || idKey(ev.killer ?? '') === 'you'
    if (key === pets.summonedKey) {
      if (!killerIsYou) this.inst.retireEntity(key)
    } else if (key === pets.charmedKey) {
      const killerSameName = !ev.bySelf && ev.killer != null && idKey(ev.killer) === key
      if (charmedPetDiesOnDeathLine({ killerIsYou, killerSameName })) {
        this.inst.retireEntity(key)
      }
    } else if (key === pets.brokenCharmKey) {
      // A death naming the broken-charm entity (Task #37): the ex-pet is now a hostile mob
      // you're likely killing, so THIS death genuinely retires it — censoring its buffs so
      // the next charm of that name binds a fresh entity (rule #3). It's fully retired now,
      // not conservatively kept: charm no longer protects it (the twin-ambiguity that made
      // us keep a LIVE charmed pet doesn't apply once the charm has broken).
      this.inst.retireEntity(key)
    } else {
      // A plain hostile death censors any open/active instance bound to it.
      this.inst.retireEntity(key, { hostileOnly: true })
    }
    if (key === pets.petTargetKey) {
      pets.petTargetKey = undefined
      pets.petTargetDisplay = undefined
    }
  }

  onTick(nowMs: number): void {
    this.inst.maybeLandPendingByTime(nowMs)
    this.inst.sweepHygiene(nowMs)
  }

  /**
   * OWN-CAST attribution gate (Task #45). True when this apply can be attributed to the
   * player's OWN casting, so it's a buff WE put up (on self, our pet, or a mob we're
   * debuffing) — not a stranger's buff that happened to land on an entity near us:
   *   (a) an own `castBegin` of this spell within OWN_CAST_WINDOW_MS before the emote
   *       (castHistory records the last own cast ts per spell key), OR
   *   (b) an active Quick Buff burst (aaActivate 'Quick Buff' within QUICK_BUFF_WINDOW_MS) —
   *       a burst applies MANY spells with NO castBegin, so its window whitelists those.
   * No own-cast context → false → the apply is skipped (the user's strict rule).
   */
  private ownCastAttributed(key: string, ts: number): boolean {
    const lastCast = this.castHistory.get(key)
    if (lastCast != null && ts >= lastCast && ts - lastCast <= OWN_CAST_WINDOW_MS) return true
    if (this.quickBuffTs > 0 && ts >= this.quickBuffTs && ts - this.quickBuffTs <= QUICK_BUFF_WINDOW_MS) {
      return true
    }
    return false
  }

  /** Resolve an ambiguous landing-message apply (Task #34) to the candidate the player cast. */
  private resolveCandidate(cands: Candidate[]): Candidate | null {
    if (cands.length === 0) return null
    if (cands.length === 1) return cands[0]
    let best: Candidate | null = null
    let bestTs = -1
    for (const c of cands) {
      const t = this.castHistory.get(spellKey(c.name))
      if (t != null && t > bestTs) {
        best = c
        bestTs = t
      }
    }
    if (best) return best
    for (const c of cands) {
      if (this.inst.hasActiveSpell(spellKey(c.name))) return c
    }
    return null
  }

  /** Session-gap clear (Task #33, finding #5): wipe live actives/opens/pending + pets. */
  private clearAllForGap(): void {
    this.inst.clearForGap()
    this.pets.clearForGap()
  }

  private buildSnap(): BuffsSnap {
    return {
      active: [...this.inst.active.values()].sort((a, b) => a.startedTs - b.startedTs),
      stats: this.stats.buildStats(),
      overlay: this.cachedOverlay()
    }
  }

  /** Cache the built overlay; rebuild only when the miner observed something new. */
  private overlayCache: MessageOverlay | null = null
  private overlayCacheDirty = true
  private cachedOverlay(): MessageOverlay {
    if (this.overlayCacheDirty || this.overlayCache == null) {
      this.overlayCache = this.miner.build()
      this.overlayCacheDirty = false
    }
    return this.overlayCache
  }

  snapshot(): { seq: number; state: BuffsSnap } {
    return { seq: this.seq, state: this.buildSnap() }
  }

  flushDelta(): { seq: number; delta: BuffsDelta } | null {
    if (!this.inst.dirty) return null
    this.inst.dirty = false
    return { seq: this.seq, delta: this.buildSnap() }
  }
}
