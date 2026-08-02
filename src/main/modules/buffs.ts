// buffs module (Task #19; latency+coverage Task #30; ENTITY-AWARE Task #32; message-driven
// Task #33/#34; 'pet' DE-SPECIALIZED Task #35).
//
// A log-mined buff/debuff-duration model AND a small who/what/when simulation of which
// ENTITY each buff is bound to. All state is derived from events.
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
import type { LogEvent } from '../../shared/logEvents'
import type { ActiveBuff, BuffClass, BuffStat, BuffsDelta, BuffsSnap, MessageOverlay } from '../../shared/types'
import { idKey, spellCanonKey } from '../log/parser'
import type { SpellDb } from '../data/spellDb'
import { MessageOverlayMiner } from '../data/messageOverlay'
import {
  charmedPetDiesOnDeathLine,
  classifyFadeTarget,
  isLeftBehindOnZone,
  type EntityDisposition
} from '../combat/entityRules'

/** Land a pending cast this many ms after castBegin if nothing cleared it first. */
const LAND_TIMEOUT_MS = 15_000

/**
 * Sanity ceiling on a mined duration sample. No EQ Legends buff lasts anywhere near this
 * long. A land→fade gap beyond this is DEFINITIONALLY a missed censor and is DROPPED.
 */
const MAX_SAMPLE_MS = 3 * 60 * 60_000 // 3 hours

/**
 * Session-gap boundary (Task #33, finding #5). An event-time gap ≥ this = logout/AFK past
 * any buff duration → ALL actives cleared + open casts censored + pets retired.
 */
const SESSION_GAP_MS = 30 * 60_000 // 30 minutes

/** Active-buff HYGIENE cap (Task #33, finding #6). An active past this auto-retires. */
const HYGIENE_ABSOLUTE_MS = 90 * 60_000 // 90 minutes when no/low stats
function hygieneCapMs(p75: number | null, n: number): number {
  const stat = p75 != null && n >= 2 ? 2 * p75 : 0
  return Math.max(stat, HYGIENE_ABSOLUTE_MS)
}

/** Window after a castBegin within which a landing emote is attributed to that cast. */
const EMOTE_WINDOW_MS = 5_000
/** How many times an emote TEXT must appear adjacent to a cast before it's TRUSTED. */
const EMOTE_MIN_OBSERVATIONS = 2

/** Recency-weighted MAX window (Task #34): estimate = MAX over the most recent K samples. */
const RECENT_SAMPLE_WINDOW = 5

/** The activated-AA name whose burst of self-buff landing messages is trusted confident. */
const QUICK_BUFF = 'quick buff'
/** How long after a Quick Buff activation its burst applies are attributed to it. */
const QUICK_BUFF_WINDOW_MS = 5_000

/** The AA that makes self-cast illusion buffs PERMANENT (Task #34). */
const PERMANENT_ILLUSION = 'permanent illusion'

/** The sentinel entity key for a buff on the PLAYER. */
const SELF_KEY = 'self'
/** Instance-key separator  a NUL, which can never appear in a spell/entity name. */
const SEP = String.fromCharCode(0)

/** The instance key for a (spell, entity) pair — the buff-instance identity (Task #35). */
function instanceKey(spellKey: string, entityKey: string): string {
  return spellKey + SEP + entityKey
}

/** A cast that has landed (produced a buff instance) and is awaiting its next fade. */
interface OpenCast {
  spell: string
  /** rank-stripped spell key. */
  spellKey: string
  /** the entity this instance is on ('self' or a canonical name key). */
  entityKey: string
  landedTs: number
  /** The entity disposition this cast is bound to (for censoring on zone/death). */
  disp: EntityDisposition
}

/** A cast in flight (You begin casting …) not yet landed/cleared. */
interface Pending {
  spell: string
  key: string
  beganTs: number
  /** Refresh whose new startedTs is staged until confirmation (per matching instance). */
  stagedRefresh: boolean
  /** The landing emote's subject key ('self' or a name key), once its text is recognized. */
  emoteSubjectKey?: string
}

/** Per-spell accumulated duration samples + display name. */
interface SpellSamples {
  spell: string
  samples: number[]
}

/** Canonical spell key (case-stable, RANK-STRIPPED). */
function spellKey(s: string): string {
  return spellCanonKey(s)
}

/**
 * True when an un-catalogued line is SHAPED like a spell-landing flavor message (Task #36):
 * a short-ish sentence ending in a period, not a numeric/combat/system line. Used to feed
 * candidate landing messages the DB missed (e.g. Symbol of Pinzarn's real landing line,
 * whose wiki msg_cast_on_you is wrong) into the overlay miner. Deliberately permissive — the
 * miner's unambiguous-anchor + repeat-count rules reject coincidental pairings, so a
 * false candidate never earns a VERIFIED verdict.
 */
// Casting-system / UI feedback lines that are SELF-directed ("you"/"your") in shape but are
// never a spell-landing emote (they recur across every spell → pure noise). Rejected so a
// coincidental burst pairing can't verify them.
const CASTING_SYSTEM_RE =
  /can't use that command|regain your concentration|change your invocation|begin reciting|cannot see your target|Auto attack|mend your wounds|shimmers briefly|feels alive with power|begins casting|begin singing|You must|Insufficient|You do not|not ready yet|too far|out of range|You have entered|received any tells|cannot reply|mostly successful|has been overwritten|You forget |memoriz|You can(not| ?'?t)|Your target|Your spell|Your .* spell|You have finished|Beginning to|You are (?:no longer|now)|not enough|you cannot reply/i
