// buffs module (Task #19; latency+coverage Task #30; ENTITY-AWARE simulation Task #32)
// — a log-mined buff/debuff-duration model AND a small who/what/when simulation of
// which ENTITY each buff is bound to. All state is derived from events.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED IN TASK #32 (the entity model). Buffs now BIND to WHO they're on:
//   self | summoned pet | charmed pet | hostile mob (debuff target).
// The module tracks a tiny entity state fed by charm/uncharm/petClaim/death/zone —
// conceptually parallel to the combat WorldModel, and SHARING its pure lifecycle
// rules via combat/entityRules.ts (isLeftBehindOnZone / deathCensors /
// classifyFadeTarget). It does NOT touch the engine's live world instance — modules
// are independent event consumers.
//
// The point of the entity model is CENSORING unobservable fades so they never pollute
// duration stats:
//   - ZONE: the player keeps self buffs; a SUMMONED pet follows and keeps its buffs; a
//     CHARMED pet is LEFT BEHIND (charm can't survive a zone) and hostile mobs are left
//     behind too → their open casts can NEVER be observed fading, so they are CENSORED
//     (no sample) and removed from the active display. (This kills the old 23.8h "Swift
//     Like the Wind" outlier class — a pet buff whose fade landed only after re-charm/
//     zone, producing a bogus multi-hour duration.)
//   - DEATH: an entity's death strips + censors its buffs/debuffs (deathCensors()).
//     playerDeath clears self (existing behavior).
//
// DEBUFFS are a distinct class (e.g. Languid Pace, an enchanter slow on enemies):
//   - classified per spell by observed fade-target disposition — a spell that has EVER
//     faded on a HOSTILE entity is a debuff.
//   - a debuff NEVER appears as a self buff (guaranteed: a debuff's provisional/active
//     entry is bound to the inferred hostile target, class 'debuff', never 'self').
//   - active-debuff target is INFERRED (castBegin carries no target): bound to the
//     current charmed/summoned pet's fight target if cheaply known, else surfaced with
//     `inferredTarget:true` so the UI can show a "target: inferred" chip — never a
//     silent guess.
//
// ─────────────────────────────────────────────────────────────────────────────
// MINING MODEL (byte-identical to Task #30 for the SELF/PET path — regression-gated):
//   castBegin(S)   → S becomes the PENDING cast (replaces prior pending) AND is shown
//                    OPTIMISTICALLY right away (provisional) if S is a known buff/debuff.
//   castFizzle(S) / castInterrupted(S) → clears pending S + retracts its provisional.
//   buffFade(S,target?) → S's active entry expired on `target`; pairs with the matching
//                    landed cast → duration sample; records the target disposition
//                    (self/pet/hostile) that CLASSIFIES the spell.
//   playerDeath    → strips ALL self buffs; censors open SELF casts.
//
// LANDING (mining) APPROXIMATION (unchanged): a pending cast LANDS when neither a fizzle
// nor interrupt of S occurs before EITHER the next castBegin OR 15s of log-time elapse.
// A buffFade of the pending spell also implies it landed. Landed ts = cast-BEGIN ts.
//
// CENSORING (the Task #32 addition to mining): an open cast is discarded with NO sample
// when its BOUND ENTITY is retired before the fade — zone-left-behind (charmed pet or
// hostile), or entity death — in addition to the existing recast-refresh and playerDeath
// censors. Self buffs and summoned-pet buffs survive zoning (not censored).

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import type { ActiveBuff, BuffClass, BuffStat, BuffsDelta, BuffsSnap } from '../../shared/types'
import { idKey, spellCanonKey } from '../log/parser'
import {
  charmedPetDiesOnDeathLine,
  classifyFadeTarget,
  isLeftBehindOnZone,
  type EntityDisposition,
  type PetKind
} from '../combat/entityRules'

/** Land a pending cast this many ms after castBegin if nothing cleared it first. */
const LAND_TIMEOUT_MS = 15_000

/**
 * Sanity ceiling on a mined duration sample. No EQ Legends buff lasts anywhere near
 * this long (the longest observed real buffs — Focus/Intensify Death — are ~1h). A
 * land→fade gap beyond this is DEFINITIONALLY a missed censor: the real fade was never
 * observed (the entity zoned/died/was re-charmed unobserved) and the open cast paired
 * with a much-later, unrelated fade of the same spell. Such a "sample" is DROPPED
 * (censored), not recorded — this is the final backstop for the unobservable-fade
 * outlier class (the 9-day Reckless Strength, 219h Spirit Armor pairings) that the
 * entity model's zone/death censors don't catch (e.g. an orphaned open cast across a
 * multi-day logoff with no intervening zone line in the scanned window).
 */
