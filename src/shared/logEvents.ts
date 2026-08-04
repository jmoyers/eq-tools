// The canonical, typed log-event stream. ONE parse pass over the EQ Legends log
// produces this discriminated union (see main/log/parser.ts). Both feeders (the
// historical scan and the live tailer) emit these onto the in-main bus
// (main/log/bus.ts); every consumer (loot/kills/levels/AA reducers, the combat
// engine, the coming world model) subscribes to the stream instead of running its
// own regexes. Keep this pure and serializable — no behavior, just data.

import type { DamageType, DamageCategory } from './combat'
import type { PoisonEffect, PoisonGroup } from './poisons'

/** Fields present on every event: a monotonic sequence, timestamp, and the raw line. */
export interface LogEventBase {
  /** Monotonic sequence across scan+tail for a character (feeder-owned). */
  seq: number
  /** Epoch millis from the bracketed timestamp. */
  ts: number
  /** The raw log line (post-`\r` strip), for display / debugging. */
  raw: string
}

/** `You have entered <zone>.` */
export interface ZoneEvent extends LogEventBase {
  kind: 'zone'
  zone: string
}

/**
 * Where a looted-and-routed item went (Tasks #40/#47). The held-vs-gone rule lives in
 * ONE place — `computeHeldCounts` (renderer, features/posky/heldCounts.ts):
 *   'currency' — stored in the currency tab (kept, quest-countable — e.g. Wind Runes)
 *   'sold'     — auto-vendored the instant it dropped (gone, never held)
 *   'hoard'    — stored in the Dragon Hoard (bank-type storage — HELD)
 *   'depot'    — stored in the tradeskill depot (bank-type storage — HELD)
 *   'combined' — consumed on pickup to create an upgraded `<item> +N` (see `created`;
 *      net-ZERO for held counts — the looted copy and a held copy merge into one)
 */
export type LootDisposition = 'currency' | 'sold' | 'hoard' | 'depot' | 'combined'

/** `--You have looted a <item> from <mob>'s corpse.--` (self-loot). */
export interface LootEventE extends LogEventBase {
  kind: 'loot'
  item: string
  source?: string
  /**
   * Auto-disposition (Tasks #40/#47) for the one-line looted-and-routed variants
   * (`You looted …` — no leading "have", no dashes). Undefined for the ordinary
   * `--You have looted …--` form (kept, no routing implied). See LootDisposition.
   */
  disposition?: LootDisposition
  /**
   * Stack size when the line names one (Task #47): `--You have looted 2 Bone Chips …--`,
   * `You looted 2 Phosphorous Powder … and sold it …`. Undefined = 1. Held counts add
   * `count`, not 1 — a stacked loot is that many items.
   */
  count?: number
  /** The upgraded item a 'combined' loot created (`… to create a <item> +N`). */
  created?: string
}

/** `You offered N <item> to <NPC>.` — one per item offered. */
export interface OfferEvent extends LogEventBase {
  kind: 'offer'
  item: string
  npc: string
}

/** `You complete the trade with <NPC>.` — closes a pending offer group. */
export interface TradeEvent extends LogEventBase {
  kind: 'trade'
  npc: string
}

/** `You have gained a level! Welcome to level N!` */
export interface LevelEventE extends LogEventBase {
  kind: 'level'
  level: number
}

/**
 * `You gain experience! (3.288%)` / `You gain party experience! (1.373%)`, and the
 * percent-LESS variants of both. The percentage is an INCREMENT of the CURRENT level's
 * bar (proven: Σ between consecutive dings ≈ 100), never a bar position.
 *
 * `pct` is UNDEFINED when the line stated none — never 0. In the real log every
 * percent-less line falls inside one contiguous at-the-cap window (level 50, no ding
 * for 34 h), i.e. the game prints a percentage only while a level bar exists.
 *
 * FULL-LOG SWEEP (read-only, 2026-08-03, 1.11M lines): 3865 `You gain experience! (N%)`,
 * 471 `You gain party experience! (N%)`, 474 percent-less, 28 percent-less party — 4838
 * lines, EVERY ONE of which previously fell through to `{kind:'unknown'}` (verified by
 * replaying the whole log through the pre-change parser). The only other lines containing
 * "experience" are 11 player chat lines and one mob emote (`Coercer T\`vala experiences a
 * quickening.`), which is why the classifier's regex is anchored at BOTH ends.
 *
 * UNIT HONESTY (law 1): 1% at level 40 is far more raw experience than 1% at level 10, and
 * the log never states a raw exp number, a to-next-level total, or a bar position. Σ percent
 * is therefore "levels of progress", never "xp" — see shared/progressionStats.ts.
 */
export interface ExpGainEvent extends LogEventBase {
  kind: 'expGain'
  /** stated level-bar percent gained; undefined when the line printed none. */
  pct?: number
  /** the `party experience` shape — a group-mate's kill paid you. */
  party: boolean
}

/** `You have gained N ability point(s)! You now have M ability point(s).` */
export interface AaGainEvent extends LogEventBase {
  kind: 'aaGain'
  amount: number
  nowHave: number
}

/** `You have gained the ability "X" …` / `You have improved X <rank> …` at a cost of N. */
export interface AaSpendEvent extends LogEventBase {
  kind: 'aaSpend'
  ability: string
  rank?: number
  cost: number
}

/**
 * Unifies the two slain shapes:
 *   `You have slain X!`            → bySelf:true
 *   `X has been slain by Y!`       → bySelf:false, killer:Y
 * Both the kills tracker and the combat engine consume this one event.
 */
export interface DeathEvent extends LogEventBase {
  kind: 'death'
  name: string
  bySelf: boolean
  killer?: string
}

/**
 * A single damage application. Names are RAW (display case) — canonicalization
 * via idKey() stays the engine's job. `attacker` is null for caster-less
 * other-player DoT lines (`X has taken N damage by <Spell>.`); the engine ignores
 * null-attacker damage.
 */