/**
 * True when an un-catalogued line is plausibly a SELF spell-landing flavor message the DB
 * missed (Task #36) — the ONLY unknown-line class worth mining. It must be about the CASTER
 * (contain "you"/"your" or start with "You"/"Your"), a short sentence ending in a period,
 * with no numbers (damage/heal), no chat/tell/"by"/"from" markers, and not a casting-system
 * / UI line. This deliberately EXCLUDES third-person mob-subject lines ("a revenant
 * staggers.", "…spell is interrupted.") — those are combat spam that would poison the
 * overlay with coincidental burst pairings. Symbol of Pinzarn's real "The symbol of Pinzarn
 * flashes before your eyes." passes (it names "your eyes"); a mob effect line does not.
 */
function looksLandingMessage(text: string): boolean {
  if (text.length < 6 || text.length > 90) return false
  if (!text.endsWith('.')) return false
  if (/\d/.test(text)) return false // damage/heal/point lines carry numbers
  // Must reference the caster — a genuine cast-on-YOU line is about the player.
  if (!/\byou\b|\byour\b/i.test(text)) return false
  if (text.includes("' told you") || text.includes(' tells ') || text.includes(' says')) return false
  if (text.includes(' by ') || text.includes(' from ')) return false
  if (text.includes(' spell ') || text.includes('attention')) return false // combat cast spam
  if (CASTING_SYSTEM_RE.test(text)) return false
  return true
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  if (sortedAsc.length === 1) return sortedAsc[0]
  const idx = (sortedAsc.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sortedAsc[lo]
  const frac = idx - lo
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac
}

export class BuffsModule implements EqModule<BuffsSnap, BuffsDelta> {
  readonly id = 'buffs'
  private seq = 0

  /** The scraped spell database (Task #34), optional — the authoritative prior. */
  private readonly db?: SpellDb
  /** ts of the last `You activate Quick Buff.` — burst applies within the window are confident. */
  private quickBuffTs = 0
  /** ts from which the Permanent Illusion AA is owned (self illusions become permanent). */
  private permanentIllusionOwnedTs?: number
  /** Recently-cast spell keys → last cast ts (Task #34), for ambiguous-message resolution. */
  private castHistory = new Map<string, number>()

  /**
   * The observed-message overlay miner (Task #36). Mines (message, spell) associations from
   * the log to VERIFY / flag-SHARED / flag-CONTRADICTS-WIKI the cast messages, augmenting
   * spells.json with what we actually observe. Seeded with the committed baseline + the
   * persisted user overlay at construction so it starts warm.
   */
  private readonly miner: MessageOverlayMiner

  constructor(db?: SpellDb, seedOverlays?: (MessageOverlay | null | undefined)[]) {
    this.db = db
    this.miner = new MessageOverlayMiner(db?.byKey)
    // Seed the miner with the committed baseline + the user's persisted overlay (both
    // additive) so it starts warm — a fresh install benefits from the shipped baseline,
    // a returning user keeps everything their own log has taught (Task #36).
    for (const ov of seedOverlays ?? []) this.miner.merge(ov)
  }

  /** Serialize the current learned overlay (for debounced persistence in index.ts). */
  overlaySnapshot(): MessageOverlay {
    return this.miner.build()
  }

  /** Authoritative DB duration (ms) for a spell key, or null when unknown. */
  private dbDurationFor(key: string): number | null {
    const s = this.db?.byKey.get(key)
    return s?.durationMs ?? null
  }

  /** True when a spell KEY is illusion-flagged in the DB (Task #36). */
  private isIllusion(key: string): boolean {
    return this.db?.byKey.get(key)?.illusion ?? false
  }

  /**
   * ILLUSION EXCLUSIVITY (Task #36, the user's rule): only ONE illusion can be active on a
   * given entity at a time (Permanent Illusion AA or not). Removes every illusion-flagged
   * active + open instance bound to `entityKey` EXCEPT the one being applied now (`keepKey`).
   * A new illusion apply on an entity replaces any prior illusion on that entity — applies
   * to self AND pet (a pet illusion like Boon-on-pet replaces a prior pet illusion).
   */
  private clearIllusionsOn(entityKey: string, keepKey: string): void {
    for (const [ik, a] of [...this.active]) {
      if (ik === keepKey) continue
      if (this.instanceEntityKey(ik) !== entityKey) continue
      if (this.isIllusion(spellKey(a.spell))) {
        this.active.delete(ik)
        this.open.delete(ik)
        this.dirty = true
      }
    }
  }

  /** Remove the (single) illusion-flagged SELF active — the `Your illusion fades.` handler. */
  private clearSelfIllusion(): void {
    for (const [ik, a] of [...this.active]) {
      if (!a.self) continue
      if (this.isIllusion(spellKey(a.spell))) {
        this.active.delete(ik)
        this.open.delete(ik)
        this.dirty = true
      }
    }
  }

  /** The single cast currently in flight (You begin …), or null. */
  private pending: Pending | null = null
  /** Landed casts awaiting their fade, keyed by INSTANCE key (spell, entity) — Task #35. */
  private open = new Map<string, OpenCast>()
  /** Currently-active buff instances, keyed by INSTANCE key (spell, entity) — Task #35. */
  private active = new Map<string, ActiveBuff>()
  /** Mined samples per SPELL key (per-spell, not per-instance — a v1 simplification). */
  private samples = new Map<string, SpellSamples>()
  /** Spell keys ever seen fading / applied — the buff discriminator. */
  private everFaded = new Set<string>()
  /**
   * Per-spell fade-disposition tally — the FALLBACK classifier for spells ABSENT from the
   * DB (Task #35): a spell that mostly fades on hostile entities is a debuff. DB spellType
   * wins when present.
   */
  private dispTally = new Map<string, { self: number; summoned: number; charmed: number; hostile: number }>()

  // ── emote learning (Task #33): recognize real landing-emote TEXTS ──
  private emoteTextCount = new Map<string, number>()

  // ── session-gap tracking (Task #33, finding #5) ──
  private lastEventTs = 0

  // ── entity state (the who/what) — a tiny parallel to the combat WorldModel ──
  private charmedKey?: string
  private charmedDisplay?: string
  /**
   * A charm that just BROKE but whose entity is NOT yet retired (Task #37). Charm/uncharm
   * changes an entity's DISPOSITION, never its identity: when Allure/Charm wears off, the mob
   * KEEPS its buffs and is merely hostile-capable for a few seconds until you re-charm it. We
   * remember its key/display here so a re-charm of the SAME name (with no intervening death or
   * zone of that name) reconnects to the SAME entity — its buffs never having been censored.
   * A death or zone of that name in the meantime retires it (clears this), so the next charm
   * of that name is a genuinely new entity.
   */
  private brokenCharmKey?: string
  private brokenCharmDisplay?: string
  private summonedKey?: string
  private summonedDisplay?: string
  /** The pet's CURRENT hostile fight target (canonical key + display), if cheaply known. */
  private petTargetKey?: string
  private petTargetDisplay?: string
  /** Display casing for arbitrary bound entities (mobs/players named by a buff message). */
  private namedEntityDisplay = new Map<string, string>()

  /** Set whenever state changed since the last flush. */
  private dirty = false

  reset(): void {
    this.seq = 0
    this.pending = null
    this.open = new Map()
    this.active = new Map()
    this.samples = new Map()
    this.everFaded = new Set()
    this.dispTally = new Map()
    this.emoteTextCount = new Map()
    this.lastEventTs = 0
    this.quickBuffTs = 0
    this.permanentIllusionOwnedTs = undefined
    this.castHistory = new Map()
    this.charmedKey = undefined
    this.charmedDisplay = undefined
    this.brokenCharmKey = undefined
    this.brokenCharmDisplay = undefined
    this.summonedKey = undefined
    this.summonedDisplay = undefined
    this.petTargetKey = undefined
    this.petTargetDisplay = undefined
    this.namedEntityDisplay = new Map()
    this.dirty = false
  }

  /**
   * Current pet identities, for the shared classifyFadeTarget helper. During a charm-break
   * hostile window (Task #37) the ex-pet is still the SAME entity, so its name is classified as
   * the (charmed) pet — a buff fading on it in that 7s window is the pet's buff fading, NOT a
   * hostile debuff. `charmedKey` falls back to the broken-charm key while the charm is down.
   */
  private petState(): { charmedKey?: string; summonedKey?: string } {
    return { charmedKey: this.charmedKey ?? this.brokenCharmKey, summonedKey: this.summonedKey }
  }

  /** The current pet's canonical entity key (summoned preferred, else charmed), or undefined. */
  private currentPetKey(): string | undefined {
    return this.summonedKey ?? this.charmedKey
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

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    if (this.lastEventTs > 0 && ev.ts - this.lastEventTs >= SESSION_GAP_MS) {
      this.clearAllForGap()
    }
    this.lastEventTs = ev.ts
    this.maybeLandPendingByTime(ev.ts)
    this.sweepHygiene(ev.ts)

    // Observed-message overlay mining (Task #36): feed the anchor cast + any candidate
    // message line so the miner accretes (message, spell) associations across replay + live.
    this.mineForOverlay(ev)

    switch (ev.kind) {
      case 'castBegin': {
        this.landPending(ev.ts)
        const key = spellKey(ev.spell)
        this.castHistory.set(key, ev.ts)
        // Optimistic display: bind the provisional to the entity this cast most likely
        // targets NOW (self, live pet, or the inferred hostile target for a debuff).
        const disp = this.inferCastDisposition(key, undefined)
        const eKey = this.entityKeyFor(disp)
        const iKey = instanceKey(key, eKey)
        const existing = this.active.get(iKey)
        const stagedRefresh = !!existing && !existing.provisional
        this.pending = { spell: ev.spell, key, beganTs: ev.ts, stagedRefresh }
        if (!existing && this.everFaded.has(key)) {
          this.active.set(iKey, this.buildActive(ev.spell, key, eKey, ev.ts, true, disp))
          // ILLUSION EXCLUSIVITY (Task #36): an optimistic illusion cast also replaces any
          // prior illusion on the same entity (a message apply confirms it later).
          if (this.isIllusion(key)) this.clearIllusionsOn(eKey, iKey)
          this.dirty = true
        }
        break
      }
      case 'spellEmote': {
        const p = this.pending
        if (p && ev.ts - p.beganTs <= EMOTE_WINDOW_MS && ev.ts >= p.beganTs && !p.emoteSubjectKey) {
          const n = (this.emoteTextCount.get(ev.text) ?? 0) + 1
          this.emoteTextCount.set(ev.text, n)
          if (n >= EMOTE_MIN_OBSERVATIONS) {
            p.emoteSubjectKey = ev.subject === 'self' ? SELF_KEY : idKey(ev.subject)
          }
        }
        break
      }
      case 'aaActivate': {
        if (idKey(ev.name) === QUICK_BUFF) this.quickBuffTs = ev.ts
        break
      }
      case 'aaSpend': {
        if (this.permanentIllusionOwnedTs == null && idKey(ev.ability) === PERMANENT_ILLUSION) {
          this.permanentIllusionOwnedTs = ev.ts
        }
        break
      }
      case 'buffApply': {
        const r = this.resolveCandidate(ev.candidates)
        if (r) this.applyMessageBuff(r.name, ev.target, ev.ts, r.illusion, r.durationMs)
        break
      }
      case 'buffWearOff': {
        // Authoritative, message-driven expiry. The wears-off emote prints to the buff
        // HOLDER (the player), so it clears the SELF instance of this spell (Task #34/#35).
        this.removeAuthoritative(spellKey(ev.spell), SELF_KEY, ev.ts)
        break
      }
      case 'illusionFade': {
        // `Your illusion fades.` (Task #36): the player's active illusion clicked/wore off.
        // Only one illusion is ever active on self, so this removes whichever illusion self
        // buff is active — no spell name needed (the line is 27-way-ambiguous by design).
        this.clearSelfIllusion()
        break
      }
      case 'heal': {
        if (this.db && ev.spell && idKey(ev.healer ?? '') === 'you') {
          const key = spellKey(ev.spell)
          const dbSpell = this.db.byKey.get(key)
          if (dbSpell && dbSpell.durationMs != null) {
            this.applyMessageBuff(dbSpell.name, 'self', ev.ts, dbSpell.illusion, dbSpell.durationMs)
          }
        }
        break
      }
      case 'castFizzle':
      case 'castInterrupted': {
        const key = spellKey(ev.spell)
        if (this.pending && this.pending.key === key) {
          const p = this.pending
          this.pending = null
          if (!p.stagedRefresh) {
            // Retract the optimistic provisional instance this cast created.
            for (const [ik, a] of [...this.active]) {
              if (a.provisional && spellKey(a.spell) === key) {
                this.active.delete(ik)
                this.dirty = true
              }
            }
          }
        }
        break
      }
      case 'buffFade': {
        const key = spellKey(ev.spell)
        this.everFaded.add(key)
        // Resolve the fade's target entity. A possessive 'pet' form resolves against the
        // CURRENT pet entity's key; a named mob → that mob's key; targetless → self.
        const { entityKey, disp } = this.fadeTargetEntity(ev.target)
        let tally = this.dispTally.get(key)
        if (!tally) {
          tally = { self: 0, summoned: 0, charmed: 0, hostile: 0 }
          this.dispTally.set(key, tally)
        }
        tally[disp]++
        if (this.pending && this.pending.key === key) this.landPending(ev.ts)
        this.recordFade(key, entityKey, ev.spell, ev.ts)
        break
      }
      case 'playerDeath': {
        this.onPlayerDeath()
        break
      }
      // ── entity lifecycle (the who/what state) ──
      case 'charm': {
        const newKey = idKey(ev.mob)
        // DISPOSITION, NOT IDENTITY (Task #37): re-charming the SAME name after a charm break
        // (with no intervening death/zone of that name) is the SAME entity — its buffs are
        // still active on it and it must NOT trigger single-pet succession against itself.
        // A break→re-charm cycle is the common case (seconds apart) and preserves everything.
        const sameAsBroken = this.brokenCharmKey === newKey
        const sameAsCharmed = this.charmedKey === newKey
        if (!sameAsBroken && !sameAsCharmed) {
          // SINGLE-PET INVARIANT: charming a DIFFERENT entity retires the prior pet(s) —
          // including a broken-charm entity that we never re-charmed (you moved on to a new
          // mob, so the old one really is left behind).
          if (this.charmedKey) this.retireEntity(this.charmedKey, ev.ts)
          if (this.brokenCharmKey) this.retireEntity(this.brokenCharmKey, ev.ts)
          if (this.summonedKey) this.retireEntity(this.summonedKey, ev.ts)
          this.petTargetKey = undefined
          this.petTargetDisplay = undefined
        }
        // Re-bind (or bind) the charmed entity. If this reconnects a broken charm, its buff
        // instances were never censored, so they remain active on it.
        this.charmedKey = newKey
        this.charmedDisplay = ev.mob
        this.brokenCharmKey = undefined
        this.brokenCharmDisplay = undefined
        break
      }
      case 'petClaim': {
        const key = idKey(ev.name)
        if (key !== this.charmedKey && key !== this.summonedKey && key !== this.brokenCharmKey) {
          // Single-pet succession: claiming a DIFFERENT pet retires the prior pet(s), including
          // a broken-charm entity you never re-charmed (Task #37) — you've moved to a new pet.
          if (this.summonedKey) this.retireEntity(this.summonedKey, ev.ts)
          if (this.charmedKey) this.retireEntity(this.charmedKey, ev.ts)
          if (this.brokenCharmKey) this.retireEntity(this.brokenCharmKey, ev.ts)
          this.summonedKey = key
          this.summonedDisplay = ev.name
        }
        break
      }
      case 'uncharm': {
        // CHARM BREAK = DISPOSITION CHANGE, NOT RETIREMENT (Task #37). The mob KEEPS its
        // identity and every buff instance — it's simply hostile-capable now until you
        // re-charm it (the common break→re-charm cycle, seconds apart). We do NOT censor or
        // retire here (the old code called retireEntity, which RESET the pet's buffs — the
        // user-reported bug). Move it to the broken-charm slot so a re-charm of the SAME name
        // reconnects to it with buffs intact; a death or zone of that name in the meantime
        // retires it via the existing paths (making the next charm a genuinely new entity).
        if (this.charmedKey === idKey(ev.mob)) {
          this.brokenCharmKey = this.charmedKey
          this.brokenCharmDisplay = this.charmedDisplay
          this.charmedKey = undefined
          this.charmedDisplay = undefined
        }
        break
      }
      case 'cc': {
        this.petTargetKey = idKey(ev.mob)
        this.petTargetDisplay = ev.mob
        break
      }
      case 'death': {
        const key = idKey(ev.name)
        const isSummoned = key === this.summonedKey
        const isCharmed = key === this.charmedKey
        const isBrokenCharm = key === this.brokenCharmKey
        if (isSummoned) {
          const killerIsYou = ev.bySelf || idKey(ev.killer ?? '') === 'you'
          if (!killerIsYou) this.retireEntity(this.summonedKey!, ev.ts)
        } else if (isCharmed) {
          const killerIsYou = ev.bySelf || idKey(ev.killer ?? '') === 'you'
          const killerSameName = !ev.bySelf && ev.killer != null && idKey(ev.killer) === key
          if (charmedPetDiesOnDeathLine({ killerIsYou, killerSameName })) {
            this.retireEntity(this.charmedKey!, ev.ts)
          }
        } else if (isBrokenCharm) {
          // A death naming the broken-charm entity (Task #37): the ex-pet is now a hostile mob
          // you're likely killing, so THIS death genuinely retires it — censoring its buffs so
          // the next charm of that name binds a fresh entity (rule #3). It's fully retired now,
          // not conservatively kept: charm no longer protects it (the twin-ambiguity that made
          // us keep a LIVE charmed pet doesn't apply once the charm has broken).
          this.retireEntity(this.brokenCharmKey!, ev.ts)
        } else {
          // A plain hostile death censors any open/active instance bound to it.
          this.retireEntity(key, ev.ts, { hostileOnly: true })
        }
        if (key === this.petTargetKey) {
          this.petTargetKey = undefined
          this.petTargetDisplay = undefined
        }
        break
      }
      case 'zone': {
        this.onZone(ev.ts)
        break
      }
      default:
        return
    }
  }

  onTick(nowMs: number): void {
    this.maybeLandPendingByTime(nowMs)
    this.sweepHygiene(nowMs)
  }

  private maybeLandPendingByTime(now: number): void {
    if (this.pending && now - this.pending.beganTs >= LAND_TIMEOUT_MS) {
      this.landPending(now)
    }
  }

  /**
   * Promote the pending cast to a landed/active INSTANCE (Task #35). Binds it to a TARGET
   * ENTITY so a later zone/death censors it. Self/pet mining is byte-identical to Task #30.
   */
  private landPending(_now: number): void {
    const p = this.pending
    if (!p) return
    this.pending = null
    const landedTs = p.beganTs

    const disp = this.inferCastDisposition(p.key, p.emoteSubjectKey)
    const eKey = this.entityKeyFor(disp)
    const iKey = instanceKey(p.key, eKey)
    // Refresh censoring: replacing the same instance discards a prior open cast's pairing.
    this.open.set(iKey, { spell: p.spell, spellKey: p.key, entityKey: eKey, landedTs, disp })

    if (this.everFaded.has(p.key)) {
      this.active.set(iKey, this.buildActive(p.spell, p.key, eKey, landedTs, false, disp))
      // ILLUSION EXCLUSIVITY (Task #36): landing an illusion cast replaces any prior
      // illusion on the same entity.
      if (this.isIllusion(p.key)) this.clearIllusionsOn(eKey, iKey)
    }
    this.dirty = true
  }

  /**
   * Apply a buff from an EXACT chat MESSAGE match (Task #34/#35). Confident, immediate,
   * non-provisional, messageDriven. `target` is 'self' for a cast-on-you / self-heal line,
   * else the named target (pet/player/mob) — bound to THAT entity's key.
   */
  private applyMessageBuff(
    spell: string,
    target: 'self' | string,
    ts: number,
    illusion: boolean,
    durationMs: number | null
  ): void {
    if (durationMs == null && !illusion) return
    const key = spellKey(spell)
    // A SELF apply of a DETRIMENTAL spell is an incoming debuff a MOB cast on the player —
    // not the player's own buff. Skip it (the bar shows only the player's beneficial buffs).
    if (target === 'self' && this.classOf(key) === 'debuff') return
    this.everFaded.add(key)
    if (this.pending && this.pending.key === key) this.pending = null

    const self = target === 'self'
    const disp: EntityDisposition = self ? 'self' : this.dispForNamedTarget(target)
    const eKey = self ? SELF_KEY : idKey(target)
    const iKey = instanceKey(key, eKey)
    // Remember the target's display casing so the row's target chip reads "Cazic-Thule",
    // not the lowercased key (Task #35).
    if (!self) this.namedEntityDisplay.set(eKey, target)
    const permanent =
      self && illusion && this.permanentIllusionOwnedTs != null && ts >= this.permanentIllusionOwnedTs

    // The message is GROUND TRUTH for this cast's target. Drop any cast-timing-inferred
    // instance of the SAME spell (a provisional / unknown-hostile guess from the castBegin)
    // so we don't double-list the spell as both an inferred and a message-bound instance.
    for (const [ik, a] of [...this.active]) {
      if (ik === iKey) continue
      if (spellKey(a.spell) === key && (a.provisional || a.inferredTarget)) {
        this.active.delete(ik)
        this.open.delete(ik)
      }
    }

    if (!permanent) {
      this.open.set(iKey, { spell, spellKey: key, entityKey: eKey, landedTs: ts, disp })
    } else {
      this.open.delete(iKey)
    }

    this.active.set(
      iKey,
      this.buildActive(spell, key, eKey, ts, false, disp, { messageDriven: true, permanent })
    )
    // ILLUSION EXCLUSIVITY (Task #36): a new illusion apply on this entity replaces any
    // prior illusion active on it (self OR pet). Only one illusion per entity at a time.
    if (illusion) this.clearIllusionsOn(eKey, iKey)
    this.dirty = true
  }

  /** Resolve an ambiguous landing-message apply (Task #34) to the candidate the player cast. */
  private resolveCandidate(
    cands: { name: string; durationMs: number | null; illusion: boolean }[]
  ): { name: string; durationMs: number | null; illusion: boolean } | null {
    if (cands.length === 0) return null
    if (cands.length === 1) return cands[0]
    let best: { name: string; durationMs: number | null; illusion: boolean } | null = null
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
      const k = spellKey(c.name)
      for (const a of this.active.values()) if (spellKey(a.spell) === k) return c
    }
    return null
  }

  /** Disposition for a named message target: a live pet, else hostile. */
  private dispForNamedTarget(target: string): EntityDisposition {
    const k = idKey(target)
    if (this.charmedKey && k === this.charmedKey) return 'charmed'
    if (this.summonedKey && k === this.summonedKey) return 'summoned'
    return 'hostile'
  }

  /**
   * AUTHORITATIVE removal (Task #34): a msg_wears_off proves the SELF instance expired NOW.
   * Pairs a duration sample if the self open cast exists, then clears that instance.
   */
  private removeAuthoritative(key: string, entityKey: string, ts: number): void {
    const iKey = instanceKey(key, entityKey)
    const spell = this.active.get(iKey)?.spell ?? this.samples.get(key)?.spell ?? key
    this.everFaded.add(key)
    this.recordFade(key, entityKey, spell, ts)
  }

  /**
   * Infer the target disposition of a cast at LAND time from the current entity state, a
   * LEARNED landing emote (Task #33), and the spell's class. A learned self-emote proves a
   * SELF cast even while a pet is live. A debuff → the inferred hostile fight target. Else
   * the live pet, else self.
   */
  private inferCastDisposition(key: string, emoteSubjectKey?: string): EntityDisposition {
    if (emoteSubjectKey === SELF_KEY) return 'self'
    if (emoteSubjectKey && emoteSubjectKey !== SELF_KEY) {
      if (this.charmedKey && emoteSubjectKey === this.charmedKey) return 'charmed'
      if (this.summonedKey && emoteSubjectKey === this.summonedKey) return 'summoned'
      return this.summonedKey ? 'summoned' : 'charmed'
    }
    if (this.classOf(key) === 'debuff') return 'hostile'
    if (this.charmedKey) return 'charmed'
    if (this.summonedKey) return 'summoned'
    return 'self'
  }

  /** The canonical entity key a cast of this disposition binds to. */
  private entityKeyFor(disp: EntityDisposition): string {
    if (disp === 'self') return SELF_KEY
    if (disp === 'summoned') return this.summonedKey ?? SELF_KEY
    if (disp === 'charmed') return this.charmedKey ?? SELF_KEY
    // hostile debuff: the inferred fight target, if known; else a stable 'unknown' bucket.
    return this.petTargetKey ?? 'unknown-hostile'
  }

  /** Resolve a buffFade's raw target into an entity key + disposition. */
  private fadeTargetEntity(rawTarget?: string): { entityKey: string; disp: EntityDisposition } {
    if (!rawTarget) return { entityKey: SELF_KEY, disp: 'self' }
    if (rawTarget === 'pet') {
      // Possessive 'Your pet's …' — resolve against the CURRENT pet entity.
      const petKey = this.currentPetKey()
      const disp = classifyFadeTarget('pet', this.petState())
      return { entityKey: petKey ?? 'pet', disp }
    }
    const nameKey = idKey(rawTarget)
    const disp = classifyFadeTarget(nameKey, this.petState())
    return { entityKey: nameKey, disp }
  }

  /**
   * Pair a fade with its open landed instance (a duration sample) and clear the active.
   *
   * The fade names the REAL target entity; a cast-timing open cast, though, may have bound
   * to an INFERRED entity (self / the-live-pet / an inferred hostile) that differs from the
   * fade's named target — the model can't always predict the exact target at cast time
   * (castBegin carries none). So we pair the exact (spell,entity) instance when present,
   * else fall back to ANY open cast of the same spell — preserving per-spell duration mining
   * (unchanged from the pre-#35 per-spell samples) while keeping per-instance DISPLAY. We
   * prefer the SAME-entity instance, then the oldest matching open cast.
   */
  private recordFade(key: string, entityKey: string, spell: string, fadeTs: number): void {
    const iKey = instanceKey(key, entityKey)
    let openKey: string | undefined
    if (this.open.has(iKey)) {
      openKey = iKey
    } else {
      let oldest = Infinity
      for (const [ok, o] of this.open) {
        if (o.spellKey === key && o.landedTs < oldest) {
          oldest = o.landedTs
          openKey = ok
        }
      }
    }
    if (openKey) {
      const open = this.open.get(openKey)!
      const dur = fadeTs - open.landedTs
      if (dur > 0 && dur <= MAX_SAMPLE_MS) this.addSample(key, spell, dur)
      this.open.delete(openKey)
      this.active.delete(openKey)
    }
    // Also clear the exact-target instance's active (the fade proves THAT entity's copy is
    // gone), even if the paired open cast was a different-entity instance.
    this.active.delete(iKey)
    this.dirty = true
  }

  /** Session-gap clear (Task #33, finding #5): wipe live actives/opens/pending + pets. */
  private clearAllForGap(): void {
    const changed = this.active.size > 0 || this.open.size > 0 || this.pending != null
    this.active.clear()
    this.open.clear()
    this.pending = null
    this.charmedKey = undefined
    this.charmedDisplay = undefined
    this.brokenCharmKey = undefined
    this.brokenCharmDisplay = undefined
    this.summonedKey = undefined
    this.summonedDisplay = undefined
    this.petTargetKey = undefined
    this.petTargetDisplay = undefined
    if (changed) this.dirty = true
  }

  /** Hygiene sweep (Task #33, finding #6): retire any active past its per-spell cap. */
  private sweepHygiene(now: number): void {
    let changed = false
    for (const [ik, a] of [...this.active]) {
      if (a.provisional) continue
      if (a.permanent) continue
      const sKey = spellKey(a.spell)
      const dbMs = this.dbDurationFor(sKey)
      const cap = Math.max(hygieneCapMs(a.p75, a.n), dbMs != null ? 2 * dbMs : 0)
      if (now - a.startedTs > cap) {
        this.active.delete(ik)
        this.open.delete(ik)
        changed = true
      }
    }
    if (changed) this.dirty = true
  }

  /** playerDeath strips SELF buffs: censor open SELF casts + clear their actives. */
  private onPlayerDeath(): void {
    let changed = false
    for (const [ik, o] of [...this.open]) {
      if (o.entityKey === SELF_KEY) {
        this.open.delete(ik)
        changed = true
      }
    }
    for (const [ik, a] of [...this.active]) {
      if (a.self) {
        this.active.delete(ik)
        changed = true
      }
    }
    if (this.pending) {
      // A pending self cast is abandoned (death interrupts it). A debuff/pet cast survives.
      const disp = this.inferCastDisposition(this.pending.key, this.pending.emoteSubjectKey)
      if (disp === 'self') {
        this.pending = null
        changed = true
      }
    }
    if (changed) this.dirty = true
  }

  /**
   * Retire an ENTITY (Task #35, generalized — NO pet-specific branches). Censors every open
   * cast + active instance bound to `entityKey`. Used on uncharm / summoned-pet death /
   * hostile death / zone-left-behind / single-pet succession — the pet is just the entity
   * currently claimed. Buffs on other players / arbitrary entities are censored the same way.
   *
   * `hostileOnly` guards a plain-mob death: only DEBUFF instances on that mob are censored
   * (a friendly buff can't be on a hostile), and an unknown-hostile debuff bucket is swept
   * too (its inferred target just died).
   */
  private retireEntity(entityKey: string, _ts: number, opts?: { hostileOnly?: boolean }): void {
    let changed = false
    for (const [ik, o] of [...this.open]) {
      const match = opts?.hostileOnly
        ? o.disp === 'hostile' && (o.entityKey === entityKey || o.entityKey === 'unknown-hostile')
        : o.entityKey === entityKey
      if (match) {
        this.open.delete(ik)
        changed = true
      }
    }
    for (const [ik, a] of [...this.active]) {
      const aKey = this.instanceEntityKey(ik)
      const match = opts?.hostileOnly
        ? a.cls === 'debuff' && (aKey === entityKey || aKey === 'unknown-hostile' || a.inferredTarget === true)
        : aKey === entityKey
      if (match) {
        this.active.delete(ik)
        changed = true
      }
    }
    // Clear the entity from pet state if it was a pet (charmed / broken-charm / summoned).
    if (entityKey === this.charmedKey) {
      this.charmedKey = undefined
      this.charmedDisplay = undefined
    }
    if (entityKey === this.brokenCharmKey) {
      this.brokenCharmKey = undefined
      this.brokenCharmDisplay = undefined
    }
    if (entityKey === this.summonedKey) {
      this.summonedKey = undefined
      this.summonedDisplay = undefined
    }
    if (changed) this.dirty = true
  }

  /** Extract the entity key from an instance key. */
  private instanceEntityKey(iKey: string): string {
    const i = iKey.indexOf(SEP)
    return i >= 0 ? iKey.slice(i + 1) : SELF_KEY
  }

  /**
   * ZONE (the user's rule): the player keeps self buffs; a SUMMONED pet follows and keeps
   * its buffs; a CHARMED pet is LEFT BEHIND (retire + censor); hostile mobs are left behind
   * (censor open debuffs). Uses the SHARED isLeftBehindOnZone rule.
   */
  private onZone(ts: number): void {
    let changed = false
    for (const [ik, o] of [...this.open]) {
      let leftBehind: boolean
      if (o.disp === 'self') leftBehind = false
      else if (o.disp === 'summoned') leftBehind = isLeftBehindOnZone('summoned') // false
      else if (o.disp === 'charmed') leftBehind = isLeftBehindOnZone('charmed') // true
      else leftBehind = true // hostile → left behind
      if (leftBehind) {
        this.open.delete(ik)
        changed = true
      }
    }
    for (const [ik, a] of [...this.active]) {
      const leftBehind =
        a.cls === 'debuff' || a.disposition === 'charmed' || a.disposition === 'hostile'
      if (leftBehind) {
        this.active.delete(ik)
        changed = true
      }
    }
    if (this.charmedKey) {
      this.charmedKey = undefined
      this.charmedDisplay = undefined
      changed = true
    }
    // A broken-charm entity is ALSO left behind on a zone (Task #37) — it's still bound to its
    // key, so its actives were censored by the 'charmed'-disposition sweep above; drop its
    // state so a later charm of that name is a fresh entity (rule #3, the zone-between case).
    if (this.brokenCharmKey) {
      this.brokenCharmKey = undefined
      this.brokenCharmDisplay = undefined
      changed = true
    }
    this.petTargetKey = undefined
    this.petTargetDisplay = undefined
    if (this.pending) {
      const disp = this.inferCastDisposition(this.pending.key, this.pending.emoteSubjectKey)
      if (disp === 'charmed' || disp === 'hostile') {
        this.pending = null
        changed = true
      }
    }
    if (changed) this.dirty = true
  }

  private addSample(key: string, spell: string, durMs: number): void {
    let s = this.samples.get(key)
    if (!s) {
      s = { spell, samples: [] }
      this.samples.set(key, s)
    }
    s.samples.push(durMs)
    // Restat every live instance of this spell (they share the per-spell stats).
    for (const [ik, a] of [...this.active]) {
      if (spellKey(a.spell) === key) {
        this.active.set(
          ik,
          this.buildActive(a.spell, key, this.instanceEntityKey(ik), a.startedTs, a.provisional, a.disposition, {
            messageDriven: a.messageDriven,
            permanent: a.permanent
          })
        )
      }
    }
    this.dirty = true
  }

  private statFor(key: string): BuffStat | null {
    const s = this.samples.get(key)
    if (!s || s.samples.length === 0) return null
    const sorted = [...s.samples].sort((a, b) => a - b)
    const est = this.estimateFor(key)
    return {
      spell: s.spell,
      cls: this.classOf(key),
      n: sorted.length,
      medianMs: percentile(sorted, 0.5),
      p25: percentile(sorted, 0.25),
      p75: percentile(sorted, 0.75),
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
      dbDurationMs: this.dbDurationFor(key),
      estimateMs: est.ms,
      estimatorSource: est.source
    }
  }

  private estimateFor(key: string): { ms: number | null; source: 'db' | 'observed' | undefined } {
    const dbMs = this.dbDurationFor(key)
    if (dbMs != null) return { ms: dbMs, source: 'db' }
    const s = this.samples.get(key)
    if (!s || s.samples.length === 0) return { ms: null, source: undefined }
    const recent = s.samples.slice(-RECENT_SAMPLE_WINDOW)
    return { ms: Math.max(...recent), source: 'observed' }
  }

  /**
   * The buff/debuff class of a spell (Task #35). SPELL PROPERTY:
   *   (1) DB spellType — Detrimental → 'debuff', Beneficial → 'buff' — authoritative.
   *   (2) FALLBACK for a spell absent from the DB: plurality of fade dispositions — hostile
   *       majority → 'debuff', else 'buff'.
   * There is NO 'pet' class; who the buff is on is an entity binding, not a class.
   */
  private classOf(key: string): BuffClass {
    const st = this.db?.byKey.get(key)?.spellType
    if (st === 'Detrimental') return 'debuff'
    if (st === 'Beneficial') return 'buff'
    const t = this.dispTally.get(key)
    if (!t) return 'buff'
    const friendly = t.self + t.summoned + t.charmed
    return t.hostile > friendly ? 'debuff' : 'buff'
  }

  private buildActive(
    spell: string,
    key: string,
    entityKey: string,
    startedTs: number,
    provisional?: boolean,
    dispOverride?: EntityDisposition,
    opts?: { messageDriven?: boolean; permanent?: boolean }
  ): ActiveBuff {
    const st = this.statFor(key)
    const est = this.estimateFor(key)
    const cls = this.classOf(key)
    const disp: EntityDisposition | undefined = dispOverride
    // A DEBUFF is never the player's own buff, even if cast-timing bound it to the self key
    // before its class was known (no DB, first cast): a debuff on 'self' really means "an
    // inferred hostile target we couldn't name yet" (Task #35). Present it as non-self.
    const self = entityKey === SELF_KEY && cls !== 'debuff'
    // Target label + inference. Self: none. Otherwise the bound entity's display name; a
    // debuff whose target was inferred (no confirmed message) is flagged inferredTarget.
    let target: string | undefined
    let inferredTarget = false
    if (self) {
      target = undefined
    } else if (cls === 'debuff' && entityKey === SELF_KEY) {
      // Self-keyed debuff = an inferred, not-yet-named hostile target.
      target = this.petTargetDisplay
      inferredTarget = true
    } else if (disp === 'summoned' && this.summonedKey === entityKey) {
      target = this.summonedDisplay
    } else if (disp === 'charmed' && this.charmedKey === entityKey) {
      target = this.charmedDisplay
    } else if (entityKey === this.petTargetKey) {
      target = this.petTargetDisplay
      if (cls === 'debuff') inferredTarget = true
    } else if (entityKey === 'unknown-hostile') {
      target = undefined
      inferredTarget = true
    } else {
      target = this.entityDisplayFor(entityKey)
      // A cast-timing-inferred debuff target (no confirming message) is a best guess.
      if (cls === 'debuff' && !opts?.messageDriven) inferredTarget = true
    }
    const permanent = !!opts?.permanent
    return {
      spell,
      cls,
      self,
      disposition: disp,
      startedTs,
      estimatedMs: permanent ? null : est.ms,
      p25: st?.p25 ?? null,
      p75: st?.p75 ?? null,
      n: st?.n ?? 0,
      target,
      ...(inferredTarget ? { inferredTarget: true } : {}),
      ...(provisional ? { provisional: true } : {}),
      ...(est.source && !permanent ? { durationSource: est.source } : {}),
      ...(permanent ? { permanent: true } : {}),
      ...(opts?.messageDriven ? { messageDriven: true } : {})
    }
  }

  /** Best display name for an entity key (a pet, the inferred target, a named mob, else key). */
  private entityDisplayFor(entityKey: string): string | undefined {
    if (entityKey === this.summonedKey) return this.summonedDisplay
    if (entityKey === this.charmedKey) return this.charmedDisplay
    if (entityKey === this.petTargetKey) return this.petTargetDisplay
    if (entityKey === 'unknown-hostile' || entityKey === 'pet') return undefined
    return this.namedEntityDisplay.get(entityKey) ?? entityKey
  }

  private buildSnap(): BuffsSnap {
    const stats: Record<string, BuffStat> = {}
    for (const key of this.everFaded) {
      const st = this.statFor(key)
      if (st) {
        stats[key] = st
      } else {
        const disp = this.samples.get(key)?.spell
        const dbMs = this.dbDurationFor(key)
        const dbSpell = this.db?.byKey.get(key)?.name
        stats[key] = {
          spell: disp ?? dbSpell ?? key,
          cls: this.classOf(key),
          n: 0,
          medianMs: null,
          p25: null,
          p75: null,
          minMs: null,
          maxMs: null,
          dbDurationMs: dbMs,
          estimateMs: dbMs,
          estimatorSource: dbMs != null ? 'db' : undefined
        }
      }
    }
    return {
      active: [...this.active.values()].sort((a, b) => a.startedTs - b.startedTs),
      stats,
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
    if (!this.dirty) return null
    this.dirty = false
    return { seq: this.seq, delta: this.buildSnap() }
  }
}