const MAX_SAMPLE_MS = 3 * 60 * 60_000 // 3 hours

/**
 * Session-gap boundary (Task #33, finding #5). An event-time gap of at least this long
 * means the player logged out (or was AFK past any buff duration): EQ buffs cannot
 * survive it, so ALL actives (self + pets) are CLEARED and their open casts CENSORED at
 * the gap boundary. Short relogs (< 30 min) keep state — buffs really do persist a quick
 * zone/relog. Real log has many such gaps (e.g. Aug 1 02:52 → 13:00, a 608-min logout).
 */
const SESSION_GAP_MS = 30 * 60_000 // 30 minutes

/**
 * Active-buff HYGIENE cap (Task #33, finding #6). Any active whose elapsed exceeds this
 * bound auto-retires (censored) — a buff that's run this far past its learned window was
 * really stripped by an unobserved event (death/zone/relog the model didn't catch). The
 * bound is per-spell: max(2×p75, ABSOLUTE) so a spell with a long learned duration still
 * gets slack, but nothing survives past the absolute floor. The "overdue · any moment"
 * display is only for MILDLY over p75; it must never show hours-old rows.
 */
const HYGIENE_ABSOLUTE_MS = 90 * 60_000 // 90 minutes when no/low stats
function hygieneCapMs(p75: number | null, n: number): number {
  const stat = p75 != null && n >= 2 ? 2 * p75 : 0
  return Math.max(stat, HYGIENE_ABSOLUTE_MS)
}

/** Window after a castBegin within which a landing emote is attributed to that cast. */
const EMOTE_WINDOW_MS = 5_000
/**
 * An emote TEXT must appear adjacent to a cast this many times before it is TRUSTED as a
 * real landing emote (Task #33, finding #2). This is the noise filter: a spell's true
 * landing emote ("You feel much faster.") recurs after every cast of it; a coincidental
 * flavor line (a DoT tick's "You feel your skin ignite.") does not consistently sit in a
 * cast window, so it never reaches the threshold and never binds a cast's target. NOTE
 * this gates on the emote TEXT (is it a landing emote at all?), NOT on a spell↔emote
 * binding — a spell can be cast on both self and pet (Swift Like the Wind is, in the real
 * log), so the per-cast emote SUBJECT is the only honest per-cast target discriminator.
 */
const EMOTE_MIN_OBSERVATIONS = 2

/** Map a fade-target disposition to the buff CLASS surfaced to the UI. */
function classForDisposition(d: EntityDisposition): BuffClass {
  return d === 'hostile' ? 'debuff' : d === 'self' ? 'self' : 'pet'
}

/** A cast that has landed (produced a buff) and is awaiting its next fade. */
interface OpenCast {
  spell: string
  key: string
  landedTs: number
  /** The entity disposition this cast is bound to (for censoring on zone/death). */
  disp: EntityDisposition
  /** Canonical name key of the bound entity ('pet' sentinel / mob key / undefined self). */
  boundKey?: string
  /** True when `disp` came from a trusted landing EMOTE — never re-bind these (the emote
   *  is ground truth for this cast's target; a later pet claim must not steal it). */
  emoteBound?: boolean
}

/** A cast in flight (You begin casting …) not yet landed/cleared. */
interface Pending {
  spell: string
  key: string
  beganTs: number
  /** Refresh whose new startedTs is staged until confirmation (see landPending). */
  stagedRefresh: boolean
  /**
   * The landing emote seen within EMOTE_WINDOW_MS of this cast (Task #33), if any — its
   * subject ('self' or a pet name key) overrides the inferred cast disposition at land
   * time. Only trusted once the spell→emote association is LEARNED (≥2 observations).
   */
  emoteSubjectKey?: string
}

/** Per-spell accumulated duration samples + display name + observed classes. */
interface SpellSamples {
  spell: string
  samples: number[]
}

/**
 * Canonical spell key (case-stable, RANK-STRIPPED — Task #33). Delegates to the shared
 * parser helper so a ranked cast ("Swift Like the Wind I") keys the same as its
 * rank-less fade ("Swift Like the Wind"). Display name keeps the rank.
 */