export interface DamageEventE extends LogEventBase {
  kind: 'damage'
  attacker: string | null
  target: string
  amount: number
  dtype: DamageType
  dclass?: string
  skill: string
  crit: boolean
  /** Raw trailing paren modifier, verbatim ("Riposte Critical"). Kept for provenance. */
  modifier?: string
  /**
   * Taxonomy dimension (Task #51), additive over dtype: 'melee' | 'slay' | 'spell' |
   * 'dot' | 'ds'. A melee swing with a Slay Undead proc is 'slay' (its own category
   * per the user); every other dtype maps 1:1. Computed at parse time via
   * combat/taxonomy.ts. Optional so pre-#51 profiles/tests stay byte-compatible.
   */
  category?: DamageCategory
  /**
   * Parsed paren-modifier tokens (Task #51): ["Riposte","Critical"], ["Slay Undead"],
   * etc. Empty/omitted when the line has no modifier. `crit` is derived from the
   * presence of "Critical" here.
   */
  modifiers?: string[]
}

/**
 * `<healer> healed <target> for N hit points[ by <spell>].` — and the overheal
 * variant `... for N (M) hit points ...` where N is the effective (actual) heal
 * and M is the raw/pre-overheal amount. `amount` is always the effective heal.
 */
export interface HealEvent extends LogEventBase {
  kind: 'heal'
  target: string
  amount: number
  /** Raw/pre-overheal amount from the "(M)" group, when the line includes it. */
  rawAmount?: number
  spell?: string
  healer?: string
  /**
   * A CRITICAL heal (Task #59). Heal lines carry the same trailing paren modifier the damage
   * family does — `… by Superior Healing. (Critical)` — AFTER the sentence period. The original
   * `\.$`-anchored regex rejected every one of them, silently dropping 233 real heals from the
   * model (all nine distinct spells that can crit). Verified full-log sweep 2026-08-02:
   * `(Critical)` is the ONLY modifier a heal line has ever carried.
   */
  crit?: boolean
}

/**
 * ABSORPTION / MITIGATION families (Task #59) — damage PREVENTED, never hit points restored.
 * Deliberately a separate event kind from `heal`: folding these into healing would inflate a
 * healing meter with numbers that never touched the health bar.
 *
 * VERIFIED shapes (full-log sweep of eqlog_Primitive_freeport.txt, 2026-08-02):
 *   'rune'               `You gain a rune for 12 points of absorption.`  (1,016 lines; the
 *                        user's berserker rune AA. The amount is absorption GRANTED — the log
 *                        never says how much of it was actually consumed.)
 *   'absorbSwing'        `<mob> tries to bash YOU, but YOUR magical skin absorbs the blow!`
 *                        (362 lines, incl. a trailing ` (Riposte)` variant). COUNT ONLY — the
 *                        log carries NO amount for an absorbed swing, so never synthesize one.
 *   'absorbDamageShield' `YOUR magical skin absorbs the damage of <mob>'s thorns.` (235 lines)
 *                        — an incoming damage-shield tick absorbed. COUNT ONLY, same rule.
 *
 * Only the SELF ("YOUR"/"You") forms are emitted here. The possessive third-person twin
 * (`… but a revenant's magical skin absorbs the blow!`, 1,426 lines) is a MOB's rune and
 * belongs to the miss family (mtype 'absorb'), not to your mitigation lane.
 */
export type MitigationType = 'rune' | 'absorbSwing' | 'absorbDamageShield'

export interface MitigationEvent extends LogEventBase {
  kind: 'mitigation'
  mtype: MitigationType
  /** Absorption points granted — 'rune' ONLY. Absent for the count-only families. */
  amount?: number
  /** The attacker whose blow / damage shield was absorbed ('absorb*' only). */
  source?: string
}

export type MissType = 'miss' | 'dodge' | 'parry' | 'riposte' | 'block' | 'absorb'

/**
 * `<A> tr(y|ies) to <verb> <B>, but <outcome>!` — an avoided melee swing.
 * Parse-only for now (the engine may ignore or ring-log it).
 */
export interface MissEvent extends LogEventBase {
  kind: 'miss'
  attacker: string
  target: string
  mtype: MissType
}

/**
 * A SPELL RESIST (Task #51 timeline v2) — a detrimental spell fully resisted by its
 * target, the caster-side analogue of a melee miss. Three VERIFIED shapes in the real
 * log (eqlog_Primitive_freeport.txt sweep, 2026-08-02):
 *   `<target> resisted your <Spell>!`            → caster = 'you'
 *   `<target> resisted <caster>'s <Spell>!`      → caster = <caster> name (a pet or mob)
 *   `You resist[ed] <caster>'s <Spell>!`         → INCOMING: you resisted a mob's spell
 * The spell display name may carry a rank suffix ("Mesmerization III"); `spell` keeps the
 * DISPLAY form (rank preserved) and the engine rank-normalizes with spellCanonKey for lane
 * / attribution keys, mirroring the buffs model convention. `target` is the entity the
 * spell was cast ON (the incoming form's target is 'You'). Additive — with no consumer this
 * never affects damage totals (it carries no amount).
 */
export interface ResistEvent extends LogEventBase {
  kind: 'resist'
  /** who cast the resisted spell: 'you' | a caster name (pet/mob). */
  caster: string
  /** the entity that resisted (the spell's target). 'You' for the incoming form. */
  target: string
  /** the resisted spell, DISPLAY form (rank suffix preserved). */
  spell: string
  /** true for the incoming `You resist <mob>'s <Spell>` form (you were the resister). */
  incoming: boolean
}

/** `<mob> has been charmed.` — pet on (only the charmer sees this). */
export interface CharmEvent extends LogEventBase {
  kind: 'charm'
  mob: string
}

/** `Your <charm spell> spell has worn off of <mob>.` — pet off (charm spells only). */
export interface UncharmEvent extends LogEventBase {
  kind: 'uncharm'
  mob: string
}

/**
 * A crowd-control application or refresh on a mob — mez/root, NOT charm. Two shapes
 * produce it:
 *   application: `<mob> has been mesmerized.` (Mesmerize/Enthrall/Entrance/…) or
 *                `<mob> has been ensnared.` (root).
 *   refresh:     `Your <mez/root spell> spell has worn off of <mob>.` — a CC spell
 *                (as opposed to a charm spell, which stays an `uncharm`) wearing off
 *                is evidence the mob was under CC right up to that moment, so it is
 *                treated as a keep-alive refresh (`refresh:true`) rather than dropped.
 * The engine uses this to hold an encounter open across the mez-and-wait gap: a CC'd
 * instance is engaged-and-alive by definition. `spell` is present on the worn-off
 * shape; the application shape carries only the mob.
 */
