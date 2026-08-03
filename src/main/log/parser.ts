// The single parse pass. `parseEvent(raw, seq)` turns one raw log line into a
// canonical LogEvent (or null when the line isn't a timestamped log line at all).
//
// This ABSORBS both former regex batteries — the content matchers that lived in
// parse.ts (loot/zone/kill/offer/trade/level/AA) and the combat matchers from
// combat/parse.ts (melee/spell/dot/ds/charm/uncharm/death/zone) — plus the two
// NEW parse-only families (heal, miss). It preserves every documented fix (verb
// conjugations, incoming-DS variant, charm-spell stems, AA improved format,
// singular/plural points, caster-less DoT → attacker:null).
//
// PERF: a full 68MB replay must stay ~seconds. The old scan ran cheap substring
// pre-filters before the regex battery; that logic now lives INSIDE parseEvent as
// an implementation detail (no caller-visible pre-filters). The hot path for the
// overwhelming majority of lines — misses and avoided swings — is gated by a
// single `includes(', but ')` check before any regex runs, and the ubiquitous
// combat/heal/loot families are each guarded by a substring probe. Lines matching
// nothing return a shared UNKNOWN-shaped result cheaply.

import { DEFAULT_PROFILE } from '../../shared/profiles'
import type { DamageType } from '../../shared/combat'
import type { LogEvent, MissType } from '../../shared/logEvents'
import { getParserConfig, type ParserConfig } from './rulesets'
import { itemTierFromName } from '../../shared/itemStats'
import { parseModifiers, hasCritical, damageCategory } from '../combat/taxonomy'

// ----- line prefix + timestamp (unchanged from the old parse.ts) -----

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

// ----- content matchers (verbatim regexes from the two old parsers) -----

// Loot (self):
//   --You have looted a Mote of Infinitesimal Potential from Bazzzazzt's corpse.--
//   --You have looted an Efreeti War Staff from the Hand of Veeshan's corpse.--
//   --You have looted 2 Bone Chips from an elf skeleton's corpse.--
// Every loot form can carry a STACK COUNT where the article goes (Task #47): a digit
// run + space instead of "a "/"an ". Captured separately so the item name stays clean
// (the old regexes swallowed "2 Bone Chips" as the item — a distinct bogus counting
// key). VERIFIED SAFE against the real log: no looted item name starts with a digit
// (stacked shapes observed only on the dashed + sold forms; the capture is symmetric
// across the family anyway so a future stacked variant parses right).
const LOOT_RE = /^--You have looted (?:(\d+) |an? )?(.+?)(?: from (.+?) corpse)?\.--$/
// Dashless fallback for servers/cases that omit the surrounding dashes.
const LOOT_RE_PLAIN = /^You have looted (?:(\d+) |an? )?(.+?)(?: from (.+?) corpse)?\.$/
// Auto-disposition loot (Tasks #40/#47): the client can loot-and-route an item in one
// line. These use "You looted" (no leading "have", no surrounding dashes). VERIFIED
// shapes (real log 2026-08-01/02 — the full family, no unrouted "You looted" exists):
//   You looted a Wind Rune Caza from a greater sphinx's corpse and stored it in your currency
//   You looted a Belt of Concordance +1 from Noble Dojorn's corpse and sold it for free.
//   You looted 2 Spider Silk from a giant black widow's corpse and sold it for 2 gold, 8 silver and 6 copper.
//   You looted a Dull Wooden Spear from Officer Grush's corpse and stored it in your Dragon Hoard
//   You looted a Griffenne Blood from a soul carrier's corpse and stored it in your tradeskill depot
//   You looted a Silver Earring from a necro acolyte's corpse to create a Silver Earring +1
// Sold lines carry a trailing period; currency/hoard/depot/combine lines carry NONE
// (tolerated everywhere). Dispositions: 'currency'/'hoard'/'depot' are all KEPT storage
// (count toward held/quest progress); 'sold' was vendored — GONE, never held;
// 'combined' consumed the looted copy AND a held copy to create the upgraded `created`
// item (every one of the 293 real combine lines creates `<same base> +N`), so it nets
// ZERO held. The one held-count rule lives in computeHeldCounts (renderer).
const LOOT_CURRENCY_RE = /^You looted (?:(\d+) |an? )?(.+?) from (.+?) corpse and stored it in your currency\.?$/
const LOOT_SOLD_RE = /^You looted (?:(\d+) |an? )?(.+?) from (.+?) corpse and sold it for (?:free|[\d,]+ (?:platinum|gold|silver|copper).*?)\.?$/
const LOOT_STORED_RE = /^You looted (?:(\d+) |an? )?(.+?) from (.+?) corpse and stored it in your (Dragon Hoard|tradeskill depot)\.?$/
const LOOT_COMBINE_RE = /^You looted (?:(\d+) |an? )?(.+?) from (.+?) corpse to create (?:an? )?(.+?)\.?$/

const ZONE_RE = /^You have entered (.+?)\.$/
// Pseudo-zone notices that share the "You have entered <X>." grammar but are NOT
// real zone transitions. Emitting a zone event for these wipes the tracked zone
// (so the kills module computes tier 0 for everything killed inside an instance)
// AND spuriously finalizes the current encounter / clears charm / resets zoneAgg
// mid-instance. Every instanced-zone entry is followed ~instantly by one of these.
//
// Evidence (full-log `grep -oaE "You have entered [^.]*\." | uniq -c`, 2026-08-01):
// real zones are all Title Case; the ONLY non-zone shape observed is the effect
// notice below. We reject the tightest filter the evidence supports — the exact
// "an area where …" effect-notice family — rather than a blanket lowercase reject
// (no lowercase-starting REAL zone exists today, but future ones might).
//   14×  "an area where levitation effects do not function"
// Other plausible effect notices ("...where binding is not permitted", "an Arena
// (PvP) area") do NOT appear in the real log; `^an area where ` covers the whole
// observed family and any sibling effect notice of the same shape.
const PSEUDO_ZONE_RE = /^an area where /i

// Kills:
//   "You have slain a spectre!"
//   "Maestro of Rancor has been slain by Innoruuk`s Chosen!"
const SLAIN_SELF_RE = /^You have slain (.+?)!$/
const SLAIN_BY_RE = /^(.+?) has been slain by (.+?)!$/

// Turn-ins: "You offered 1 Sphinx Claw to Dason Goldblade." then
//           "You complete the trade with Dason Goldblade."
const OFFER_RE = /^You offered [\d,]+ (.+?) to (.+?)\.$/
const TRADE_DONE_RE = /^You complete the trade with (.+?)\.$/

// "You have gained a level! Welcome to level 26!"
const LEVEL_RE = /^You have gained a level! Welcome to level (\d+)!$/

// "You have gained an ability point!  You now have 7 ability points."
// "You have gained 2 ability point(s)!  You now have 3 ability point(s)."
const AA_RE = /^You have gained (an|\d+) ability point(?:\(s\))?!\s+You now have (\d+) ability point/

// Spending AA (two forms — see AGENTS.md).
const AA_SPEND_RE = / at a cost of (\d+) ability points?\.$/
const AA_ABILITY_RE = /gained the ability (?:"([^"]+)"|to use (.+?)) at a cost of/
const AA_IMPROVED_RE = /^You have improved (.+?) (\d+) at a cost of/

