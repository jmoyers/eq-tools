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
const LOOT_RE = /^--You have looted (?:an? )?(.+?)(?: from (.+?) corpse)?\.--$/
// Dashless fallback for servers/cases that omit the surrounding dashes.
const LOOT_RE_PLAIN = /^You have looted (?:an? )?(.+?)(?: from (.+?) corpse)?\.$/

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

// ----- heal (NEW): "<healer> healed <target> for N hit points[ by <spell>]." -----
// Two shapes in the real log:
//   "<healer> healed <target> for 120 hit points by <Spell>."         (amount only)
//   "<healer> healed <target> for 85 (107) hit points by <Spell>."    (actual first,
//     raw/overheal amount in parens — ~2.7k lines the old amount-only regex missed).
// `amount` is always the FIRST number (effective heal); the parenthesized raw amount
// is captured separately as `rawAmount`. Singular "hit point" is tolerated too.
const HEAL_RE = /^(.+?) healed (.+?) for (\d+)(?: \((\d+)\))? hit points?(?: by (.+?))?\.$/

// ----- miss (NEW): "<A> tr(y|ies) to <verb> <B>, but <outcome>!" -----
// Outcome disambiguates the miss type:
//   miss!/misses!                        → 'miss' (self uses base, 3rd person -es)
//   <defender> parries/dodges/ripostes/blocks!   → defender-named, 3rd person verb
//   YOU parry/dodge/riposte/block!               → defender = you, base verb
//   <name>'s magical skin absorbs the blow!      → 'absorb'
// An optional trailing swing modifier " (Riposte)"/"(Flurry)"/"(Rampage)" may
// follow the "!" — allowed and discarded.
const MISS_RE = new RegExp(
  '^(.+?) tr(?:y|ies) to \\w+ (.+?), but ' +
    '(?:(miss|misses)' + // 3: plain miss (self/3rd person)
    '|(.+?) (parries|dodges|ripostes|blocks)' + // 4:defender 5:3rd-person verb
    '|(YOU) (parry|dodge|riposte|block)' + // 6:YOU 7:base verb
    "|.+?'s magical skin (absorbs) the blow)" + // 8: absorb
    '!(?: \\([A-Za-z]+\\))?$'
)

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
      //         6=YOU 7=base-verb 8=absorbs
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
      } else {
        mtype = 'absorb'
        target = norm(m[2])
      }
      return { kind: 'miss', seq, ts, raw, attacker, target, mtype }
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
        return {
          kind: 'damage', seq, ts, raw,
          attacker: norm(m[1]), target: norm(m[2]), amount: Number(m[3]),
          dtype: 'spell', dclass: m[4], skill: m[5].trim(),
          crit: /critical/i.test(modifier ?? ''), modifier
        }
      }
      // Melee.
      m = MELEE_RE.exec(text)
      if (m) {
        const verbM = MELEE_VERB_RE.exec(text)
        const modifier = m[4]
        return {
          kind: 'damage', seq, ts, raw,
          attacker: norm(m[1]), target: norm(m[2]), amount: Number(m[3]),
          dtype: 'melee', skill: meleeSkill(verbM ? verbM[1] : 'hit'),
          crit: /critical/i.test(modifier ?? ''), modifier
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
          return { kind: 'damage', seq, ts, raw, attacker, target, amount, dtype: 'dot', skill: skill.trim(), crit, modifier: m[4] }
        }
      }
      // Caster-less DoT: "<B> has taken N damage by <Spell>." → attacker:null.
      m = DOT_NOCASTER_RE.exec(text)
      if (m) {
        const crit = /critical/i.test(m[4] ?? '')
        return { kind: 'damage', seq, ts, raw, attacker: null, target: norm(m[1]), amount: Number(m[2]), dtype: 'dot', skill: m[3].trim(), crit, modifier: m[4] }
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
        healer
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
      // Anything else (buffs/debuffs/pacify) is not lifecycle and falls through.
      if (cfg.charmSpell.test(m[1])) return { kind: 'uncharm', seq, ts, raw, mob: norm(m[2]) }
      if (cfg.ccSpell.test(m[1])) return { kind: 'cc', seq, ts, raw, mob: norm(m[2]), spell: m[1].trim(), refresh: true }
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
    if (m) return { kind: 'loot', seq, ts, raw, item: m[1].trim(), source: cleanMob(m[2]) }
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

  return { kind: 'unknown', seq, ts, raw }
}

function dmg(
  seq: number, ts: number, raw: string,
  attacker: string | null, target: string, amount: number,
  dtype: DamageType, skill: string, crit: boolean
): LogEvent {
  return { kind: 'damage', seq, ts, raw, attacker, target, amount, dtype, skill, crit }
}