export interface CcEvent extends LogEventBase {
  kind: 'cc'
  mob: string
  spell?: string
  /** True when derived from a "spell has worn off" line (keep-alive), not a fresh application. */
  refresh?: boolean
}

/**
 * A pet-ownership claim: a line where a pet addresses YOU as its master, proving
 * the named entity is your pet. Emitted for the DIRECT-TELL family only —
 *   `<Name> told you, 'Attacking <target> Master.'`
 *   `<Name> told you, 'I am unable to wake <mob>, Master.'`
 * — which in the real log is emitted ONLY by pets (no player false positives; see
 * parser.ts). This is how random proper-named SUMMONED pets (Vebarn, Garer, …),
 * which never appear in a charm line, get bound to you. Charmed pets also emit it
 * (harmlessly — they're already bound via the charm line). The say-family
 * ("Sorry, Master…", "As you wish…") is deliberately NOT used: common-named
 * charmed mobs emit it too, so it can't distinguish a summoned pet from an
 * unrelated mob, and it adds no binding a charm line didn't already provide.
 */
export interface PetClaimEvent extends LogEventBase {
  kind: 'petClaim'
  name: string
}

/**
 * `You begin casting <Spell>.` (and `You begin singing <Song>.` for bard songs) —
 * the player STARTS a cast. The buffs module treats this as a pending cast that
 * lands unless a fizzle/interrupt/new-cast intervenes. Only the player's own casts
 * produce this line (mob/other-player casts are not "You begin …").
 */
export interface CastBeginEvent extends LogEventBase {
  kind: 'castBegin'
  spell: string
}

/**
 * `Your <Spell> spell fizzles!` — the player's cast failed (no effect). Clears the
 * pending cast. Spell is captured (the real log always names it; targetless
 * `spell fizzles!` was never observed).
 */
export interface CastFizzleEvent extends LogEventBase {
  kind: 'castFizzle'
  spell: string
}

/**
 * `Your <Spell> spell is interrupted.` — the player's cast was interrupted (moved,
 * stunned, etc.). Clears the pending cast. NOTE (log evidence, 2026-08-01): the
 * real log has NO bare `Your spell is interrupted.` line — the shape always names
 * the spell. `You regain your concentration and continue your casting.` is the
 * OPPOSITE (a recovered cast) and is deliberately NOT parsed as an interrupt.
 */
export interface CastInterruptedEvent extends LogEventBase {
  kind: 'castInterrupted'
  spell: string
}

/**
 * `Your <Spell> spell has worn off[ of <target>].` — a buff the PLAYER cast has
 * expired. Two shapes with distinct semantics (validated against the real log):
 *   - `Your <Spell> spell has worn off.`          → self-cast buff on the player.
 *   - `Your pet's <Spell> spell has worn off.`    → buff the player cast on their
 *      pet (target='pet'). In this Enchanter's log EVERY targetless worn-off line
 *      is the pet form — the player's charmed pet is the main buff target — so the
 *      duration model is effectively mined from pet buffs; both are the player's
 *      own casts and both are mineable. `target` is 'pet' for the pet form and
 *      undefined for true-self.
 * CRITICAL: the `worn off OF <mob>` shape (charm/mez) is a DIFFERENT line handled
 * by uncharm/cc BEFORE this — buffFade only fires for targetLESS worn-off lines,
 * which are never charm/cc, so there is no overlap and no regression.
 */
export interface BuffFadeEvent extends LogEventBase {
  kind: 'buffFade'
  spell: string
  /** 'pet' when the buff was on the player's pet; undefined when on the player. */
  target?: string
}

/** `You have been slain by <killer>!` — the PLAYER died (buffs are stripped). */
export interface PlayerDeathEvent extends LogEventBase {
  kind: 'playerDeath'
  killer?: string
}

/**
 * A CANDIDATE spell-landing emote (Task #33). EQ prints a short flavor line the instant
 * a buff lands — self-form `You feel much faster.` / `You feel much better.` or the
 * third-person form `<Name> feels much faster.` naming the pet the buff landed on. These
 * DISCRIMINATE a cast's target (self vs pet) that `castBegin` alone can't: the buffs
 * module learns castBegin(S) → emote within 3s and, when the emote's SUBJECT is self,
 * marks S's active as a SELF buff; a pet-name subject marks the pet.
 *
 * This is a permissive CANDIDATE (many of these lines are unrelated flavor — hunger,
 * weather, ambient effects). The buffs module only trusts one that consistently follows
 * a given spell's cast (seen ≥2× with no contradiction) AND is temporally adjacent to a
 * live cast, so false candidates never bind. `subject` is 'self' for the `You …` form,
 * else the raw name (a pet). `text` is the whole emote (for association keying).
 */
export interface SpellEmoteEvent extends LogEventBase {
  kind: 'spellEmote'
  /** 'self' for the `You <verb> …` form; otherwise the named subject (a pet name). */
  subject: string
  /** The full emote text (association key). */
  text: string
}

/**
 * A PRECISE, message-driven buff application (Task #34). Emitted when a log line exactly
 * matches a spell's `msg_cast_on_you` (target 'self') or a `msg_cast_on_other` suffix
 * (target = the named subject). This is DB-driven and requires a spell database installed
 * on the parser config (ParserConfig.spellDb); with no DB it never fires, so profiles
 * without a DB behave exactly as before.
 *
 * This is what makes SELF buffs cast via a Quick Buff burst visible: the burst prints only
 * landing messages ("A cool breeze slips through your mind.") with NO "You begin casting"
 * line, so the cast-timing miner never saw them — the message match does.
 */
export interface BuffApplyEvent extends LogEventBase {
  kind: 'buffApply'
  /**
   * The resolved spell name (display casing from the DB). When the landing message is
   * AMBIGUOUS across several spells (many haste/clarity spells share one message — e.g.
   * "You feel much faster." is Alacrity/Celerity/Quickness/Swift), this is a best-effort
   * pick; `candidates` carries the full set so the buffs module can resolve it against the
   * player's own recent cast history (which spell they actually cast).
   */
  spell: string
  /** 'self' for a msg_cast_on_you match; the named target for a msg_cast_on_other match. */
  target: string
  /** True when the (resolved) spell's effects are an Illusion (Permanent Illusion AA). */
  illusion: boolean
  /** DB duration in ms (the authoritative prior), or null when the DB has no duration. */
  durationMs: number | null
  /**
   * All spells whose landing message equals this line (Task #34). Length 1 when the
   * message is unique. When >1, the message alone can't name the spell; the buffs module
   * disambiguates by the player's recent casts. Each candidate carries its own name +
   * duration + illusion flag (they usually share a duration but not always).
   */
  candidates: { name: string; durationMs: number | null; illusion: boolean }[]
}