// ----- item upgrade / merge (Task #60) -----
// FULL-LOG SWEEP (read-only, 2026-08-02) of every merge/upgrade/mote/exaltation line family.
// What EXISTS, and what we parse:
//
//   PARSED
//   236×  `You have successfully merged two items together to create a new item: <Name>`
//         The upgrade itself. The result name is the ONLY tier signal the game ever prints:
//         159 of the 236 end in ` +N` (an item level); the other 77 end in a ROMAN RANK
//         (`Shiftless Deeds III`, `Allure VI`) because the same line fires when two SPELL
//         SCROLLS are merged. A rank is not a tier, so `tier` stays undefined there.
//     4×  `Your request to merge <target> with <component> failed. The items do not match,
//         are the exact same item, cannot be merged, the component (the item to be
//         destroyed) has an augment, or one of the items is no longer in your inventory.`
//         The ONLY failure shape that names items — and `<target>` carries its ` +N`, i.e.
//         it states the tier of an item you are holding.
//     9×  `The item you are trying to add will not work, this mote is not sufficiently
//         powerful to upgrade this item.`                            (no item named)
//     4×  `The item you are trying to add will not work, you cannot fuse an item to
//         itself.` — NB this one never says "merge", so a sweep on that word alone MISSES
//         it; it surfaced by diffing parsed output against the raw log. (no item named)
//     1×  `The item you are trying to add will not work, you cannot merge two different
//         types of items.`                                           (no item named)
//     1×  `Request to merge items canceled, both items remain unmodified.` (no item named)
//
//   EXISTS, DELIBERATELY NOT PARSED (nothing to model — see the reason on each)
//   302×  `You looted <item> from <mob>'s corpse to create a <item> +N` — an AUTO-merge on
//         pickup. ALREADY parsed by the loot family as disposition:'combined' + `created`
//         (every one of the 302 creates `<same base> +N`), so a second matcher would
//         double-count. The itemTiers module folds it from the loot event.
//  6433×  `Your <Item> (Exaltation) shimmers briefly.` / `feels alive with power.` /
//         `flickers with a pale light.` / `pulses with light as your vision sharpens.`
//         A socketed exaltation FIRING. It names the exaltation's SOURCE item, never the
//         host it is socketed into, and carries no tier, so it can neither identify the
//         item in front of you nor advance any tier state.
//    ~30× `You successfully destroyed 1 <Item> +N.` — the item is GONE; a destroy can only
//         retire tier evidence we never claimed to be current inventory.
//   Motes appear ONLY inside ordinary loot lines (`--You have looted a Mote of
//   Infinitesimal Potential …--`), which the loot family already parses.
//   NOTHING anywhere reports item EXP within a tier, socket CONTENTS, or the tier of an
//   item you merely hold — hence no exp fill in the UI (law 1).
const ITEM_MERGE_RE = /^You have successfully merged two items together to create a new item: (.+)$/
const ITEM_MERGE_FAIL_RE = /^Your request to merge (.+?) with (.+?) failed\. /

// ----- combat matchers (verbatim from combat/parse.ts) -----

// Every verb must match BOTH first-person ("You slash") and third-person
// ("A mob slashes"). Spelled out explicitly (a bare `slashes?` drops all
// first-person melee).
const MELEE_VERBS =
  'hit(?:s)?|slash(?:es)?|pierce(?:s)?|crush(?:es)?|bash(?:es)?|kick(?:s)?|bite(?:s)?|claw(?:s)?|gore(?:s)?|maul(?:s)?|punch(?:es)?|strike(?:s)?|slice(?:s)?|backstab(?:s)?|slam(?:s)?|sting(?:s)?|rend(?:s)?|smash(?:es)?|gnaw(?:s)?|lash(?:es)?|smite(?:s)?|cleave(?:s)?|reave(?:s)?|shoot(?:s)?|frenzies on|frenzy on|flurries|flurry'

