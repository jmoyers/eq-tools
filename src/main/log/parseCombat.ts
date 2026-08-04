// Combat families of the parse cascade (see parser.ts for the ordered list):
// misses/avoided swings, absorption/mitigation, spell resists, the damage battery
// (melee / typed spell / DoT / damage shield) and heals. Every regex and comment here is
// verbatim from the single-pass parser it was factored out of.

import type { DamageType } from '../../shared/combat'
import type { LogEvent, MissType } from '../../shared/logEvents'
import { parseModifiers, hasCritical, damageCategory } from '../combat/taxonomy'
import { norm, type ClassifyCtx } from './parseCommon'

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
//
// HEAL-OVER-TIME TICKS (2026-08-04). `<healer> healed <target> OVER TIME for N hit points by
// <Spell>.` is a real and common shape — 752 lines in the log across 12 distinct spells
// (Slugs Healing 191, Ethereal Cleansing 131, Echoing Light 78, …), 117 of them the player's
// own. The ` over time` sits between the target and the `for`, so the lazy target capture
// SWALLOWED it and every HoT tick was attributed to a phantom entity called
// "Primitive over time". It is now captured as its own optional group: the target is the real
// name again, and `overTime` reaches the model, where the cast-less proc detector needs it (a
// HoT tick is cast-DETACHED exactly the way a DoT tick is — see procDetect's DoT gate).
const HEAL_RE =
  /^(.+?) healed (.+?)( over time)? for (\d+)(?: \((\d+)\))? hit points?(?: by (.+?))?\.(?: \(([A-Za-z][A-Za-z ]*)\))?$/

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

function meleeSkill(verb: string): string {
  const v = verb.toLowerCase()
  if (v.startsWith('backstab')) return 'Backstab'
  if (v.startsWith('bash')) return 'Bash'
  if (v.startsWith('kick')) return 'Kick'
  if (v.startsWith('frenz')) return 'Frenzy'
  if (v.startsWith('flurr')) return 'Flurry'
  return 'Melee'
}

function dmg(
  { ts, seq, raw }: ClassifyCtx,
  spec: { attacker: string | null; target: string; amount: number; dtype: DamageType; skill: string; crit: boolean }
): LogEvent {
  // DS lines carry no paren modifier; category maps 1:1 from dtype (never 'slay').
  const { attacker, target, amount, dtype, skill, crit } = spec
  return { kind: 'damage', seq, ts, raw, attacker, target, amount, dtype, skill, crit, category: damageCategory(dtype, []) }
}

/**
 * Resolve a MISS_RE match into its miss type + defender.
 * Groups: 1=attacker 2=verb-object 3=miss|misses 4=defender 5=3rd-verb
 *         6=YOU 7=base-verb 8=absorbs(possessive) 9=YOUR(self)
 */
function missOutcome(m: RegExpExecArray): { mtype: MissType; target: string } {
  if (m[3]) return { mtype: 'miss', target: norm(m[2]) }
  if (m[5]) {
    const mtype: MissType =
      m[5] === 'parries' ? 'parry' : m[5] === 'dodges' ? 'dodge' : m[5] === 'ripostes' ? 'riposte' : 'block'
    return { mtype, target: norm(m[4]) }
  }
  // parry|dodge|riposte|block (base form == MissType)
  if (m[7]) return { mtype: m[7] as MissType, target: 'You' }
  if (m[9]) {
    // SELF rune absorb ("… but YOUR magical skin absorbs the blow!"). This branch names
    // no defender — group 2 is only the swing's OBJECT — so the defender comes from the
    // branch itself: it is YOUR skin, so the swing was aimed at You. (The object capture
    // does read "YOU" on every observed line, but the branch is the authority: `YOUR
    // magical skin` can only ever describe the player, whatever the object text says.)
    return { mtype: 'absorb', target: 'You' }
  }
  // Possessive absorb ("… but <B>'s magical skin absorbs the blow!") — a MOB's own rune
  // eating our swing. The defender is the swing's object, exactly as before.
  return { mtype: 'absorb', target: norm(m[2]) }
}