/**
 * A PRECISE, message-driven buff expiry (Task #34): a log line exactly matched a spell's
 * `msg_wears_off`. Message-driven expiry is FAVORED over estimate-based removal (the user
 * directive). Target is 'self' — wears-off emotes are printed to the buff holder (the
 * player) regardless of who the buff was on, so we treat them as clearing the player's bar.
 */
export interface BuffWearOffEvent extends LogEventBase {
  kind: 'buffWearOff'
  /** Best-effort first candidate (display casing). Prefer `candidates` — the message may be shared. */
  spell: string
  /**
   * ALL spells whose `msg_wears_off` equals this line (Task #45). Many families share a
   * wears-off message (9 haste spells share "Your speed returns to normal.", 13 share
   * "Your strength fades.", …), so the message alone can't name which one faded. The buffs
   * module resolves against the player's ACTIVE self buffs — EQ stacking rules keep at most
   * one candidate of a family active at a time, so the active set names the real spell.
   */
  candidates: string[]
  target: 'self'
}

/**
 * `You activate <X>.` — an activated AA (e.g. Quick Buff). The buffs module uses a Quick
 * Buff activation as CONTEXT: the buff applies in the ~2-3s burst that follows are marked
 * confident (message-driven). Any activated AA is captured; consumers filter by name.
 */
export interface AaActivateEvent extends LogEventBase {
  kind: 'aaActivate'
  name: string
}

/**
 * `Your illusion fades.` — the player's ACTIVE illusion clicked/wore off (Task #36). This
 * is the click-off/removal line printed for EVERY illusion-flagged spell (Illusion: <race>,
 * Boon of the Garou, …) — the DB records it as the `msg_wears_off` for 27 distinct spells,
 * so the message alone can NOT name which illusion faded. It doesn't have to: the user's
 * rule is that only ONE illusion can be active on the player at a time, so this line removes
 * whichever illusion-flagged self buff is currently active (there is at most one). Emitted
 * IN PLACE OF a generic buffWearOff for this exact line so the buffs module never has to
 * guess a spell key from the 27-way-ambiguous wears-off table. `target` is always 'self'
 * (the illusion is on the player). DB-gated only in the sense that it is a plain message
 * match with no candidate list — it fires regardless of the DB (the text is unambiguous).
 */
export interface IllusionFadeEvent extends LogEventBase {
  kind: 'illusionFade'
  target: 'self'
}

/**
 * A DERIVED, RESOLVED buff-expiry event (Task #47). Unlike the parser's raw buffWearOff
 * (which carries an AMBIGUOUS `candidates` list for the 123 shared-message families) or
 * illusionFade (which names no spell at all), this event is SYNTHESIZED by the buffs module
 * AFTER it resolves the wear-off against the live active set — so `spell` is the ACTUAL buff
 * that faded and `target` is who it was on.
 *
 * DERIVED EVENTS (the design contract): the buffs module is the only authoritative source of
 * the resolved "wears off YOU" signal — the raw parser line is inherently ambiguous. Rather
 * than duplicate the active-set resolution in the alerts module, buffs emits this ONE
 * resolved event back onto the SAME bus (see log/bus.ts `emitDerived`), which the alerts
 * module (registered after buffs) matches like any other event. It is clearly namespaced,
 * never re-emitted by any consumer (buffs ignores it), and covers BOTH sides of the user's
 * "the wears off for you is different than for somebody else" concern with a single kind:
 *   - a SELF wears-off (message-driven buffWearOff / illusionFade, resolved) → target:'self'.
 *   - a fade on the pet / another entity (buffFade, already resolved spell+target) →
 *     target = that entity's display name.
 * So an alert `{event, buffExpired, where:{spell:'Swift Like the Wind'}}` fires whether the
 * buff wore off the player OR the player's pet — the "good sane default that helps with both".
 */
export interface BuffExpiredEvent extends LogEventBase {
  kind: 'buffExpired'
  /** The RESOLVED spell that expired (display casing) — never ambiguous. */
  spell: string
  /** 'self' when it wore off the player; else the bound entity's display name (pet/mob/player). */
  target: string
}

/**
 * A DERIVED character-EPOCH boundary (Task #49; anchor REPLACED in Task #50). NOT a parsed
 * line: it is SYNTHESIZED by the feeder (index.ts bus subscription) and handed back onto the
 * SAME bus via `emitDerived` at the OFFICIAL LAUNCH boundary — the fingerprint of a character
 * REBIRTH (a same-name+server character wiped/recreated at launch, which reuses the SAME log
 * file). The user's real case: a BETA character reached level 26/30 (Jul 19-20), was WIPED at
 * launch, and the log continues with `Welcome to EverQuest Legends!` then a `Welcome to level
 * 2!` re-level on Jul 28 — everything before that boundary belongs to a DEAD character and
 * contaminates AA / loot / kills / turn-ins / quest counts.
 *
 * DETECTION (in the feeder): the FIRST event whose timestamp is at/after the official launch
 * instant 2026-07-28 00:00 LOCAL (see epochDetector.ts `LAUNCH_MS`). The launch DATE replaced
 * the old level-regression heuristic, which was UNSAFE: EQ Legends loadout swaps legitimately
 * change character level, so a decisive downward level jump is not a reliable rebirth signal.
 * The date is unambiguous and can't be confused with in-game mechanics.
 *
 * On this event, character-scoped modules RESET their live folded state (see modules/*),
 * so post-scan state reflects ONLY the current character. `reason` documents the trigger.
 */
export interface EpochEvent extends LogEventBase {
  kind: 'epoch'
  reason: 'launch'
}

