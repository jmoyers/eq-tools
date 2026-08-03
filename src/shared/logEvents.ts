// The canonical, typed log-event stream. ONE parse pass over the EQ Legends log
// produces this discriminated union (see main/log/parser.ts). Both feeders (the
// historical scan and the live tailer) emit these onto the in-main bus
// (main/log/bus.ts); every consumer (loot/kills/levels/AA reducers, the combat
// engine, the coming world model) subscribes to the stream instead of running its
// own regexes. Keep this pure and serializable — no behavior, just data.

import type { DamageType, DamageCategory } from './combat'

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
  target: 'self' | string
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
  target: 'self' | string
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
  | StanceChangeEvent
  | InvocationChangeEvent
  | UnknownEvent