/** Misses / avoided swings (by far the most common combat line). */
export function classifyMiss({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.includes(', but ') && (text.startsWith('You try to ') || text.includes(' tries to '))) {
    const m = MISS_RE.exec(text)
    if (m) {
      const attacker = norm(m[1])
      const { mtype, target } = missOutcome(m)
      return { kind: 'miss', seq, ts, raw, attacker, target, mtype }
    }
    // MISS_RE declined the line. It now OWNS the self rune-absorb form ("… but YOUR magical skin
    // absorbs the blow!") — every shape in the real log parses as a miss with mtype 'absorb' — so
    // this stays purely as the downstream safety net for a compound trailing modifier MISS_RE's
    // single-word tail rejects. Whichever regex claims the line, exactly ONE event is emitted.
    const a = SKIN_ABSORB_BLOW_RE.exec(text)
    if (a) return { kind: 'mitigation', seq, ts, raw, mtype: 'absorbSwing', source: norm(a[1]) }
  }
  return null
}

/**
 * Absorption / mitigation (Task #59): rune grants + absorbed damage-shield ticks.
 * Checked BEFORE the damage battery: the rune line contains "points of", which is that
 * battery's gate, and it must never be mistaken for a damage line.
 */
export function classifyMitigation({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.startsWith('You gain a rune for ')) {
    const m = RUNE_GAIN_RE.exec(text)
    if (m) return { kind: 'mitigation', seq, ts, raw, mtype: 'rune', amount: Number(m[1]) }
  }
  if (text.startsWith('YOUR magical skin absorbs the damage of ')) {
    const m = SKIN_ABSORB_DS_RE.exec(text)
    if (m) return { kind: 'mitigation', seq, ts, raw, mtype: 'absorbDamageShield', source: norm(m[1]) }
  }
  return null
}

/**
 * Spell resists (NEW, Task #51 timeline v2) — the caster-side "miss".
 * Gate: the word "resist" is present AND this is a resist EMOTE line (not a
 * "…unresistable damage…" damage line, which carries "points of" and is handled by
 * the damage battery below). Every real resist emote line ends in "!" and contains
 * "resisted"/"resist". Check the incoming "You resist…" form first, then the
 * possessive-"your" outgoing form (BEFORE the named-caster form, because a spell name
 * may itself contain "'s" — e.g. "Denon's Disruptive Discord").
 */
export function classifyResist({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
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
  return null
}

/** The "points of damage" half of the damage battery: damage shield, spell nuke, melee. */
function pointsDamage(c: ClassifyCtx): LogEvent | null {
  const { text, ts, seq, raw } = c
  // Damage shield out: "<B> is <verb> by (YOUR|<owner>'s) <element> for N points of non-melee damage."
  let m = DS_RE.exec(text)
  if (m) {
    const owner = m[2] === 'YOUR' ? 'You' : norm(m[2].replace(/'s$/, ''))
    return dmg(c, { attacker: owner, target: norm(m[1]), amount: Number(m[4]), dtype: 'ds', skill: m[3].trim(), crit: false })
  }
  // Incoming DS on you.
  m = DS_INC_RE.exec(text)
  if (m) {
    return dmg(c, { attacker: norm(m[1]), target: 'You', amount: Number(m[3]), dtype: 'ds', skill: m[2].trim(), crit: false })
  }
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
  return null
}

/** The "has taken N damage" half of the damage battery: DoTs, with and without a caster. */
function takenDamage({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
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
  return null
}

/**
 * Damage: melee / spell / dot / damage-shield.
 * Gate on the shared damage substrings so non-combat lines skip the battery.
 * Both plural ("50 points of") and singular ("1 point of") forms count — the
 * old looksCombat pre-filter only checked "points of" and silently dropped
 * every 1-damage swing; the underlying regexes always handled `points?`.
 */
export function classifyDamage(c: ClassifyCtx): LogEvent | null {
  const { text } = c
  const hasPoints = text.includes('points of') || text.includes('point of')
  const hasTaken = text.includes('has taken')
  if (hasPoints) {
    const ev = pointsDamage(c)
    if (ev) return ev
  }
  if (hasTaken) {
    const ev = takenDamage(c)
    if (ev) return ev
  }
  return null
}

/** Heals (NEW). */
export function classifyHeal({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
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
        amount: Number(m[4]),
        rawAmount: m[5] ? Number(m[5]) : undefined,
        spell: m[6]?.trim() || undefined,
        healer,
        crit: /critical/i.test(m[7] ?? ''),
        ...(m[3] ? { overTime: true } : {})
      }
    }
  }
  return null
}