/**
 * A LOGIN — `Welcome to EverQuest Legends!`, printed on EVERY entry into the world
 * (19× in the real 1.15M-line log; measured, not assumed). It is NOT an epoch signal
 * (epochDetector.ts says so explicitly) — it is the ONE unambiguous "the character is in
 * the world again" line, and therefore the right side of every offline gap.
 *
 * The line carries nothing but itself: no character, no zone, no elapsed time. A
 * `You have entered <zone>.` ALWAYS follows within 0–1 lines (verified for all 19), so
 * the existing zone path — not this event — remains the single source of the zone-change
 * censor (world-model law 4). Nothing here duplicates it.
 */
export interface SessionStartEvent extends LogEventBase {
  kind: 'sessionStart'
}

/**
 * The player STARTED camping out — `It will take you about 30 seconds to prepare your camp.`
 * (20× in the real log). Only the INITIATION line is an event; the five countdown ticks
 * (`It will take about {25,20,15,10,5} more seconds to prepare your camp.`, 78 lines) stay
 * `unknown` on purpose — they are the same fact repeated and nothing consumes them.
 *
 * A camp is CANCELLABLE, and the game SAYS SO (see {@link CampAbortEvent}) — so a campStart
 * is an INTENT, never a completed logout. Only the pairing rule in sessionDetector.ts decides
 * whether a gap was camped.
 */
export interface CampStartEvent extends LogEventBase {
  kind: 'campStart'
}

/**
 * The camp was CANCELLED — `You abandon your preparations to camp.` (2× in the real log,
 * Aug 02 01:34:09 and 01:34:14, each in the SAME second as its own campStart).
 *
 * World-model law 1 (messages over inference): the brief for this feature assumed an abort
 * had to be INFERRED from "camp lines followed by more activity without a Welcome". It does
 * not — the game prints an explicit line, so we read it instead of guessing. Without it, a
 * player who aborts a camp and then CRASHES seconds later would be reported as having camped.
 */
export interface CampAbortEvent extends LogEventBase {
  kind: 'campAbort'
}

/**
 * A DERIVED absence: the character was OUT OF THE WORLD between two known instants.
 * Synthesized by sessionDetector.ts at each {@link SessionStartEvent} and handed back onto
 * the SAME bus via `emitDerived` (the Task #47 path the epoch detector and the buffs module
 * both use), so consumers see it AFTER the Welcome finishes delivering. Identical in replay
 * and live — nothing here reads the wall clock.
 *
 * WHY `fromTs` IS NOT "THE LAST EVENT BEFORE THE WELCOME" (measured correction). Every login
 * prints a RECONNECT PREAMBLE *before* the Welcome — `You are not currently assigned to an
 * adventure.`, `The Marketplace is unavailable at this time. Please try again later.`,
 * `Channel <X> was too full to join`, `Channels: 1=…`, and (because the client is already
 * connected to chat) other players' channel chat. Across all 19 logins in the real log the
 * newest event before the Welcome is 0–2 SECONDS older than it — every single time. Anchoring
 * on it would report a 13-hour absence as a 1-second one and emit ZERO gaps, ever.
 *
 * So `fromTs` is the newest event at least {@link RECONNECT_WINDOW_MS} older than the
 * Welcome — a MEASURED window (the whole preamble fits inside 22s in 19/19 logins; see
 * sessionDetector.ts), in the same family as the model's other measured windows (the ~5s
 * encounter linger, the ~2.5s clicky window). It is a LOWER bound on the true absence.
 */
export interface OfflineGapEvent extends LogEventBase {
  kind: 'offlineGap'
  /** Last instant the character is KNOWN to have been in the world (a lower bound). */
  fromTs: number
  /** The Welcome line's ts — the character is in the world again. Exact. */
  toTs: number
  /** True when a non-aborted `campStart` sits within 60s of `fromTs` (an orderly logout). */
  camped: boolean
}

/**
 * The player changed their combat STANCE (Task #51). EQ Legends has two mutually-
 * exclusive combat-modifier groups; this is the melee/general one. The commit line is
 * `You assume a <stance> stance.` (`You begin to change your stance.` is the pre-commit
 * flavor and is NOT emitted — 594 of those vs the assume lines that name the stance).
 * VERIFIED stances (full-log sweep): defensive, offensive, balanced, mage hunter,
 * evasive, striker, berserker, channeler, ranged (9 total — MORE than the 5 the task
 * brief listed; swept, not assumed). `stance` is the lowercased canonical name; the
 * regex is name-permissive so a 10th stance still parses.
 */
export interface StanceChangeEvent extends LogEventBase {
  kind: 'stanceChange'
  stance: string
}

/**
 * The player changed their INVOCATION (Task #51) — the second mutually-exclusive
 * combat-modifier group (a caster/mixed self-buff recited into an active slot). Commit
 * line: `You begin reciting the <invocation> invocation.` (`You begin to change your
 * invocation.` is pre-commit flavor, NOT emitted — 2339 of those). VERIFIED invocations
 * (full-log sweep): inversion, overchannel, recovery, spellblade, divine, inviolable,
 * empowering, arcane mastery, unyielding (9 total — MORE than the 5 the brief listed;
 * "arcane mastery" is a two-word name a single-word grep misses). `invocation` is the
 * lowercased canonical name.
 */
export interface InvocationChangeEvent extends LogEventBase {
  kind: 'invocationChange'
  invocation: string
}

/**
 * The character's OWN `/who` row — the ONLY line in the game that states the class loadout
 * (docs/plans/class-combo-inference.md § 2/A1). EQ Legends runs up to THREE classes at once
 * and never logs a swap, so this row is the single Tier-A observation the combo model can
 * anchor on; everything else is inference.
 *
 * VERIFIED shape (full-log sweep of eqlog_Primitive_freeport.txt, 2026-08-03 — 421 `/who`
 * rows, 11 of them the character's own):
 *
 *   [50 PAL/MNK/ENC] Primitive (Dark Elf)  ZONE: East Freeport (freporte)··
 *   [7 CLR/BER] Primitive (Froglok)  ZONE: West Commonlands (commons)··
 *
 * Every row ends in TWO trailing spaces, and the general `/who` grammar carries three more
 * variants this character has not printed yet but the matcher tolerates anyway (refusing one
 * would silently drop the only loadout statement in the log):
 *   guild tag   `[9 WAR/MAG] Name (Ogre) <Gothic Circle> ZONE: …`  (ONE space before ZONE)
 *   AFK          ` AFK [4 WAR/ENC] Name (Human)  ZONE: …`
 *   corpse       `* RIP *[3 MNK/BER] Name's corpse (Iksar)  ZONE: …`
 * `[ANONYMOUS] Name` states no classes at all and is NOT this event.
 *
 * SELF ONLY, and that is a load-bearing guard, not a filter: a `/who` prints every stranger
 * in the zone, so the rule matches ONLY the tailed character's name (ParserConfig.characterName,
 * injected per session — never a constant). With no character installed the rule declines
 * every line, so a third party's row can never be mistaken for the player's loadout.
 *
 * `classes` is the row's own arity — 2 before the tertiary slot unlocks at level 10, 3 after —
 * so the row is ground truth about cardinality as well as membership. `level` is the DISPLAYED
 * level, which is the MINIMUM of the loadout's class levels; a drop is a legitimate swap, never
 * a rebirth (see epochDetector.ts).
 */