const MELEE_RE = new RegExp(`^(.+?) (?:${MELEE_VERBS}) (.+?) for (\\d+) points? of damage\\.(?: \\((.+?)\\))?$`)
const MELEE_VERB_RE = new RegExp(` (${MELEE_VERBS}) `)
const SPELL_RE = /^(.+?) (?:hits?) (.+?) for (\d+) points of ([\w-]+) damage by (.+?)\.(?: \((.+?)\))?$/
const DS_RE = /^(.+?) is \w+ by (YOUR|.+?'s) (.+?) for (\d+) points? of non-melee damage\.$/
// Incoming DS on the player: "YOU are burned by a X's flames for N points of
// non-melee damage!" (reversed grammar + trailing '!'). Mob = attacker.
const DS_INC_RE = /^YOU are \w+ by (.+?)'s (.+?) for (\d+) points? of non-melee damage!$/
// DoT with a caster: "<B> has taken N damage from your <Spell>." | "… from <Spell> by <caster>."
// An optional trailing " (Critical)" (or other) modifier may follow the period.
const DOT_RE = /^(.+?) has taken (\d+) damage from (.+?)\.(?: \((.+?)\))?$/
// Caster-less DoT (someone else's): "<B> has taken N damage by <Spell>." → attacker:null.
const DOT_NOCASTER_RE = /^(.+?) has taken (\d+) damage by (.+?)\.(?: \((.+?)\))?$/

const CHARM_RE = /^(.+?) has been charmed\.$/
const UNCHARM_RE = /^Your (.+?) spell has worn off of (.+?)\.$/
// Crowd-control APPLICATION (mez/root), NOT charm: "<mob> has been mesmerized." and
// siblings. Charm is handled separately (CHARM_RE); the DoT-application shapes
// (poisoned/diseased) and unrelated spell notices (smitten/overwritten) are NOT CC
// and are excluded. `ensnared` is a root (a hold), so it counts.
const CC_APPLY_RE = /^(.+?) has been (?:mesmerized|enthralled|entranced|ensnared)\.$/
// Pet-ownership claim (direct tell). Two phrasings, both pet-only in the real log:
//   "<Name> told you, 'Attacking <target> Master.'"
//   "<Name> told you, 'I am unable to wake <mob>, Master.'"
// The direct-tell channel ("told you") ends in "Master.'" ONLY for pets — a full
// scan found zero player false positives (players use "tells General1:1", not a
// direct tell ending in ", Master.'"). We match these two exact suffixes rather
// than a loose "…Master.'" to stay conservative. Captures the pet's name.
const PET_CLAIM_RE =
  /^(.+?) told you, '(?:Attacking .+ Master|I am unable to wake .+?, Master)\.'$/
// True charm spells only — MEZ spells (Enthrall/Mesmerize/Entrance/Dazzle…) also
// wear off but must NOT uncharm. Stems audited against real worn-off lines.
const CHARM_SPELL_RE =
  /\bcharm\b|beguile|allure|cajol|dictate|besiege|agacerie|beckon|command of druzzil|dominate|boltran/i

// ----- buffs (Task #19): cast lifecycle + self/pet buff fades -----
// Validated shapes (real log, 2026-08-01):
//   "You begin casting <Spell>."            12,309×  — player starts a cast
//   "You begin singing <Song>."                  5×  — bard song (same pending model)
//   "Your <Spell> spell fizzles!"              476×  — cast failed (always names spell)
//   "Your <Spell> spell is interrupted."             — cast interrupted (always names spell;
//        there is NO bare "Your spell is interrupted." in the log)
//   "Your <Spell> spell has worn off."        (self-cast buff on the player expired)
//   "Your pet's <Spell> spell has worn off."  (buff the player cast on their pet expired)
// The worn-off-OF-<mob> shape (charm/mez) is handled earlier by uncharm/cc; these
// TARGETLESS forms are never charm/cc, so buffFade is a pure fallthrough with no
// overlap. "You regain your concentration…" is a recovered cast — deliberately NOT
// treated as an interrupt.
const CAST_BEGIN_RE = /^You begin (?:casting|singing) (.+?)\.$/
const CAST_FIZZLE_RE = /^Your (.+?) spell fizzles!$/
const CAST_INTERRUPT_RE = /^Your (.+?) spell is interrupted\.$/
// Targetless worn-off (no " of <mob>"): self-cast or pet-cast buff expiry.
const BUFF_FADE_PET_RE = /^Your pet's (.+?) spell has worn off\.$/
const BUFF_FADE_SELF_RE = /^Your (.+?) spell has worn off\.$/
// Player's own death: "You have been slain by <killer>!" (distinct from the
// third-person "<mob> has been slain by <x>!" SLAIN_BY_RE, which needs "has").
const PLAYER_DEATH_RE = /^You have been slain by (.+?)!$/

// Activated AA (Task #34): "You activate Quick Buff." (69× in the real log). A Quick Buff
// activation is followed within ~2-3s by a burst of self-buff landing messages (no "You
// begin casting" lines) — the buffs module uses it as context to mark those applies
// confident. Any activated AA matches; consumers filter by name.
const AA_ACTIVATE_RE = /^You activate (.+?)\.$/

// ----- combat stances + invocations (Task #51) -----
// EQ Legends has two mutually-exclusive combat-modifier groups. The COMMIT line names
// the chosen one; the "You begin to change your <group>." lines are pre-commit flavor
// (594 stance / 2339 invocation) and are deliberately NOT emitted (they carry no name).
//   STANCE (9 verified, full-log counts): defensive 210, offensive 176, balanced 59,
//                mage hunter 43, evasive 36, striker 35, berserker 22, channeler 11,
//                ranged 1. Regex is name-permissive (.+?) so a 10th stance still parses.
//   INVOCATION (9 verified): inversion 937, overchannel 487, recovery 450, spellblade
//                263, divine 134, inviolable 19, empowering 15, arcane mastery 14,
//                unyielding 5. (The brief listed 5; the sweep found 9 — "arcane mastery"
//                is a two-word name a single-word grep misses, so the .+? capture matters.)
// The article ("a"/"an") is dropped from the stance name; names are lowercased.
const STANCE_RE = /^You assume an? (.+?) stance\.$/
const INVOCATION_RE = /^You begin reciting the (.+?) invocation\.$/

// ----- spell-landing emotes (Task #33): the cast-target discriminator -----
// EQ prints a short flavor line the instant a buff lands. Two forms:
//   SELF:  "You feel much faster."  "You feel much better."  "You feel armored."  …
//   PET:   "<Name> feels much faster."  "Bzzazzt feels much better."             …
// These are CANDIDATES only — the buffs module learns which emote reliably follows a
// given spell's cast (≥2×, no contradiction) before trusting it, and only uses a
// temporally-adjacent one to set a cast's target. So the gate is deliberately
// PERMISSIVE: it just needs to isolate the "<subject> <perception-verb> …." shape and
// reject the obvious non-emotes (upkeep/weather/state spam) so the learner sees a clean
// candidate stream. It is matched LAST in classify() (after every real family), so it
// can never shadow a combat/cast/charm/etc. line — anything that already parsed is gone.
//
// Self form: "You <verb> …." where <verb> is a perception/appearance verb. We EXCLUDE
// the ubiquitous upkeep/state lines ("You are hungry/thirsty/no longer …", "You have
// …", "You feel a traveling spirit …" is allowed — harmless flavor). The exclusions
// keep the candidate stream lean; a stray candidate that doesn't consistently follow a
// cast is ignored by the learner anyway.
const EMOTE_SELF_RE =
  /^You (?:feel|look|sense|seem)\b[^.]*\.$/
// Third-person: "<Name> <verb>s …." — the verb ends in s (feels/looks/seems) and the
// subject is a name (may contain spaces/apostrophes/backticks, EQ mob names).
const EMOTE_PET_RE =
  /^([A-Z][A-Za-z'`]*(?: [A-Za-z'`]+)*) (?:feels|looks|seems)\b[^.]*\.$/

// ----- heal (NEW): "<healer> healed <target> for N hit points[ by <spell>]." -----
// Two shapes in the real log:
//   "<healer> healed <target> for 120 hit points by <Spell>."         (amount only)
//   "<healer> healed <target> for 85 (107) hit points by <Spell>."    (actual first,
//     raw/overheal amount in parens — ~2.7k lines the old amount-only regex missed).
// `amount` is always the FIRST number (effective heal); the parenthesized raw amount
// is captured separately as `rawAmount`. Singular "hit point" is tolerated too.
//
// CRITICAL HEALS (Task #59): heal lines carry the damage family's trailing paren modifier —
// "… by Superior Healing. (Critical)" — AFTER the sentence period, so the old `\.$` anchor
// REJECTED all 233 of them and the model silently lost those heals (nine distinct spells,
// including the biggest single-hit heals in the log). The optional trailing group fixes that;
// a full-log sweep (2026-08-02) confirms `(Critical)` is the ONLY modifier a heal ever carries.
// Spell names contain no '.', so the lazy spell capture can never swallow the period.
const HEAL_RE =
  /^(.+?) healed (.+?) for (\d+)(?: \((\d+)\))? hit points?(?: by (.+?))?\.(?: \(([A-Za-z][A-Za-z ]*)\))?$/

// ----- absorption / mitigation (Task #59) — damage PREVENTED, never hit points restored -----
// Three VERIFIED self-form families (see MitigationEvent in shared/logEvents.ts for the counts):
//   `You gain a rune for 12 points of absorption.`                       → 'rune' (has an amount)
//   `<mob> tries to bash YOU, but YOUR magical skin absorbs the blow!`   → 'absorbSwing' (COUNT)
//        …but as of the MISS_RE self-absorb fix this shape is claimed by the MISS family
//        instead (miss, mtype 'absorb', target 'You'); see the note below RUNE_GAIN_RE.
//   `YOUR magical skin absorbs the damage of <mob>'s thorns.`            → 'absorbDamageShield'
// The blow form is matched ONLY AFTER MISS_RE has been given the line (see classify). That fix
// HAS NOW LANDED: MISS_RE learned the bare-`YOUR` alternative, so every real absorbed swing is a
// `miss` event with mtype 'absorb' and target 'You', and this branch no longer fires for any shape
// present in the log. It is kept as the safety net for the one shape MISS_RE still declines — a
// COMPOUND trailing modifier (`! (Riposte Slay Undead)`), which MISS_RE's single-word
// `\([A-Za-z]+\)` tail rejects while this regex's `[A-Za-z ]+` accepts. No such line exists today
// (full-log sweep 2026-08-02: the miss family's only modifiers are the single words Riposte 4751,
// Rampage 92, Flurry 65 — compound modifiers appear on DAMAGE lines only). Either way a line yields
// EXACTLY ONE event, so the engine (which counts absorbed swings off both the mitigation path and
// incoming misses with mtype 'absorb') can never double-count.
const RUNE_GAIN_RE = /^You gain a rune for (\d+) points? of absorption\.$/
const SKIN_ABSORB_BLOW_RE =
  /^(.+?) tr(?:y|ies) to \w+ (?:on )?YOU, but YOUR magical skin absorbs the blow!(?: \([A-Za-z ]+\))?$/
const SKIN_ABSORB_DS_RE = /^YOUR magical skin absorbs the damage of (.+?)'s .+\.$/

// ----- miss (NEW): "<A> tr(y|ies) to <verb> <B>, but <outcome>!" -----
// Outcome disambiguates the miss type:
//   miss!/misses!                        → 'miss' (self uses base, 3rd person -es)
//   <defender> parries/dodges/ripostes/blocks!   → defender-named, 3rd person verb
//   YOU parry/dodge/riposte/block!               → defender = you, base verb
//   <name>'s magical skin absorbs the blow!      → 'absorb', defender = <name>
//   YOUR magical skin absorbs the blow!          → 'absorb', defender = You
// An optional trailing swing modifier " (Riposte)"/"(Flurry)"/"(Rampage)" may
// follow the "!" — allowed and discarded.
//
// SELF RUNE ABSORB (bug fix, verified against the real log 2026-08-02): the absorb
// alternative used to require a POSSESSIVE `<name>'s magical skin`, so the SELF form —
// `A deadly black widow tries to bite YOU, but YOUR magical skin absorbs the blow!` —
// never produced a MISS event. (It fell through to 'unknown' originally; Task #59 then
// caught it downstream as a `mitigation` event, which fixed the absorption COUNT but left
// the miss aggregate just as blind, since a mitigation event never reaches routeMiss.)
// Full-log sweep: 385 bare-`YOUR` lines vs 1,428 possessive lines that parsed fine. Every
// dropped line is an INCOMING avoided swing, so the loss was a pure undercount in the
// engine's incoming miss aggregates (addIncMiss) and therefore in defensive hit% /
// avoidance — no damage total moved (a miss carries no amount, law 8).
// The two absorb shapes are DISJOINT (`.+?'s ` needs a literal apostrophe-s that the
// `YOUR` form does not have), so the added alternative can never steal a possessive line.
// The self branch names NO defender — group 2 is the swing's object — so it supplies one
// itself: YOUR skin means the swing was at YOU (see classify()). Observed shapes are all
// third-person `<mob> tries to <verb> YOU, …`, with `(Riposte)` the only modifier (34×).
//
// PREPOSITIONAL VERBS (Task #58): a few melee verbs take an object preposition —
// "You try to frenzy ON a deadly black widow, but miss!" — and the bare `\w+ (.+?)`
// capture swallowed it, so the miss carried the target "on a deadly black widow"
// while the LANDED form ("You frenzy on X for N points…") parsed clean. That leaked a
// phantom "on <mob>" defender into every per-mob view. The optional `(?:on )?` is
// greedy, so it is consumed whenever present and skipped otherwise.
// VERIFIED against the real log (full sweep, 2026-08-02): of the 26 distinct verbs in the
// "tr(y|ies) to <verb>" family, `frenzy` is the ONLY one that takes a preposition
// (1,012 lines, all "on"); no other verb is ever followed by on/at/with/upon/into, and no
// mob name begins with the word "on", so the strip cannot eat part of a real name.
const MISS_RE = new RegExp(
  '^(.+?) tr(?:y|ies) to \\w+ (?:on )?(.+?), but ' +
    '(?:(miss|misses)' + // 3: plain miss (self/3rd person)
    '|(.+?) (parries|dodges|ripostes|blocks)' + // 4:defender 5:3rd-person verb
    '|(YOU) (parry|dodge|riposte|block)' + // 6:YOU 7:base verb
    "|.+?'s magical skin (absorbs) the blow" + // 8: absorb, possessive (defender NAMED)
    '|(YOUR) magical skin absorbs the blow)' + // 9: absorb, SELF (defender is You)
    '!(?: \\([A-Za-z]+\\))?$'
)

// ----- spell resist (NEW, Task #51 timeline v2) -----
// A detrimental spell fully resisted — the caster-side analogue of a melee miss.
// VERIFIED shapes (full-log sweep, 2026-08-02):
//   "<target> resisted your <Spell>!"          → you cast it (caster = 'you')
//   "<target> resisted <caster>'s <Spell>!"    → a named caster (pet or mob)
//   "You resist[ed] <caster>'s <Spell>!"       → INCOMING, you resisted a mob's spell
// The spell may carry a trailing rank ("Mesmerization III"); we keep the display form and
// let the engine rank-normalize. NB the "your" and "<caster>'s" forms OVERLAP when the
// spell name itself contains "'s" (e.g. "Denon's Disruptive Discord"), so we test the
// possessive-YOUR form FIRST and only then the named-caster form (712 such lines in the
// real log). The incoming "You resist" form is tested before either outgoing form.
// The gate below also excludes the "…unresistable damage…" line family (a damage line).
const RESIST_YOURS_RE = /^(.+?) resisted your (.+?)!$/
const RESIST_CASTER_RE = /^(.+?) resisted (.+?)'s (.+?)!$/
const RESIST_INCOMING_RE = /^You resist(?:ed)? (.+?)'s (.+?)!$/

// ----- name normalization (verbatim from combat/parse.ts) -----

function norm(name: string): string {
  const n = name.trim()
  const l = n.toLowerCase()
  if (l === 'you' || l === 'yourself' || l === 'your') return 'You'
  return n
}

/**
 * Canonical identity key for an entity name. EQ writes the same mob with
 * different casing (charm lines lowercase the article, damage lines capitalize
 * it); keying state by this lowercased form makes lookups case-stable. 'You'
 * stays special. (Re-exported here so consumers no longer import combat/parse.)
 */
export function idKey(name: string): string {
  const n = name.trim().toLowerCase()
  if (n === 'you' || n === 'yourself' || n === 'your') return 'you'
  return n
}

/**
 * Canonical SPELL key (Task #33): lowercase, trimmed, with a trailing rank token
 * stripped. EQ Legends suffixes current-session casts with a Roman-numeral RANK —
 * "You begin casting Swift Like the Wind I." / "Shiftless Deeds IV" / "Allure VI" —
 * but EVERY fade/fizzle/interrupt line DROPS the rank ("Your Swift Like the Wind spell
 * has worn off …", "Your Shiftless Deeds spell fizzles!"). Keying the buffs model by
 * the raw name breaks cast↔fade pairing (2,507/12,442 casts carry a rank tail).
 *
 * The stripped token is a trailing I–X Roman numeral at the END of the name only,
 * word-bounded. VERIFIED SAFE against the real log (2026-08-01): NO fade/fizzle/
 * interrupt line ever ends in a Roman numeral, and every one of the 16 distinct
 * rank-tailed base spells (Swift Like the Wind, Shiftless Deeds, Allure, Clarity,
 * Superior Healing, Lay on Hands, …) is a real spell whose identity does not include a
 * Roman-numeral word — so stripping the tail can never merge two genuinely-different
 * spells. The DISPLAY name keeps its suffix (callers pass the raw spell for display);
 * only the KEY is canonicalized.
 */
const RANK_TAIL_RE = / (?:I|II|III|IV|V|VI|VII|VIII|IX|X)$/
export function spellCanonKey(spell: string): string {
  return spell.trim().replace(RANK_TAIL_RE, '').trim().toLowerCase()
}

function meleeSkill(verb: string): string {
  const v = verb.toLowerCase()
  if (v.startsWith('backstab')) return 'Backstab'
  if (v.startsWith('bash')) return 'Bash'
  if (v.startsWith('kick')) return 'Kick'
  if (v.startsWith('frenz')) return 'Frenzy'
  if (v.startsWith('flurr')) return 'Flurry'
  return 'Melee'
}

function cleanMob(s?: string): string | undefined {
  if (!s) return undefined
  return s.replace(/['`’]s$/i, '').trim() || undefined
}

/** True if a line looks like damage but we couldn't classify it (for the miss log). */
export function looksDamage(text: string): boolean {
  return /\bfor \d+ points? of|\bhas taken \d+ damage/.test(text)
}

// ----- the single pass -----

/**
 * Parse one raw log line into a canonical LogEvent, or null if it isn't a
 * timestamped log line. `seq` is stamped onto the event by the feeder.
 *
 * Ordering is cheap-discriminator-first: each family is gated by a substring
 * probe on the message text so the regex battery only runs for candidate lines.
 * The huge miss/avoid family is checked first (via a single `, but ` probe) and
 * short-circuits, since it dominates a real combat log by an order of magnitude.
 */
export function parseEvent(raw: string, seq: number, profileId: string = DEFAULT_PROFILE): LogEvent | null {
  const pm = LINE_RE.exec(raw)
  if (!pm) return null
  const ts = parseEqTimestamp(pm[1])
  const text = pm[2]
  const cfg = getParserConfig(profileId)
  return classify(text, ts, seq, raw, cfg)
}

/**
 * A parsed log-line envelope (`ts`/`text`/`raw`) with no content classification.
 * Kept for the `log:line` IPC push, whose payload shape the renderer relies on.
 * Returns null when the line has no timestamp prefix.
 */
export function parseLine(raw: string): { ts: number; text: string; raw: string } | null {
  const m = LINE_RE.exec(raw)
  if (!m) return null
  return { ts: parseEqTimestamp(m[1]), text: m[2], raw }
}

function classify(text: string, ts: number, seq: number, raw: string, cfg: ParserConfig): LogEvent {
  // --- misses / avoided swings (by far the most common combat line) ---
  if (text.includes(', but ') && (text.startsWith('You try to ') || text.includes(' tries to '))) {
    const m = MISS_RE.exec(text)
    if (m) {
      const attacker = norm(m[1])
      // Groups: 1=attacker 2=verb-object 3=miss|misses 4=defender 5=3rd-verb
      //         6=YOU 7=base-verb 8=absorbs(possessive) 9=YOUR(self)
      let mtype: MissType
      let target: string
      if (m[3]) {
        mtype = 'miss'
        target = norm(m[2])
      } else if (m[5]) {
        mtype = m[5] === 'parries' ? 'parry' : m[5] === 'dodges' ? 'dodge' : m[5] === 'ripostes' ? 'riposte' : 'block'
        target = norm(m[4])
      } else if (m[7]) {
        mtype = m[7] as MissType // parry|dodge|riposte|block (base form == MissType)
        target = 'You'
      } else if (m[9]) {
        // SELF rune absorb ("… but YOUR magical skin absorbs the blow!"). This branch names
        // no defender — group 2 is only the swing's OBJECT — so the defender comes from the
        // branch itself: it is YOUR skin, so the swing was aimed at You. (The object capture
        // does read "YOU" on every observed line, but the branch is the authority: `YOUR
        // magical skin` can only ever describe the player, whatever the object text says.)
        mtype = 'absorb'
        target = 'You'
      } else {
        // Possessive absorb ("… but <B>'s magical skin absorbs the blow!") — a MOB's own rune
        // eating our swing. The defender is the swing's object, exactly as before.
        mtype = 'absorb'
        target = norm(m[2])
      }
      return { kind: 'miss', seq, ts, raw, attacker, target, mtype }
    }
    // MISS_RE declined the line. It now OWNS the self rune-absorb form ("… but YOUR magical skin
    // absorbs the blow!") — every shape in the real log parses as a miss with mtype 'absorb' — so
    // this stays purely as the downstream safety net for a compound trailing modifier MISS_RE's
    // single-word tail rejects. Whichever regex claims the line, exactly ONE event is emitted.
    const a = SKIN_ABSORB_BLOW_RE.exec(text)
    if (a) return { kind: 'mitigation', seq, ts, raw, mtype: 'absorbSwing', source: norm(a[1]) }
  }

  // --- absorption / mitigation (Task #59): rune grants + absorbed damage-shield ticks. ---
  // Checked BEFORE the damage battery: the rune line contains "points of", which is that
  // battery's gate, and it must never be mistaken for a damage line.
  if (text.startsWith('You gain a rune for ')) {
    const m = RUNE_GAIN_RE.exec(text)
    if (m) return { kind: 'mitigation', seq, ts, raw, mtype: 'rune', amount: Number(m[1]) }
  }
  if (text.startsWith('YOUR magical skin absorbs the damage of ')) {
    const m = SKIN_ABSORB_DS_RE.exec(text)
    if (m) return { kind: 'mitigation', seq, ts, raw, mtype: 'absorbDamageShield', source: norm(m[1]) }
  }

  // --- spell resists (NEW, Task #51 timeline v2) — the caster-side "miss". ---
  // Gate: the word "resist" is present AND this is a resist EMOTE line (not a
  // "…unresistable damage…" damage line, which carries "points of" and is handled by
  // the damage battery below). Every real resist emote line ends in "!" and contains
  // "resisted"/"resist". Check the incoming "You resist…" form first, then the
  // possessive-"your" outgoing form (BEFORE the named-caster form, because a spell name
  // may itself contain "'s" — e.g. "Denon's Disruptive Discord").
  if (text.includes('resist') && !text.includes('points of') && text.endsWith('!')) {
    if (text.startsWith('You resist')) {
      const m = RESIST_INCOMING_RE.exec(text)
      if (m) return { kind: 'resist', seq, ts, raw, caster: norm(m[1]), target: 'You', spell: m[2].trim(), incoming: true }
    } else {
      let m = RESIST_YOURS_RE.exec(text)
      if (m) return { kind: 'resist', seq, ts, raw, caster: 'you', target: norm(m[1]), spell: m[2].trim(), incoming: false }
      m = RESIST_CASTER_RE.exec(text)
      if (m) return { kind: 'resist', seq, ts, raw, caster: norm(m[2]), target: norm(m[1]), spell: m[3].trim(), incoming: false }
    }
  }

  // --- damage: melee / spell / dot / damage-shield ---
  // Gate on the shared damage substrings so non-combat lines skip the battery.
  // Both plural ("50 points of") and singular ("1 point of") forms count — the
  // old looksCombat pre-filter only checked "points of" and silently dropped
  // every 1-damage swing; the underlying regexes always handled `points?`.
  const hasPoints = text.includes('points of') || text.includes('point of')
  const hasTaken = text.includes('has taken')
  if (hasPoints || hasTaken) {
    if (hasPoints) {
      // Damage shield out: "<B> is <verb> by (YOUR|<owner>'s) <element> for N points of non-melee damage."
      let m = DS_RE.exec(text)
      if (m) {
        const owner = m[2] === 'YOUR' ? 'You' : norm(m[2].replace(/'s$/, ''))
        return dmg(seq, ts, raw, owner, norm(m[1]), Number(m[4]), 'ds', m[3].trim(), false)
      }
      // Incoming DS on you.
      m = DS_INC_RE.exec(text)
      if (m) return dmg(seq, ts, raw, norm(m[1]), 'You', Number(m[3]), 'ds', m[2].trim(), false)
      // Typed spell nuke.
      m = SPELL_RE.exec(text)
      if (m) {
        const modifier = m[6]
        const mods = parseModifiers(modifier)
        return {
          kind: 'damage', seq, ts, raw,
          attacker: norm(m[1]), target: norm(m[2]), amount: Number(m[3]),
          dtype: 'spell', dclass: m[4], skill: m[5].trim(),
          crit: hasCritical(mods), modifier, modifiers: mods, category: damageCategory('spell', mods)
        }
      }
      // Melee.
      m = MELEE_RE.exec(text)
      if (m) {
        const verbM = MELEE_VERB_RE.exec(text)
        const modifier = m[4]
        const mods = parseModifiers(modifier)
        return {
          kind: 'damage', seq, ts, raw,
          attacker: norm(m[1]), target: norm(m[2]), amount: Number(m[3]),
          dtype: 'melee', skill: meleeSkill(verbM ? verbM[1] : 'hit'),
          crit: hasCritical(mods), modifier, modifiers: mods, category: damageCategory('melee', mods)
        }
      }
    }
    if (hasTaken) {
      // DoT with a caster: "<B> has taken N damage from your <Spell>." | "… from <Spell> by <caster>."
      let m = DOT_RE.exec(text)
      if (m) {
        const target = norm(m[1])
        const amount = Number(m[2])
        const rest = m[3]
        const crit = /critical/i.test(m[4] ?? '')
        let attacker: string | null = null
        let skill = rest
        if (/^your /i.test(rest)) {
          attacker = 'You'
          skill = rest.replace(/^your /i, '')
        } else {
          const by = / by (.+)$/.exec(rest)
          if (by) {
            attacker = norm(by[1])
            skill = rest.slice(0, by.index)
          }
        }
        // "from <Spell>" with no "by <caster>" and not "your" → someone else's DoT
        // whose caster the game didn't name; fall through to the caster-less form.
        if (attacker !== null) {
          const mods = parseModifiers(m[4])
          return { kind: 'damage', seq, ts, raw, attacker, target, amount, dtype: 'dot', skill: skill.trim(), crit, modifier: m[4], modifiers: mods, category: 'dot' }
        }
      }
      // Caster-less DoT: "<B> has taken N damage by <Spell>." → attacker:null.
      m = DOT_NOCASTER_RE.exec(text)
      if (m) {
        const crit = /critical/i.test(m[4] ?? '')
        const mods = parseModifiers(m[4])
        return { kind: 'damage', seq, ts, raw, attacker: null, target: norm(m[1]), amount: Number(m[2]), dtype: 'dot', skill: m[3].trim(), crit, modifier: m[4], modifiers: mods, category: 'dot' }
      }
    }
  }

  // --- heals (NEW) ---
  if (text.includes(' healed ')) {
    const m = HEAL_RE.exec(text)
    if (m) {
      const healer = norm(m[1])
      // "<X> healed itself/himself/herself/themselves" → target is the healer.
      const tRaw = m[2].trim()
      const reflexive = /^(itself|himself|herself|themselves)$/i.test(tRaw)
      return {
        kind: 'heal', seq, ts, raw,
        target: reflexive ? healer : norm(tRaw),
        amount: Number(m[3]),
        rawAmount: m[4] ? Number(m[4]) : undefined,
        spell: m[5]?.trim() || undefined,
        healer,
        crit: /critical/i.test(m[6] ?? '')
      }
    }
  }

  // --- cast lifecycle (Task #19): begin / fizzle / interrupt (player's own casts) ---
  if (text.startsWith('You begin ')) {
    const m = CAST_BEGIN_RE.exec(text)
    if (m) return { kind: 'castBegin', seq, ts, raw, spell: m[1].trim() }
  }
  if (text.includes('spell fizzles!')) {
    const m = CAST_FIZZLE_RE.exec(text)
    if (m) return { kind: 'castFizzle', seq, ts, raw, spell: m[1].trim() }
  }
  if (text.includes('spell is interrupted.')) {
    // Only the PLAYER's own interrupt ("Your <Spell> spell is interrupted.");
    // "<mob>'s <Spell> spell is interrupted." is someone else and is ignored.
    const m = CAST_INTERRUPT_RE.exec(text)
    if (m) return { kind: 'castInterrupted', seq, ts, raw, spell: m[1].trim() }
  }

  // --- charm lifecycle ---
  if (text.includes('has been charmed')) {
    const m = CHARM_RE.exec(text)
    if (m) return { kind: 'charm', seq, ts, raw, mob: norm(m[1]) }
  }
  if (text.includes('worn off of')) {
    const m = UNCHARM_RE.exec(text)
    if (m) {
      // A charm spell wearing off retires the pet (uncharm). A MEZ/ROOT spell wearing
      // off is instead a CC keep-alive refresh — the mob was held right up to now.
      // Charm/cc precedence is UNCHANGED (regression-gated).
      if (cfg.charmSpell.test(m[1])) return { kind: 'uncharm', seq, ts, raw, mob: norm(m[2]) }
      if (cfg.ccSpell.test(m[1])) return { kind: 'cc', seq, ts, raw, mob: norm(m[2]), spell: m[1].trim(), refresh: true }
      // NAMED-TARGET buff fade (Task #30): a NON-charm, NON-cc spell wearing off OF a
      // named target is a real buff the player cast on that target (e.g. a pet buff
      // cast on the charmed mob by name: "Your Swift Like the Wind spell has worn off
      // of an ice giant."). Previously this fell through and emitted NOTHING, so the
      // Buffs tab missed every named-target fade. The raw target name is carried on
      // `target` (can be a mob name); the buffs miner keys samples per spell — see
      // buffs.ts (per-spell-per-target pairing is a known v1 simplification).
      return { kind: 'buffFade', seq, ts, raw, spell: m[1].trim(), target: norm(m[2]) }
    }
  } else if (text.includes('worn off.')) {
    // TARGETLESS worn-off — the player's own buff (self or pet) expired. This is the
    // fallthrough AFTER the "worn off of <mob>" (charm/cc) handler above; these forms
    // never overlap (no " of "), so uncharm/cc emission is untouched (regression-safe).
    let m = BUFF_FADE_PET_RE.exec(text)
    if (m) return { kind: 'buffFade', seq, ts, raw, spell: m[1].trim(), target: 'pet' }
    m = BUFF_FADE_SELF_RE.exec(text)
    if (m) return { kind: 'buffFade', seq, ts, raw, spell: m[1].trim() }
  }
  // --- crowd-control application (mez/root, not charm) ---
  if (text.includes('has been ')) {
    const m = CC_APPLY_RE.exec(text)
    if (m) return { kind: 'cc', seq, ts, raw, mob: norm(m[1]) }
  }

  // --- pet-ownership claim (direct tell ⇒ the named entity is your pet) ---
  if (text.includes(" told you, '")) {
    const m = PET_CLAIM_RE.exec(text)
    if (m) return { kind: 'petClaim', seq, ts, raw, name: norm(m[1]) }
  }

  // --- deaths (unifies self-slain and slain-by) ---
  if (text.includes('slain')) {
    // Player's OWN death (Task #19): "You have been slain by <killer>!" — strips all
    // buffs. Matched before the third-person SLAIN_BY_RE (which needs "has been",
    // not "have been", so it never claims this line anyway). Kept separate from the
    // mob `death` kind so buff-clearing is unambiguous.
    let pd = PLAYER_DEATH_RE.exec(text)
    if (pd) return { kind: 'playerDeath', seq, ts, raw, killer: pd[1].trim() }
    let m = SLAIN_SELF_RE.exec(text)
    if (m) return { kind: 'death', seq, ts, raw, name: norm(m[1]), bySelf: true }
    m = SLAIN_BY_RE.exec(text)
    if (m) return { kind: 'death', seq, ts, raw, name: norm(m[1]), bySelf: false, killer: m[2].trim() }
  }

  // --- zone ---
  if (text.includes('entered')) {
    const m = ZONE_RE.exec(text)
    // Reject pseudo-zone effect notices (e.g. "an area where levitation effects do
    // not function") so they don't overwrite the real zone / disrupt the engine.
    if (m && !PSEUDO_ZONE_RE.test(m[1])) return { kind: 'zone', seq, ts, raw, zone: m[1].trim() }
  }

  // --- self-loot ---
  if (text.includes('looted')) {
    const m = LOOT_RE.exec(text) ?? LOOT_RE_PLAIN.exec(text)
    if (m) return loot(seq, ts, raw, m[2], cleanMob(m[3]), undefined, m[1])
    // Auto-disposition variants (Tasks #40/#47): looted-and-routed in one line. These carry
    // a `disposition` the loot module/quest counting use to decide whether the item is
    // still held ('currency'/'hoard'/'depot' = kept, quest-countable), gone ('sold' =
    // vendored), or merged into an upgrade ('combined' = consumed→created, net-zero held).
    const cur = LOOT_CURRENCY_RE.exec(text)
    if (cur) return loot(seq, ts, raw, cur[2], cleanMob(cur[3]), 'currency', cur[1])
    const sold = LOOT_SOLD_RE.exec(text)
    if (sold) return loot(seq, ts, raw, sold[2], cleanMob(sold[3]), 'sold', sold[1])
    const stored = LOOT_STORED_RE.exec(text)
    if (stored) {
      return loot(seq, ts, raw, stored[2], cleanMob(stored[3]), stored[4] === 'Dragon Hoard' ? 'hoard' : 'depot', stored[1])
    }
    const comb = LOOT_COMBINE_RE.exec(text)
    if (comb) return { ...loot(seq, ts, raw, comb[2], cleanMob(comb[3]), 'combined', comb[1]), created: comb[4].trim() }
  }

  // --- item upgrade (merge) — the tier event + every failure shape. Two substring probes,
  // because the mote-too-weak failure is the one line in the family that never says "merge"
  // ("The item you are trying to add will not work, this mote is not sufficiently powerful
  // to upgrade this item."). Ordered AFTER loot so the auto-merge-on-pickup line
  // (`… to create a <item> +N`) stays a single 'combined' loot event and is never
  // double-counted here. ---
  if (text.includes('merge') || text.startsWith('The item you are trying to add')) {
    const m = ITEM_MERGE_RE.exec(text)
    if (m) {
      const item = m[1].trim()
      // A ` +N` result is an item level; a Roman-rank result is a merged SPELL SCROLL and
      // carries no tier (law 1 — we never invent one for it).
      const tier = itemTierFromName(item)
      return tier === undefined
        ? { kind: 'itemMerge', seq, ts, raw, item }
        : { kind: 'itemMerge', seq, ts, raw, item, tier }
    }
    const f = ITEM_MERGE_FAIL_RE.exec(text)
    if (f) {
      return { kind: 'itemMergeFailed', seq, ts, raw, reason: 'mismatch', target: f[1].trim(), component: f[2].trim() }
    }
    if (text === 'The item you are trying to add will not work, this mote is not sufficiently powerful to upgrade this item.') {
      return { kind: 'itemMergeFailed', seq, ts, raw, reason: 'weakMote' }
    }
    if (text === 'The item you are trying to add will not work, you cannot fuse an item to itself.') {
      return { kind: 'itemMergeFailed', seq, ts, raw, reason: 'selfFuse' }
    }
    if (text === 'The item you are trying to add will not work, you cannot merge two different types of items.') {
      return { kind: 'itemMergeFailed', seq, ts, raw, reason: 'wrongType' }
    }
    if (text === 'Request to merge items canceled, both items remain unmodified.') {
      return { kind: 'itemMergeFailed', seq, ts, raw, reason: 'canceled' }
    }
  }

  // --- turn-ins ---
  if (text.includes('offered')) {
    const m = OFFER_RE.exec(text)
    if (m) return { kind: 'offer', seq, ts, raw, item: m[1].trim(), npc: m[2].trim() }
  }
  if (text.includes('complete the trade')) {
    const m = TRADE_DONE_RE.exec(text)
    if (m) return { kind: 'trade', seq, ts, raw, npc: m[1].trim() }
  }

  // --- leveling ---
  if (text.includes('gained a level')) {
    const m = LEVEL_RE.exec(text)
    if (m) return { kind: 'level', seq, ts, raw, level: Number(m[1]) }
  }

  // --- AA gains / spends ---
  if (text.includes('ability point')) {
    const g = AA_RE.exec(text)
    if (g) return { kind: 'aaGain', seq, ts, raw, amount: g[1] === 'an' ? 1 : Number(g[1]), nowHave: Number(g[2]) }
    const c = AA_SPEND_RE.exec(text)
    if (c) {
      const cost = Number(c[1])
      const imp = AA_IMPROVED_RE.exec(text)
      if (imp) {
        const rank = Number(imp[2])
        return { kind: 'aaSpend', seq, ts, raw, ability: `${imp[1].trim()} ${rank}`, cost, rank }
      }
      const a = AA_ABILITY_RE.exec(text)
      return { kind: 'aaSpend', seq, ts, raw, ability: (a?.[1] ?? a?.[2] ?? 'ability').trim(), cost }
    }
  }

  // --- activated AA (Task #34): "You activate <X>." (e.g. Quick Buff) ---
  if (text.startsWith('You activate ')) {
    const m = AA_ACTIVATE_RE.exec(text)
    if (m) return { kind: 'aaActivate', seq, ts, raw, name: m[1].trim() }
  }

  // --- combat stance change (Task #51): "You assume a <stance> stance." ---
  if (text.startsWith('You assume ')) {
    const m = STANCE_RE.exec(text)
    if (m) return { kind: 'stanceChange', seq, ts, raw, stance: m[1].trim().toLowerCase() }
  }
  // --- invocation change (Task #51): "You begin reciting the <name> invocation." ---
  // (Gated on the specific prefix so it never touches the "You begin casting/singing"
  // cast-lifecycle lines already handled above.)
  if (text.startsWith('You begin reciting ')) {
    const m = INVOCATION_RE.exec(text)
    if (m) return { kind: 'invocationChange', seq, ts, raw, invocation: m[1].trim().toLowerCase() }
  }

  // --- illusion click-off (Task #36): "Your illusion fades." ---
  // The shared removal line for EVERY illusion-flagged spell (Illusion: <race>, Boon of
  // the Garou, …) — the DB lists it as msg_wears_off for 27 distinct spells, so it can't
  // name which illusion faded. It doesn't need to: only ONE illusion is active at a time
  // (the user's rule), so this removes whichever illusion self buff is active. Emitted
  // HERE, before the DB buffWearOff table below, so the 27-way-ambiguous wears-off match
  // never fires for this exact line (which would remove an arbitrary first candidate).
  // NOT DB-gated — the text is unambiguous on its own.
  if (text === 'Your illusion fades.') {
    return { kind: 'illusionFade', seq, ts, raw, target: 'self' }
  }

  // --- message-driven buff events (Task #34) — DB-gated, additive. Emitted only when a
  // spell database is installed on the config (installSpellDb); with no DB these never
  // fire so parser purity holds and existing tests/profiles are byte-for-byte unchanged.
  // These matches take precedence over the permissive spellEmote candidate below: a line
  // that EXACTLY matches a DB message names the exact spell, which is strictly more
  // informative than an emote candidate. Unmatched emote-shaped lines still fall through
  // to spellEmote, so Task #33's cast-target learning is untouched for non-DB spells. ---
  const db = cfg.spellDb
  if (db) {
    // Self landing: msg_cast_on_you match → buffApply { self }. (Covers the Quick Buff
    // burst, whose landing messages have no "You begin casting" line.) A message may map to
    // several candidate spells (shared haste/clarity messages); we carry them all so the
    // buffs module resolves via the player's cast history.
    const selfCands = db.castOnYou.get(text)
    if (selfCands && selfCands.length) return buffApplyEvent(seq, ts, raw, 'self', selfCands)
    // Buff fade: msg_wears_off match → buffWearOff { self }. Message-driven expiry is
    // favored over estimate-based removal (the user directive). MANY spells share a
    // wears-off message ("Your speed returns to normal." = 9 haste spells, "Your strength
    // fades." = 13, …), so we carry the FULL candidate list (Task #45): the buffs module
    // resolves against the player's ACTIVE self buffs (EQ stacking ⇒ one candidate active at
    // a time). Removing by only the first candidate MISSED the actually-active buff.
    const wornCands = db.wearsOff.get(text)
    if (wornCands && wornCands.length) {
      return {
        kind: 'buffWearOff',
        seq,
        ts,
        raw,
        spell: wornCands[0].name,
        candidates: wornCands.map((s) => s.name),
        target: 'self'
      }
    }
    // Cast-on-other: the log names the target ("a froglok looks tranquil."), so match by
    // the invariant SUFFIX the wiki records as "Someone looks tranquil." → "looks
    // tranquil.". The target is the text before the suffix.
    const other = matchCastOnOther(text, db)
    if (other) return buffApplyEvent(seq, ts, raw, other.target, other.cands)
  }

  // --- spell-landing emotes (Task #33) — matched LAST so it never shadows a real
  // family. A candidate emote the buffs module uses to discriminate cast targets. ---
  if (text.startsWith('You ')) {
    // Exclude upkeep/state spam that shares the "You <verb> …" shape but is never a
    // spell-landing emote (hunger/thirst/state-off). "You feel/look/sense/seem …" only.
    if (EMOTE_SELF_RE.test(text)) return { kind: 'spellEmote', seq, ts, raw, subject: 'self', text }
  } else {
    const m = EMOTE_PET_RE.exec(text)
    // Never treat "You"/"Your" as a pet subject (self form handled above).
    if (m && idKey(m[1]) !== 'you') return { kind: 'spellEmote', seq, ts, raw, subject: norm(m[1]), text }
  }

  return { kind: 'unknown', seq, ts, raw }
}

/**
 * Match a log line against the DB cast-on-other SUFFIX table (Task #34). The wiki records
 * "Someone looks tranquil."; the log names the target ("a froglok looks tranquil."), so a
 * line matches when it ENDS WITH a known suffix ("looks tranquil.") and the prefix is a
 * plausible (non-empty) target name. Returns the spell + captured target, or null.
 *
 * Linear over the (few-hundred) unique suffixes only when the line could be an emote — the
 * caller reaches here only after every combat/cast/charm family missed, so the volume is
 * tiny. We test the longest suffixes first so a specific message isn't shadowed by a
 * shorter generic one.
 */
function matchCastOnOther(
  text: string,
  db: NonNullable<ParserConfig['spellDb']>
): { cands: import('../data/spellDb').SpellDb['spells']; target: string } | null {
  for (const [suffix, cands] of db.castOnOtherSuffix) {
    // Possessive suffixes ("'s face contorts …") attach directly to the name; others
    // ("looks tranquil.") follow a space.
    const attach = suffix.startsWith("'s") ? '' : ' '
    const tail = attach + suffix
    if (text.endsWith(tail) && text.length > tail.length) {
      const target = text.slice(0, text.length - tail.length).trim()
      if (target && target.length <= 60) return { cands, target: norm(target) }
    }
  }
  return null
}

/** Build a buffApply event from a target + candidate spell list (Task #34). The `spell`
 *  field is the first candidate (best-effort); `candidates` carries the full set for the
 *  buffs module to resolve against the player's cast history when ambiguous. */
function buffApplyEvent(
  seq: number,
  ts: number,
  raw: string,
  target: 'self' | string,
  cands: import('../data/spellDb').SpellDb['spells']
): LogEvent {
  const first = cands[0]
  return {
    kind: 'buffApply', seq, ts, raw, target,
    spell: first.name,
    illusion: first.illusion,
    durationMs: first.durationMs,
    candidates: cands.map((s) => ({ name: s.name, durationMs: s.durationMs, illusion: s.illusion }))
  }
}

/** Build a loot event from the shared capture layout of the loot regex family (Task #47):
 *  optional stack-count digits (in the article slot), item, source, disposition. `count`
 *  is omitted (not 1) when the line names no stack, keeping the common case payload-free. */
function loot(
  seq: number, ts: number, raw: string,
  item: string, source: string | undefined,
  disposition: import('../../shared/logEvents').LootDisposition | undefined,
  countStr: string | undefined
): LogEvent & { kind: 'loot' } {
  const ev: LogEvent & { kind: 'loot' } = { kind: 'loot', seq, ts, raw, item: item.trim(), source }
  if (disposition) ev.disposition = disposition
  if (countStr) ev.count = Number(countStr)
  return ev
}

function dmg(
  seq: number, ts: number, raw: string,
  attacker: string | null, target: string, amount: number,
  dtype: DamageType, skill: string, crit: boolean
): LogEvent {
  // DS lines carry no paren modifier; category maps 1:1 from dtype (never 'slay').
  return { kind: 'damage', seq, ts, raw, attacker, target, amount, dtype, skill, crit, category: damageCategory(dtype, []) }
}