function spellKey(s: string): string {
  return spellCanonKey(s)
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

  /** The single cast currently in flight (You begin …), or null. */
  private pending: Pending | null = null
  /** Landed casts awaiting their fade, keyed by spell key (one open cast per spell). */
  private open = new Map<string, OpenCast>()
  /** Currently-active (landed OR provisional, not faded) buffs, keyed by spell key. */
  private active = new Map<string, ActiveBuff>()
  /** Mined samples per spell key. */
  private samples = new Map<string, SpellSamples>()
  /** Spell keys ever seen fading — the buff discriminator. */
  private everFaded = new Set<string>()
  /**
   * Per-spell fade-disposition tally (self/summoned/charmed/hostile). The spell's
   * CLASS is a PLURALITY VOTE over these, not a sticky "ever hostile" flag: a real pet
   * buff (e.g. Swift Like the Wind) occasionally fades during a charm gap and would be
   * mislabeled a debuff by a sticky rule; a real debuff (Languid Pace) is hostile in
   * the majority. Rule 5(a) — a debuff never appears as self — holds because 'self'
   * only wins when self is the plurality (see classOf). */
  private dispTally = new Map<string, { self: number; summoned: number; charmed: number; hostile: number }>()
  /** Last fade target label per spell key ('pet' | mob name | undefined) — for display. */
  private fadeTarget = new Map<string, string | undefined>()
  /** Last fade disposition per spell key — for open-cast entity binding at land time. */
  private fadeDisp = new Map<string, EntityDisposition>()

  // ── emote learning (Task #33): recognize real landing-emote TEXTS ──
  /**
   * How many times each emote TEXT has appeared adjacent (≤ EMOTE_WINDOW_MS) to some
   * cast. Once a text reaches EMOTE_MIN_OBSERVATIONS it is a RECOGNIZED landing emote and
   * its SUBJECT is trusted to discriminate each cast's target (self vs pet). This filters
   * coincidental flavor from real landing emotes without assuming a spell targets only
   * self or only pet (it may do both). In production the full-log replay recognizes the
   * common landing emotes long before the live tail; golden-window tests prime it with a
   * real earlier excerpt of the same session (mirroring that replay).
   */
  private emoteTextCount = new Map<string, number>()

  // ── session-gap tracking (Task #33, finding #5) ──
  /** ts of the last event folded — to detect a ≥ SESSION_GAP_MS logout gap. */
  private lastEventTs = 0

  // ── entity state (the who/what) — a tiny parallel to the combat WorldModel ──
  /** Canonical name key of the live charmed pet, or undefined. */
  private charmedKey?: string
  private charmedDisplay?: string
  /** Canonical name key of the live summoned pet, or undefined. */
  private summonedKey?: string
  private summonedDisplay?: string
  /** The pet's CURRENT hostile fight target (canonical key + display), if cheaply
   *  known from recent charm/cc/death context — used to bind debuff casts. */
  private petTargetKey?: string
  private petTargetDisplay?: string

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
    this.fadeTarget = new Map()
    this.fadeDisp = new Map()
    this.emoteTextCount = new Map()
    this.lastEventTs = 0
    this.charmedKey = undefined
    this.charmedDisplay = undefined
    this.summonedKey = undefined
    this.summonedDisplay = undefined
    this.petTargetKey = undefined
    this.petTargetDisplay = undefined
    this.dirty = false
  }

  /** Current pet identities, for the shared classifyFadeTarget helper. */
  private petState(): { charmedKey?: string; summonedKey?: string } {
    return { charmedKey: this.charmedKey, summonedKey: this.summonedKey }
  }

  /** Pet kind for the 'pet' possessive-form fade (summoned preferred, else charmed). */
  private petKindForPossessive(): PetKind | undefined {
    if (this.summonedKey) return 'summoned'
    if (this.charmedKey) return 'charmed'
    return undefined
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    // Session-gap clear (Task #33, finding #5): a long event-time gap = logout/AFK past
    // any buff duration → clear ALL actives + censor opens at the boundary. Checked
    // BEFORE landing so a stale pending cast across the gap doesn't confirm into a buff.
    if (this.lastEventTs > 0 && ev.ts - this.lastEventTs >= SESSION_GAP_MS) {
      this.clearAllForGap()
    }
    this.lastEventTs = ev.ts
    // Time-based landing: any event with a timestamp can trip the pending cast's
    // 15s land timeout (the fold is time-ordered).
    this.maybeLandPendingByTime(ev.ts)
    // Hygiene sweep (Task #33, finding #6): retire any active run past its cap. Cheap;
    // runs on every event so an overdue row never persists into the snapshot.
    this.sweepHygiene(ev.ts)

    switch (ev.kind) {
      case 'castBegin': {
        this.landPending(ev.ts)
        const key = spellKey(ev.spell)
        const existing = this.active.get(key)
        const stagedRefresh = !!existing && !existing.provisional
        this.pending = { spell: ev.spell, key, beganTs: ev.ts, stagedRefresh }
        if (!existing && this.everFaded.has(key)) {
          this.active.set(key, this.buildActive(ev.spell, key, ev.ts, true))
          this.dirty = true
        }
        break
      }
      case 'spellEmote': {
        // A landing emote within EMOTE_WINDOW_MS of the pending cast discriminates that
        // cast's TARGET (Task #33, finding #2). Count the emote text (to recognize it as a
        // real landing emote) and, once recognized, stamp the pending cast's subject so
        // landPending binds it correctly — a self-emote ⇒ SELF buff even while a charmed
        // pet is live (the fix for the user's invisible self buffs).
        const p = this.pending
        if (p && ev.ts - p.beganTs <= EMOTE_WINDOW_MS && ev.ts >= p.beganTs && !p.emoteSubjectKey) {
          const n = (this.emoteTextCount.get(ev.text) ?? 0) + 1
          this.emoteTextCount.set(ev.text, n)
          if (n >= EMOTE_MIN_OBSERVATIONS) {
            p.emoteSubjectKey = ev.subject === 'self' ? 'self' : idKey(ev.subject)
          }
        }
        break
      }
      case 'castFizzle':
      case 'castInterrupted': {
        const key = spellKey(ev.spell)
        if (this.pending && this.pending.key === key) {
          const wasStagedRefresh = this.pending.stagedRefresh
          this.pending = null
          if (!wasStagedRefresh) {
            const a = this.active.get(key)
            if (a?.provisional) {
              this.active.delete(key)
              this.dirty = true
            }
          }
        }
        break
      }
      case 'buffFade': {
        const key = spellKey(ev.spell)
        this.everFaded.add(key)
        // Classify the fade by target disposition (self/summoned/charmed/hostile).
        const targetKey = ev.target ? (ev.target === 'pet' ? 'pet' : idKey(ev.target)) : undefined
        const disp = classifyFadeTarget(targetKey, this.petState())
        this.fadeDisp.set(key, disp)
        this.fadeTarget.set(key, ev.target)
        let tally = this.dispTally.get(key)
        if (!tally) {
          tally = { self: 0, summoned: 0, charmed: 0, hostile: 0 }
          this.dispTally.set(key, tally)
        }
        tally[disp]++
        // A fade of the pending spell implies that cast landed just now-ish.
        if (this.pending && this.pending.key === key) this.landPending(ev.ts)
        this.recordFade(key, ev.spell, ev.ts)
        break
      }
      case 'playerDeath': {
        this.onPlayerDeath()
        break
      }
      // ── entity lifecycle (the who/what state) ──
      case 'charm': {
        const newKey = idKey(ev.mob)
        // SINGLE-PET INVARIANT (Task #33, finding #3): one pet at a time. Charming a
        // DIFFERENT mob retires the prior charmed pet (its buffs can no longer be
        // observed fading). A summoned pet coexisting is likewise retired — claiming/
        // charming a new pet supersedes it (EQ swaps you to the new pet).
        if (this.charmedKey && this.charmedKey !== newKey) this.retireEntity('charmed', ev.ts)
        if (this.summonedKey) this.retireEntity('summoned', ev.ts)
        this.charmedKey = newKey
        this.charmedDisplay = ev.mob
        this.rebindPetBuffsToPet('charmed')
        // A fresh charm resets the inferred pet target (new fight).
        this.petTargetKey = undefined
        this.petTargetDisplay = undefined
        break
      }
      case 'petClaim': {
        // A petClaim can be either pet kind; if it names the charmed mob it's the
        // charmed pet (already tracked), otherwise it's a summoned (proper-named) pet.
        const key = idKey(ev.name)
        if (key !== this.charmedKey && key !== this.summonedKey) {
          // SINGLE-PET INVARIANT (finding #3): a NEW summoned pet retires the previous
          // summoned pet AND any live charmed pet (you can't hold both). This kills the
          // Gibober→Jenann succession bug where Gibober's Intensify Death open cast
          // paired with a fade 62 min later (long after Jenann replaced him).
          if (this.summonedKey) this.retireEntity('summoned', ev.ts)
          if (this.charmedKey) this.retireEntity('charmed', ev.ts)
          this.summonedKey = key
          this.summonedDisplay = ev.name
          this.rebindPetBuffsToPet('summoned')
        }
        break
      }
      case 'uncharm': {
        if (this.charmedKey === idKey(ev.mob)) this.retireEntity('charmed', ev.ts)
        break
      }
      case 'cc': {
        // The pet's current fight target (mez/root landed on it) — used to bind debuffs.
        this.petTargetKey = idKey(ev.mob)
        this.petTargetDisplay = ev.mob
        break
      }
      case 'death': {
        const key = idKey(ev.name)
        // A death line naming YOUR pet is twin-ambiguous (a same-named hostile the pet
        // was fighting vs the pet itself). The SHARED pure rule (world.ts semantics)
        // keeps the pet alive on such a line — the pet is retired only by uncharm/zone,
        // never censored by a name-only slain line. So a pet-name death does NOT retire
        // the pet; it only clears an inferred hostile target of the same name.
        const isSummoned = key === this.summonedKey
        const isCharmed = key === this.charmedKey
        if (isSummoned) {
          // A SUMMONED pet has a UNIQUE proper name (Xeneker, Gibober, Jenann…) — there
          // is no same-named hostile twin, so a "<Name> has been slain by <other>!" line
          // is UNAMBIGUOUSLY the pet's real death. Retire + censor its buffs (Task #33,
          // finding #4 — the "Intensify Death [Xeneker] 287h" bug: Xeneker died at
          // 20:22 but its open pet-buff cast never faded, leaving a stale multi-hour
          // active bound to a dead pet). The twin-ambiguity conservatism applies only to
          // CHARMED pets (common mob names). Slain-by-YOU still can't be your own pet.
          const killerIsYou = ev.bySelf || idKey(ev.killer ?? '') === 'you'
          if (!killerIsYou) this.retireEntity('summoned', ev.ts)
        } else if (isCharmed) {
          const killerIsYou = ev.bySelf || idKey(ev.killer ?? '') === 'you'
          const killerSameName = !ev.bySelf && ev.killer != null && idKey(ev.killer) === key
          if (charmedPetDiesOnDeathLine({ killerIsYou, killerSameName })) {
            this.retireEntity('charmed', ev.ts)
          }
          // else: keep the charmed pet (conservative — a common-named slain line is
          // twin-ambiguous). Fall through to hostile-target clearing below.
        } else {
          // A plain hostile death censors any open debuff bound to it.
          this.censorHostileEntity(key)
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

  /** Wall-clock heartbeat (Task #30): drive the 15s land timeout in real time; also
   *  sweep overdue actives (Task #33) so a stale row is retired even while the log idles. */
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
   * Promote the pending cast to a landed/active buff (MINING + CONFIRMATION). Binds
   * the open cast to a TARGET ENTITY (from the spell's last fade disposition) so a
   * later zone/death can censor it. Mining semantics for self/pet are byte-identical
   * to Task #30 (the `open`/`samples` path), plus per-entity censoring.
   */
  private landPending(_now: number): void {
    const p = this.pending
    if (!p) return
    this.pending = null
    const landedTs = p.beganTs

    // Bind the open cast to a TARGET ENTITY so zone/death can censor it. castBegin
    // carries no target, so infer the CURRENT target from the entity state + the
    // spell's learned class (Task #32):
    //   - a known DEBUFF (majority-hostile) → the inferred hostile fight target.
    //   - otherwise, prefer the live pet the player is buffing (charmed, else summoned);
    //     a charmed-pet buff MUST bind 'charmed' so a later zone/uncharm CENSORS it
    //     (this is what kills the 13h Clarity / 23.8h Swift outliers — an open cast on
    //     a left-behind pet can never be observed fading).
    //   - no live pet → self.
    const disp = this.inferCastDisposition(p.key, p.emoteSubjectKey)
    const boundKey = this.boundKeyFor(disp)
    // Refresh censoring: replacing the map entry discards a prior open cast's pairing.
    this.open.set(p.key, {
      spell: p.spell, key: p.key, landedTs, disp, boundKey,
      emoteBound: p.emoteSubjectKey != null
    })

    // Surface as a CONFIRMED active buff (only spells known to be buffs/debuffs show).
    if (this.everFaded.has(p.key)) {
      this.active.set(p.key, this.buildActive(p.spell, p.key, landedTs, false, disp))
    }
    this.dirty = true
  }

  /**
   * Infer the target disposition of a cast at LAND time from the current entity state,
   * a LEARNED landing emote (Task #33), and the spell's learned class. This is what
   * makes zone/death censoring correct: an open cast on the live charmed pet is bound
   * 'charmed', so the pet being left behind on a zone censors it (no bogus multi-hour
   * sample).
   *
   * The learned EMOTE is DECISIVE when present (finding #2): a self-emote ("You feel
   * much faster.") proves a SELF cast even while a charmed pet is live — this is the fix
   * for the user's exact complaint (their real self buffs were invisible because every
   * cast was assumed to target the charmed pet). A pet-name emote binds that pet.
   */
  private inferCastDisposition(key: string, emoteSubjectKey?: string): EntityDisposition {
    if (emoteSubjectKey === 'self') return 'self'
    if (emoteSubjectKey && emoteSubjectKey !== 'self') {
      // The emote names a subject: match it to a live pet, else treat as summoned pet
      // (a proper-named pet the emote proves the buff landed on).
      if (this.charmedKey && emoteSubjectKey === this.charmedKey) return 'charmed'
      if (this.summonedKey && emoteSubjectKey === this.summonedKey) return 'summoned'
      // Named subject that isn't a currently-tracked pet: still a pet the buff landed on.
      return this.summonedKey ? 'summoned' : 'charmed'
    }
    const cls = this.classOf(key)
    if (cls === 'debuff') return 'hostile'
    if (this.charmedKey) return 'charmed'
    if (this.summonedKey) return 'summoned'
    // No live pet: even a pet-classed spell has nowhere to land but the player, so bind
    // 'self' (a pet buff cast with no pet is really a self-cast or a misfire). Binding it
    // to a phantom pet would wrongly censor it on the next zone. When a pet IS live, the
    // pet-form binding above handles the Xeneker case (buff bound to the single pet →
    // censored on that pet's death), and a pet claimed moments AFTER a pet-buff cast is
    // handled by re-binding on retire (single-pet invariant censors all pet-class opens).
    return 'self'
  }

  /** The canonical name key an open cast of this disposition binds to (for censoring). */
  private boundKeyFor(disp: EntityDisposition): string | undefined {
    if (disp === 'self') return undefined
    if (disp === 'summoned') return this.summonedKey
    if (disp === 'charmed') return this.charmedKey
    // hostile debuff: the inferred fight target, if known.
    return this.petTargetKey
  }

  /** Pair a fade with its open landed cast (a duration sample) and clear active. */
  private recordFade(key: string, spell: string, fadeTs: number): void {
    const open = this.open.get(key)
    if (open) {
      const dur = fadeTs - open.landedTs
      // Record only plausible durations; a gap beyond MAX_SAMPLE_MS is a missed
      // censor (unobservable fade), so it's dropped rather than polluting stats.
      if (dur > 0 && dur <= MAX_SAMPLE_MS) this.addSample(key, spell, dur)
      this.open.delete(key)
    }
    this.active.delete(key)
    this.dirty = true
  }

  /**
   * Session-gap clear (Task #33, finding #5): a ≥ SESSION_GAP_MS event-time gap means a
   * logout/AFK past any buff duration. Clear ALL actives (self + pets), censor every open
   * cast (drop, no sample), abandon the pending cast, and retire pet entities — nothing
   * survives a logout. This is what stops a buff cast right before a long pause from
   * replaying as a live "active" for hours.
   */
  private clearAllForGap(): void {
    const changed = this.active.size > 0 || this.open.size > 0 || this.pending != null
    this.active.clear()
    this.open.clear()
    this.pending = null
    this.charmedKey = undefined
    this.charmedDisplay = undefined
    this.summonedKey = undefined
    this.summonedDisplay = undefined
    this.petTargetKey = undefined
    this.petTargetDisplay = undefined
    if (changed) this.dirty = true
  }

  /**
   * Hygiene sweep (Task #33, finding #6): retire (censor) any active whose elapsed has
   * run past its per-spell hygiene cap — a buff this far past its learned window was
   * really stripped by an unobserved event. Its open cast is dropped too (no sample). No
   * hours-old "overdue" rows ever reach the snapshot.
   */
  private sweepHygiene(now: number): void {
    let changed = false
    for (const [k, a] of [...this.active]) {
      if (a.provisional) continue // a still-casting entry hasn't started its clock
      const cap = hygieneCapMs(a.p75, a.n)
      if (now - a.startedTs > cap) {
        this.active.delete(k)
        this.open.delete(k)
        changed = true
      }
    }
    if (changed) this.dirty = true
  }

  /** playerDeath strips SELF buffs: censor open SELF casts + clear their actives. */
  private onPlayerDeath(): void {
    let changed = false
    for (const [k, o] of [...this.open]) {
      if (o.disp === 'self') {
        this.open.delete(k)
        changed = true
      }
    }
    for (const [k, a] of [...this.active]) {
      if (a.cls === 'self') {
        this.active.delete(k)
        changed = true
      }
    }
    // A pending self cast is also abandoned (death interrupts it).
    if (this.pending && (this.fadeDisp.get(this.pending.key) ?? 'self') === 'self') {
      this.pending = null
      changed = true
    }
    if (changed) this.dirty = true
  }

  /**
   * Retire one of YOUR pets: on uncharm/death/zone-left-behind/succession. Censors every
   * open cast + active bound to a PET (the fade can no longer be observed).
   *
   * SINGLE-PET INVARIANT (Task #33, finding #3+#4): there is exactly ONE pet at a time, so
   * a pet retirement censors EVERY pet-disposition open cast and EVERY pet-class active —
   * not just those whose boundKey matches the exact retiring name. This is what fixes the
   * Xeneker bug: an Intensify Death cast bound to the pet BEFORE the pet's name was known
   * (bound 'charmed' as a fallback) is still censored when the (summoned) pet Xeneker dies,
   * because both refer to the one live pet. Charmed-vs-summoned distinction only matters
   * for ZONE (summoned follows, charmed is left behind) — handled in onZone, not here.
   */
  private retireEntity(kind: 'charmed' | 'summoned', _ts: number): void {
    let changed = false
    for (const [k, o] of [...this.open]) {
      // Any pet-disposition open cast belongs to the one pet being retired.
      if (o.disp === 'charmed' || o.disp === 'summoned') {
        this.open.delete(k)
        changed = true
      }
    }
    for (const [k, a] of [...this.active]) {
      if (a.cls === 'pet') {
        this.active.delete(k)
        changed = true
      }
    }
    if (kind === 'charmed') {
      this.charmedKey = undefined
      this.charmedDisplay = undefined
    } else {
      this.summonedKey = undefined
      this.summonedDisplay = undefined
    }
    if (changed) this.dirty = true
  }

  /**
   * Re-bind recently-landed pet-class buffs to a NEWLY-acquired pet (Task #33, finding
   * #4). EQ names the pet only in a claim/charm line that can arrive SECONDS after you
   * buff it — e.g. Intensify Death cast at 19:52:31, Xeneker (the pet) claimed 19:57:42.
   * Such a cast lands bound 'self' (no pet was known yet); when the pet then appears, the
   * buff was really on it all along, so re-bind its open cast + active to the pet so the
   * pet's later death/retire CENSORS it (instead of a stale self buff lingering). Only
   * casts that landed within REBIND_WINDOW of the claim are re-bound (an old self buff
   * isn't retroactively a pet buff). Debuffs/self spells are never re-bound.
   */
  private rebindPetBuffsToPet(kind: 'charmed' | 'summoned'): void {
    const REBIND_WINDOW_MS = 10 * 60_000
    let changed = false
    for (const [k, o] of this.open) {
      if (o.disp !== 'self') continue
      if (o.emoteBound) continue // an emote proved this cast's target — never override it
      if (this.classOf(k) !== 'pet') continue
      if (this.lastEventTs - o.landedTs > REBIND_WINDOW_MS) continue
      o.disp = kind
      o.boundKey = kind === 'charmed' ? this.charmedKey : this.summonedKey
      const a = this.active.get(k)
      if (a) this.active.set(k, this.buildActive(a.spell, k, a.startedTs, a.provisional, kind))
      changed = true
    }
    if (changed) this.dirty = true
  }

  /** Censor open DEBUFF casts bound to a hostile entity that just died / was left behind. */
  private censorHostileEntity(hostileKey: string): void {
    let changed = false
    for (const [k, o] of [...this.open]) {
      if (o.disp === 'hostile' && (o.boundKey == null || o.boundKey === hostileKey)) {
        this.open.delete(k)
        changed = true
      }
    }
    for (const [k, a] of [...this.active]) {
      if (a.cls === 'debuff' && (a.target == null || idKey(a.target) === hostileKey || a.inferredTarget)) {
        this.active.delete(k)
        changed = true
      }
    }
    if (changed) this.dirty = true
  }

  /**
   * ZONE (the user's rule): the player keeps self buffs; the SUMMONED pet follows and
   * keeps its buffs; the CHARMED pet is LEFT BEHIND (retire + censor); hostile mobs are
   * left behind (censor open debuffs). Uses the SHARED isLeftBehindOnZone rule.
   */
  private onZone(ts: number): void {
    let changed = false
    // Censor every open cast whose bound entity is left behind by the zone.
    for (const [k, o] of [...this.open]) {
      let leftBehind: boolean
      if (o.disp === 'self') leftBehind = false
      else if (o.disp === 'summoned') leftBehind = isLeftBehindOnZone('summoned') // false
      else if (o.disp === 'charmed') leftBehind = isLeftBehindOnZone('charmed') // true
      else leftBehind = true // hostile → left behind
      if (leftBehind) {
        this.open.delete(k)
        changed = true
      }
    }
    // Remove active buffs on left-behind entities from display.
    for (const [k, a] of [...this.active]) {
      const leftBehind =
        a.cls === 'debuff' ||
        a.disposition === 'charmed' ||
        (a.cls === 'pet' && a.disposition !== 'summoned' && this.petKindForPossessive() === 'charmed')
      if (leftBehind) {
        this.active.delete(k)
        changed = true
      }
    }
    // The charmed pet + inferred hostile target are gone; the summoned pet follows.
    if (this.charmedKey) {
      this.charmedKey = undefined
      this.charmedDisplay = undefined
      changed = true
    }
    this.petTargetKey = undefined
    this.petTargetDisplay = undefined
    // A pending cast targeting a left-behind entity is abandoned.
    if (this.pending) {
      const d = this.fadeDisp.get(this.pending.key) ?? 'self'
      if (d === 'charmed' || d === 'hostile') {
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
    const a = this.active.get(key)
    // Preserve the active's bound disposition when restatting so a self-emoted buff
    // doesn't get reclassified into the pet group by the plurality vote (Task #33).
    if (a) this.active.set(key, this.buildActive(a.spell, key, a.startedTs, a.provisional, a.disposition))
    this.dirty = true
  }

  private statFor(key: string): BuffStat | null {
    const s = this.samples.get(key)
    if (!s || s.samples.length === 0) return null
    const sorted = [...s.samples].sort((a, b) => a - b)
    return {
      spell: s.spell,
      cls: this.classOf(key),
      n: sorted.length,
      medianMs: percentile(sorted, 0.5),
      p25: percentile(sorted, 0.25),
      p75: percentile(sorted, 0.75),
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1]
    }
  }

  /**
   * The display class of a spell key by PLURALITY VOTE over its fade dispositions:
   *   - self is the plurality           → 'self'
   *   - friendly (self+pet) ≥ hostile   → 'pet' (or 'self' if self dominates friendly)
   *   - hostile strictly dominates      → 'debuff'
   * This makes a real pet buff that occasionally fades during a charm gap a BUFF, and a
   * real debuff (majority hostile) a DEBUFF. Rule 5(a) holds: 'self' requires a self
   * plurality, which a debuff (majority hostile, ~zero self) can never have.
   */
  private classOf(key: string): BuffClass {
    const t = this.dispTally.get(key)
    if (!t) {
      const disp = this.fadeDisp.get(key)
      return disp ? classForDisposition(disp) : 'self'
    }
    const friendly = t.self + t.summoned + t.charmed
    if (t.hostile > friendly) return 'debuff'
    if (t.self >= t.summoned + t.charmed && t.self > 0) return 'self'
    return 'pet'
  }

  private buildActive(
    spell: string,
    key: string,
    startedTs: number,
    provisional?: boolean,
    /**
     * The disposition THIS cast landed with (Task #33), from a learned landing emote or
     * the land-time inference. When provided it OVERRIDES the spell's plurality class for
     * THIS active entry — so a self-emoted cast of a normally-pet spell (e.g. Swift Like
     * the Wind cast on the player while a charmed pet is live) renders as a SELF buff, not
     * dumped into the pet group. Absent (a provisional entry before land) → fall back to
     * the spell's learned class.
     */
    dispOverride?: EntityDisposition
  ): ActiveBuff {
    const st = this.statFor(key)
    const cls: BuffClass = dispOverride ? classForDisposition(dispOverride) : this.classOf(key)
    const disp: EntityDisposition | undefined = dispOverride ?? this.fadeDisp.get(key)
    // Target label + inference. Self: none. Pet: the pet's name/'pet' form. Debuff:
    // the inferred hostile fight target (or flagged inferred when unknown).
    let target: string | undefined
    let inferredTarget = false
    if (cls === 'debuff') {
      if (this.petTargetDisplay) {
        target = this.petTargetDisplay
        inferredTarget = true // castBegin has no target — this is an inference, not fact
      } else {
        target = undefined
        inferredTarget = true
      }
    } else if (cls === 'pet') {
      // Prefer the concrete pet name for the bound kind; else the last fade label.
      if (disp === 'summoned' && this.summonedDisplay) target = this.summonedDisplay
      else if (disp === 'charmed' && this.charmedDisplay) target = this.charmedDisplay
      else target = this.fadeTarget.get(key)
    } else {
      target = undefined // self
    }
    return {
      spell,
      cls,
      disposition: disp,
      startedTs,
      estimatedMs: st?.medianMs ?? null,
      p25: st?.p25 ?? null,
      p75: st?.p75 ?? null,
      n: st?.n ?? 0,
      target,
      ...(inferredTarget ? { inferredTarget: true } : {}),
      ...(provisional ? { provisional: true } : {})
    }
  }

  private buildSnap(): BuffsSnap {
    const stats: Record<string, BuffStat> = {}
    for (const key of this.everFaded) {
      const st = this.statFor(key)
      if (st) {
        stats[key] = st
      } else {
        const disp = this.samples.get(key)?.spell
        stats[key] = {
          spell: disp ?? key,
          cls: this.classOf(key),
          n: 0,
          medianMs: null,
          p25: null,
          p75: null,
          minMs: null,
          maxMs: null
        }
      }
    }
    return {
      active: [...this.active.values()].sort((a, b) => a.startedTs - b.startedTs),
      stats
    }
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