export interface SelfWhoEvent extends LogEventBase {
  kind: 'selfWho'
  /** the bracketed level — min(class levels), not any one class's level. */
  level: number
  /** the /who class codes in row order, e.g. ['PAL','MNK','ENC']. Length 2 or 3. */
  classes: string[]
  /** the race in parens, verbatim ('Dark Elf'). Illusions change it — NOT combo evidence. */
  race?: string
  /** the zone display name with the trailing `(shortname)` id dropped ('East Freeport'). */
  zone?: string
}

/**
 * `You have become better at <Skill>! (<n>)` — a skill tick (design § 2/B3). The ONLY
 * evidence family that can see the four classes with (almost) no spells: BER, MNK and WAR
 * have ZERO spells and ROG has nine, so cast evidence is structurally blind to them and a
 * skill-up is all the log ever says.
 *
 * FULL-LOG SWEEP (2026-08-03, 1.12M lines): 10,216 lines across 54 distinct skills, EVERY one
 * of which previously fell through to `{kind:'unknown'}`, and EVERY one carrying the trailing
 * `(<n>)` — the new skill value. `value` is nevertheless optional so a value-less shape stays
 * expressible without a breaking change, and the matcher accepts it.
 *
 * `skill` is the string EXACTLY as the CLIENT prints it — `1H Slashing`, `Channeling`,
 * `Stringed Instruments` — which is NOT how the wiki spells several of them (`1 Hand
 * Slashing`, `Channelling`, `String`). classes.json's `skills` table is keyed by the client
 * name and carries the alias mapping; the event must never pre-translate, or the table's key
 * and the log's word would drift apart.
 */
export interface SkillUpEvent extends LogEventBase {
  kind: 'skillUp'
  /** client spelling, verbatim ('Flying Kick', '1H Piercing'). */
  skill: string
  /** the new skill value from the trailing `(n)`; absent when the line printed none. */
  value?: number
}

/**
 * AN ITEM'S OWN EFFECT FIRED — a click or a proc (class-combo inference Wave 3). TWO verified
 * shapes, and a full-log sweep found no third `Your <item> …` activation family:
 *
 *   `Your Djarn's Amethyst Ring (Exaltation) shimmers briefly.`      5,421×  (2 items)
 *   `Your Idol of the Underking (Exaltation) feels alive with power.` 2,500× (2 items)
 *
 * WHY IT IS ITS OWN EVENT, and this is the load-bearing part: the very next line is `You begin
 * casting <Spell>.` at the SAME second, and that cast is the ITEM's, not the player's. Cast
 * evidence is the combo model's weakest tier precisely because items cast spells (design § 9
 * R3), and the design's proposed defence — require evidence in ≥2 hourly buckets — was
 * MEASURED IN WAVE 1 TO FAIL: after the Aug 2 loadout swap, ENC still shows SEVEN distinct
 * exclusive labels (illusions, Rampage I) purely through item clickies, comfortably clearing
 * any sustain threshold. So the combo module drops a `castBegin` that lands within 2.5 s after
 * one of these lines (modules/comboEvidence.ts). Hand-casts keep their full weight.
 *
 * `item` is the RAW display name including any trailing ` (Exaltation)` — law 2: canonicalize
 * at counting boundaries, display what the game printed. Nothing keys off it today; it exists
 * so a future consumer can say WHICH clicky fired.
 *
 * CASCADE PLACEMENT: immediately before the permissive spell-landing-emote matcher. 7,749 of
 * the 7,921 lines were `{kind:'unknown'}`; the other 172 (`Your Idol of the Underking feels
 * alive with power.`, the variant with no ` (Exaltation)` for the emote's name pattern to trip
 * over) were being swept into the emote CANDIDATE stream with a subject of "Your Idol of the
 * Underking". Claiming them here was proven inert: a full-log BuffsModule replay produces a
 * byte-identical snapshot before and after (see the wave commit message).
 */
export interface ItemActivateEvent extends LogEventBase {
  kind: 'itemActivate'
  /** raw item display name, verbatim (`Djarn's Amethyst Ring (Exaltation)`). */
  item: string
  /** which message fired — 'shimmer' | 'alive'. Kept so a future family stays expressible. */
  effect: 'shimmer' | 'alive'
}

/**
 * ITEM UPGRADE (merge) — `You have successfully merged two items together to create a new
 * item: <Name>` (236× in the real log). The mechanic (eqlwiki "Item Upgrade System", quoted
 * in main/itemLookupParse.ts): merging consumes a second copy — or a Mote of Potential — to
 * add item EXP; tier N→N+1 costs 2^N. The line names the RESULT, so its ` +N` suffix is the
 * tier the item just REACHED. It is the only line in the game that reports an upgrade.
 *
 * `tier` is UNDEFINED when the result name carries no ` +N`, which is NOT a base item: the
 * SAME line fires for spell-scroll merges, whose result is rank-suffixed instead
 * (`Shiftless Deeds III`, `Allure VI`, `Superior Healing IV` — 77 of the 236 vs 159 that
 * name an item level). A Roman rank is not an item level (law 1: never claim a tier we did
 * not read), so consumers fold only tier-bearing merges and leave scroll merges as what they
 * are — an observed merge with no tier.
 */
export interface ItemMergeEvent extends LogEventBase {
  kind: 'itemMerge'
  /** the RAW result name, exactly as printed (`Thelvorn, Blade of Light +5`) */
  item: string
  /** the reached item level, when the result name carries one */
  tier?: number
}

/**
 * A merge that did NOT happen. FIVE VERIFIED shapes (full-log sweep 2026-08-02); only the
 * first names any item:
 *   'mismatch'  `Your request to merge <target> with <component> failed. The items do not
 *               match, are the exact same item, cannot be merged, the component (the item to
 *               be destroyed) has an augment, or one of the items is no longer in your
 *               inventory.`                                                            (4×)
 *   'weakMote'  `The item you are trying to add will not work, this mote is not
 *               sufficiently powerful to upgrade this item.`                            (9×)
 *   'selfFuse'  `The item you are trying to add will not work, you cannot fuse an item to
 *               itself.`                                                                (4×)
 *   'wrongType' `The item you are trying to add will not work, you cannot merge two
 *               different types of items.`                                              (1×)
 *   'canceled'  `Request to merge items canceled, both items remain unmodified.`        (1×)
 * (The 'selfFuse' wording is why the family cannot be swept by the word "merge" alone — that
 * line never uses it. It was found by diffing parsed output against the raw log, not by
 * guessing sibling phrasings.)
 * NOTHING changed tier here — the value is the 'mismatch' shape, which STATES the tier of an
 * item sitting in your inventory (`… merge Valorium Bracers +2 with Valorium Bracers …`).
 */
export interface ItemMergeFailedEvent extends LogEventBase {
  kind: 'itemMergeFailed'
  reason: 'mismatch' | 'weakMote' | 'selfFuse' | 'wrongType' | 'canceled'
  /** the item that would have been UPGRADED (kept), raw — 'mismatch' only */
  target?: string
  /** the item that would have been CONSUMED, raw — 'mismatch' only */
  component?: string
}

/**
 * A CONSIDER (`/con`) — the player sized a mob up (Task #63). ONE shape, verified by a
 * full-log sweep of eqlog_Primitive_freeport.txt (2026-08-03, 357 lines):
 *
 *   <Mob>[ - a rare creature -] <faction phrase> -- <difficulty phrase> (Lvl: N)
 *
 *   A zol ghoul knight scowls at you, ready to attack -- what would you like your tombstone to say? (Lvl: 38)
 *   A froglok gaz knight regards you indifferently -- looks quite risky, but might be worth a try. (Lvl: 18)
 *   Baron Telyx V`Zher - a rare creature - scowls at you, ready to attack -- what would you like your tombstone to say? (Lvl: 28)
 *
 * `(Lvl: N)` is the family's anchor and EVERY one of the 357 lines carries it (the only other
 * lines in the whole log containing ` -- ` are 9 player chat lines, which have no `(Lvl:`).
 * `level` is nevertheless optional on the type so a future level-less shape stays expressible
 * without a breaking change — see parser.ts, which requires the group today.
 *
 * `mob` is the RAW display name, exactly as printed. A consider line SENTENCE-CASES the leading
 * article ("A zol ghoul knight") where a You-have-slain line does not ("a zol ghoul knight"), so
 * every consumer keys by `idKey(mob)` and adopts the display the same way KillInfo does — see
 * world-model law 2.
 */
export interface ConsiderEvent extends LogEventBase {
  kind: 'consider'
  /** RAW display name, verbatim (article casing preserved; canonicalize with idKey). */
  mob: string
  /** the ` - a rare creature - ` infix was present (12 lines in the real log). */
  rare: boolean
  /** the stated level. Always present today; see the note above. */
  level?: number
  /** the faction rung, canonicalized 1:1 from the phrase (never inferred) — see FACTION_RUNGS. */
  faction: ConsiderFaction
  /** the difficulty clause, VERBATIM (gendered variants preserved). See considerDifficultyShort. */
  difficulty: string
}

/**
 * The faction (con-message) ladder, friendliest → most hostile. These are the rungs EQ prints
 * between the mob name and the ` -- `; the key is a 1:1 rename of the phrase, not an inference.
 *
 * FULL-LOG SWEEP (2026-08-03, 357 consider lines — every line accounted for, no residue):
 *   regards you indifferently        128
 *   scowls at you, ready to attack   102
 *   judges you amiably                60
 *   glowers at you dubiously          34
 *   glares at you threateningly       17
 *   looks your way apprehensively     14
 *   looks upon you warmly              2
 * The two remaining rungs of the classic ladder — `regards you as an ally` and `kindly considers
 * you` — do NOT occur in this log (this character has no maxed faction). They are matched anyway,
 * for the same reason the stance regex is name-permissive: covering a rung we haven't stood on
 * costs nothing and refusing it would silently drop the whole line. Nothing infers a rung that
 * wasn't printed.
 */
export type ConsiderFaction =
  | 'ally'
  | 'warmly'
  | 'kindly'
  | 'amiably'
  | 'indifferent'
  | 'apprehensive'
  | 'dubious'
  | 'threatening'
  | 'scowls'

/** phrase → rung, friendliest first. The parser builds its alternation from this list. */
export const CONSIDER_FACTION_RUNGS: readonly { phrase: string; faction: ConsiderFaction }[] = [
  { phrase: 'regards you as an ally', faction: 'ally' },
  { phrase: 'looks upon you warmly', faction: 'warmly' },
  { phrase: 'kindly considers you', faction: 'kindly' },
  { phrase: 'judges you amiably', faction: 'amiably' },
  { phrase: 'regards you indifferently', faction: 'indifferent' },
  { phrase: 'looks your way apprehensively', faction: 'apprehensive' },
  { phrase: 'glowers at you dubiously', faction: 'dubious' },
  { phrase: 'glares at you threateningly', faction: 'threatening' },
  { phrase: 'scowls at you, ready to attack', faction: 'scowls' }
]

/** Short, glanceable rung label for a chip/badge. */
export const CONSIDER_FACTION_LABEL: Record<ConsiderFaction, string> = {
  ally: 'ally',
  warmly: 'warmly',
  kindly: 'kindly',
  amiably: 'amiable',
  indifferent: 'indifferent',
  apprehensive: 'apprehensive',
  dubious: 'dubious',
  threatening: 'threatening',
  scowls: 'KOS'
}

/**
 * The APP's faction palette (friendly cool → hostile warm). This is our presentation choice,
 * not a color the game states — EQ's own con COLOR encodes relative LEVEL, not faction, and the
 * log never carries a color at all. Kept beside the ladder so the overlay and the main window
 * can't drift apart.
 */
export const CONSIDER_FACTION_COLOR: Record<ConsiderFaction, string> = {
  ally: '#5fe08a',
  warmly: '#7fd8a0',
  kindly: '#6fa8f0',
  amiably: '#7fc4e8',
  indifferent: '#c8ccd8',
  apprehensive: '#c9c65a',
  dubious: '#d6a94a',
  threatening: '#e08b45',
  scowls: '#e05c5c'
}

/**
 * The difficulty clause → a short label for a dense row. Keys are the VERBATIM phrases observed
 * in the full-log sweep, with the gendered pronoun folded to a regex-free `he|she|it` lookup
 * below; a phrase we've never seen returns undefined and the caller shows the verbatim clause
 * (never a guessed tier — and deliberately NO numeric ordering, which the log does not state).
 */
const CONSIDER_DIFFICULTY_SHORT: Record<string, string> = {
  'what would you like your tombstone to say?': 'suicide',
  'looks like it would wipe the floor with you!': 'wipes the floor',
  'it appears to be quite formidable.': 'formidable',
  'looks like quite a gamble.': 'a gamble',
  'looks kind of dangerous.': 'dangerous',
  "you would probably win this fight... it's not certain though.": 'probably win',
  'looks quite risky, but might be worth a try.': 'worth a try',
  'looks kind of risky, but you might win.': 'might win',
  'looks kind of risky... you might win.': 'might win',
  'you could probably win this fight.': 'likely win',
  'looks like a reasonably safe opponent.': 'safe'
}

/**
 * Short label for a difficulty clause, or undefined when we've never seen the phrase.
 * Folds the gendered variants EQ emits for two of the clauses ("looks like HE/SHE/IT would wipe
 * the floor with you!", "HE/SHE/IT appears to be quite formidable.") onto the neuter key.
 */
export function considerDifficultyShort(difficulty: string): string | undefined {
  const key = difficulty
    .trim()
    .toLowerCase()
    .replace(/\b(?:he|she)\b/g, 'it')
    .replace(/\s+/g, ' ')
  return CONSIDER_DIFFICULTY_SHORT[key]
}

// ---------------------------------------------------------------------------
// ROGUE POISON events (Task #64). The catalog these describe — the roster, the coat/dry
// message tables, the Strike proc emotes and the dispel family — lives in shared/poisons.ts;
// its block comment carries the evidence (spell DB + eqlwiki) behind every string.
// ---------------------------------------------------------------------------


/**
 * A rogue-poison Strike LANDING on a target (Task #64). Emitted from the Strike's own
 * cast-on-other emote — the only line the game prints for a proc (there is no cast line and
 * no attacker name, so this event deliberately does NOT claim a caster; see law 6 and the
 * block comment above).
 */
export interface PoisonProcEvent extends LogEventBase {
  kind: 'poisonProc'
  /** Best-effort strike name (the first candidate). Prefer `candidates` when it matters. */
  strike: string
  /** Every strike sharing this emote. Length 1 unless the emote is one of the two shared ones. */
  candidates: string[]
  /** Effect class — unambiguous even when `strike` is not (both members of a pair agree). */
  effect: PoisonEffect
  /** The entity the proc landed on, RAW display name (canonicalize with idKey). */
  target: string
}

/**
 * The player coated their blades (Task #64). `poison` is the DB spell name when the coat
 * line is one we know, else 'unknown'.
 *
 * THIRD PERSON: other players' coats print two shapes, both in the real log —
 *   `Pollux coats their blades in asp venom!`   (named; Asp Venom's own msgCastOnOther)
 *   `Skandercoats their blades in poison.`      (generic; note the MISSING SPACE — that is
 *      how the game actually prints it, verified verbatim on all 2 occurrences, so the
 *      matcher must not require one)
 * The generic form deliberately hides which poison, so it carries `poison: 'unknown'`. These
 * are somebody ELSE's blades and never touch your coat state — `who` is what says so.
 */
export interface PoisonCoatEvent extends LogEventBase {
  kind: 'poisonCoat'
  /** DB spell name, or 'unknown' for the generic third-person form. */
  poison: string
  /** Which slot it occupies — 'unknown' when the poison itself is unknown. */
  group: PoisonGroup | 'unknown'
  /** 'you' for your own coat; otherwise the other player's raw name. */
  who: string
}

/**
 * A coat wore off / was replaced (Task #64) — `The poison dries from the blade.` (utility)
 * or `The venom drips away.` (combat). The line names no poison; `group` is all it can say.
 */
export interface PoisonDryEvent extends LogEventBase {
  kind: 'poisonDry'
  group: PoisonGroup
}

/** A line that parsed as a log line (had a timestamp) but matched no content rule. */
export interface UnknownEvent extends LogEventBase {
  kind: 'unknown'
}

/** The canonical discriminated union of everything the parser can emit. */
export type LogEvent =
  | ZoneEvent
  | LootEventE
  | OfferEvent
  | TradeEvent
  | LevelEventE
  | ExpGainEvent
  | AaGainEvent
  | AaSpendEvent
  | DeathEvent
  | DamageEventE
  | HealEvent
  | MitigationEvent
  | MissEvent
  | ResistEvent
  | CharmEvent
  | UncharmEvent
  | CcEvent
  | PetClaimEvent
  | CastBeginEvent
  | CastFizzleEvent
  | CastInterruptedEvent
  | BuffFadeEvent
  | PlayerDeathEvent
  | SpellEmoteEvent
  | BuffApplyEvent
  | BuffWearOffEvent
  | AaActivateEvent
  | IllusionFadeEvent
  | BuffExpiredEvent
  | EpochEvent
  | SessionStartEvent
  | CampStartEvent
  | CampAbortEvent
  | OfflineGapEvent
  | StanceChangeEvent
  | InvocationChangeEvent
  | SelfWhoEvent
  | SkillUpEvent
  | ItemActivateEvent
  | ItemMergeEvent
  | ItemMergeFailedEvent
  | ConsiderEvent
  | PoisonProcEvent
  | PoisonCoatEvent
  | PoisonDryEvent
  | UnknownEvent
