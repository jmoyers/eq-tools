// Cast / buff / pet families of the parse cascade (see parser.ts for the ordered list):
// the cast lifecycle, charm + crowd control, targeted and targetless buff fades, pet
// ownership claims, stances + invocations, the illusion click-off, rogue poisons, the
// DB-gated message-driven buff events, and — matched LAST of all — spell-landing emotes.
// Every regex, table and comment here is verbatim from the single-pass parser.

import type { LogEvent } from '../../shared/logEvents'
import type { PoisonProcDef } from '../../shared/poisons'
import { POISON_BY_COAT_MSG, POISON_DRY_MSG, POISON_PROCS } from '../../shared/poisons'
import type { ParserConfig } from './rulesets'
import { idKey, norm, type ClassifyCtx } from './parseCommon'

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

// ----- rogue poisons (Task #64) -----
// Three families, all driven by the tables in shared/logEvents.ts (every string there is
// copied verbatim from the committed spell DB — see that file's block comment):
//
//   COAT   `You coat your blades in a neurotoxic poison.` and 19 siblings, matched by EXACT
//          EQUALITY against POISON_BY_COAT_MSG. Not a pattern: the prose is idiosyncratic
//          per poison ("a weak paralytic", "with a stunning agent", "in asp venom"), so a
//          regex over "in <name> poison" would both miss real coats and invent names.
//          Plus the two third-person shapes below.
//   DRY    `The poison dries from the blade.` / `The venom drips away.` — exact equality.
//   PROC   a Strike's landing emote, matched by SUFFIX (POISON_PROCS).
//
// PLACEMENT (deliberate, and MEASURED — this was probed against the real parser before it
// was written, not assumed):
//   - The PROC emotes and the third-person coats currently classify as 'unknown': the spell
//     DB's cast-on-other SUFFIX table does not carry them (it is built from the
//     "Someone …"/"Soandso …" message shapes, and these messages have neither prefix). So
//     this branch shadows nothing that exists today, and it OWNS them deliberately from now
//     on — a stable, DB-independent proc stream is what the golden tests and the engine's
//     time-to-slow measurement need.
//   - The FIRST-PERSON coat and dry lines DO match the DB today (buffApply /
//     buffWearOff). Claiming them here is still a no-op for the world model: replaying the
//     real coat window (2026-08-03 01:05–01:23) through the real BuffsModule produced ZERO
//     poison actives either way — a coat prints no `You begin casting` line, so own-cast
//     gating drops it, and the shared `dries` wears-off resolves against an active set that
//     never contains a poison. Owning them here buys a single, DB-free code path in the
//     engine instead of two.
// The whole family is gated on cheap probes so the hot path is untouched.

/** Third person, poison NAMED: `Pollux coats their blades in asp venom!` (Asp Venom's own
 *  msgCastOnOther). Ends in '!'. */
const POISON_COAT_OTHER_NAMED_RE = /^(.+?) coats their blades in (.+?)!$/
/** Third person, GENERIC: `Skandercoats their blades in poison.` — verbatim from the real
 *  log, MISSING SPACE included (both occurrences, 2026-07-31 and 2026-08-03). The optional
 *  `\s?` is what lets the lazy name capture stop at "Skander" instead of eating "Skandercoats". */
const POISON_COAT_OTHER_GENERIC_RE = /^(.+?)\s?coats their blades in poison\.$/

/**
 * Last WORD of every proc emote → the emotes that end with it. The gate is one
 * `lastIndexOf(' ')` + one Map lookup, so an ordinary log line costs nothing; the handful of
 * lines that clear it then run an exact `endsWith` against a 1–2 entry list. (A bare
 * `endsWith` loop over all ten suffixes would run for every unclassified line in the log.)
 */
const POISON_PROC_BY_LAST_WORD = ((): ReadonlyMap<string, PoisonProcDef[]> => {
  const m = new Map<string, PoisonProcDef[]>()
  for (const p of POISON_PROCS) {
    const w = p.suffix.slice(p.suffix.lastIndexOf(' ') + 1)
    const list = m.get(w)
    if (list) list.push(p)
    else m.set(w, [p])
  }
  return m
})()

/** Cast lifecycle (Task #19): begin / fizzle / interrupt (player's own casts). */
export function classifyCastLifecycle({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
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
  return null
}

/** Charm application — the first half of the charm lifecycle. */
export function classifyCharm({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.includes('has been charmed')) {
    const m = CHARM_RE.exec(text)
    if (m) return { kind: 'charm', seq, ts, raw, mob: norm(m[1]) }
  }
  return null
}

/**
 * "worn off" — uncharm / CC refresh / named-target fade, else the TARGETLESS self+pet fade.
 * The two shapes are an if/else pair exactly as in the original cascade.
 */
export function classifyWornOff({ text, ts, seq, raw, cfg }: ClassifyCtx): LogEvent | null {
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
  return null
}

/** Crowd-control application (mez/root, not charm). */
export function classifyCcApply({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.includes('has been ')) {
    const m = CC_APPLY_RE.exec(text)
    if (m) return { kind: 'cc', seq, ts, raw, mob: norm(m[1]) }
  }
  return null
}

/** Pet-ownership claim (direct tell ⇒ the named entity is your pet). */
export function classifyPetClaim({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.includes(" told you, '")) {
    const m = PET_CLAIM_RE.exec(text)
    if (m) return { kind: 'petClaim', seq, ts, raw, name: norm(m[1]) }
  }
  return null
}

/** Activated AA (Task #34): "You activate <X>." (e.g. Quick Buff). */
export function classifyAaActivate({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.startsWith('You activate ')) {
    const m = AA_ACTIVATE_RE.exec(text)
    if (m) return { kind: 'aaActivate', seq, ts, raw, name: m[1].trim() }
  }
  return null
}

/** Combat stance + invocation changes (Task #51). */
export function classifyStance({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
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
  return null
}

/**
 * Illusion click-off (Task #36): "Your illusion fades."
 * The shared removal line for EVERY illusion-flagged spell (Illusion: <race>, Boon of
 * the Garou, …) — the DB lists it as msg_wears_off for 27 distinct spells, so it can't
 * name which illusion faded. It doesn't need to: only ONE illusion is active at a time
 * (the user's rule), so this removes whichever illusion self buff is active. Emitted
 * HERE, before the DB buffWearOff table below, so the 27-way-ambiguous wears-off match
 * never fires for this exact line (which would remove an arbitrary first candidate).
 * NOT DB-gated — the text is unambiguous on its own.
 */
export function classifyIllusionFade({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text === 'Your illusion fades.') {
    return { kind: 'illusionFade', seq, ts, raw, target: 'self' }
  }
  return null
}

/** Rogue poisons (Task #64), coat half: first- and third-person. See the tables above. */
export function classifyPoisonCoat({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.startsWith('You coat your blades ')) {
    const p = POISON_BY_COAT_MSG.get(text)
    // An unknown coat line is still a coat — we say so and decline to name the poison
    // (law 1) rather than dropping the only evidence that the blades were re-coated.
    if (text.endsWith('.')) {
      return p
        ? { kind: 'poisonCoat', seq, ts, raw, poison: p.name, group: p.group, who: 'you' }
        : { kind: 'poisonCoat', seq, ts, raw, poison: 'unknown', group: 'unknown', who: 'you' }
    }
  }
  if (text.includes('coats their blades in ')) {
    // Named third person (`… in asp venom!`): the descriptor is the same noun phrase the
    // first-person line uses, so we resolve it through the SAME table instead of keeping a
    // second one. Unresolvable ⇒ 'unknown', never a guessed name.
    let m = POISON_COAT_OTHER_NAMED_RE.exec(text)
    if (m) {
      const p = POISON_BY_COAT_MSG.get(`You coat your blades in ${m[2].trim()}.`)
      return {
        kind: 'poisonCoat', seq, ts, raw,
        poison: p?.name ?? 'unknown', group: p?.group ?? 'unknown', who: norm(m[1])
      }
    }
    // Generic third person (`Skandercoats their blades in poison.`) — the game deliberately
    // hides which poison, so there is nothing to resolve.
    m = POISON_COAT_OTHER_GENERIC_RE.exec(text)
    if (m) return { kind: 'poisonCoat', seq, ts, raw, poison: 'unknown', group: 'unknown', who: norm(m[1]) }
  }
  return null
}

/** The proc emote's target (the text before the suffix), or null when this proc doesn't match. */
function poisonProcTarget(text: string, p: PoisonProcDef): string | null {
  // Possessive suffixes attach straight to the name; bare ones follow a space —
  // the same two-shape rule the DB's own cast-on-other matcher uses.
  const tail = p.suffix.startsWith("'s") ? p.suffix : ` ${p.suffix}`
  if (!text.endsWith(tail) || text.length <= tail.length) return null
  return text.slice(0, text.length - tail.length).trim() || null
}

/** Rogue poisons (Task #64), dry + Strike-proc half. */
export function classifyPoisonProc({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  const group = POISON_DRY_MSG[text]
  if (group) return { kind: 'poisonDry', seq, ts, raw, group }
  if (text.endsWith('!') || text.endsWith('.')) {
    const cands = POISON_PROC_BY_LAST_WORD.get(text.slice(text.lastIndexOf(' ') + 1))
    for (const p of cands ?? []) {
      const target = poisonProcTarget(text, p)
      if (target) {
        return {
          kind: 'poisonProc', seq, ts, raw,
          strike: p.strikes[0], candidates: [...p.strikes], effect: p.effect, target: norm(target)
        }
      }
    }
  }
  return null
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
  { ts, seq, raw }: ClassifyCtx,
  target: string,
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

/**
 * Message-driven buff events (Task #34) — DB-gated, additive. Emitted only when a
 * spell database is installed on the config (installSpellDb); with no DB these never
 * fire so parser purity holds and existing tests/profiles are byte-for-byte unchanged.
 * These matches take precedence over the permissive spellEmote candidate below: a line
 * that EXACTLY matches a DB message names the exact spell, which is strictly more
 * informative than an emote candidate. Unmatched emote-shaped lines still fall through
 * to spellEmote, so Task #33's cast-target learning is untouched for non-DB spells.
 */
export function classifyDbBuff(c: ClassifyCtx): LogEvent | null {
  const { text, ts, seq, raw } = c
  const db = c.cfg.spellDb
  if (!db) return null
  // Self landing: msg_cast_on_you match → buffApply { self }. (Covers the Quick Buff
  // burst, whose landing messages have no "You begin casting" line.) A message may map to
  // several candidate spells (shared haste/clarity messages); we carry them all so the
  // buffs module resolves via the player's cast history.
  const selfCands = db.castOnYou.get(text)
  if (selfCands?.length) return buffApplyEvent(c, 'self', selfCands)
  // Buff fade: msg_wears_off match → buffWearOff { self }. Message-driven expiry is
  // favored over estimate-based removal (the user directive). MANY spells share a
  // wears-off message ("Your speed returns to normal." = 9 haste spells, "Your strength
  // fades." = 13, …), so we carry the FULL candidate list (Task #45): the buffs module
  // resolves against the player's ACTIVE self buffs (EQ stacking ⇒ one candidate active at
  // a time). Removing by only the first candidate MISSED the actually-active buff.
  const wornCands = db.wearsOff.get(text)
  if (wornCands?.length) {
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
  if (other) return buffApplyEvent(c, other.target, other.cands)
  return null
}

/**
 * Spell-landing emotes (Task #33) — matched LAST so it never shadows a real
 * family. A candidate emote the buffs module uses to discriminate cast targets.
 */
export function classifySpellEmote({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.startsWith('You ')) {
    // Exclude upkeep/state spam that shares the "You <verb> …" shape but is never a
    // spell-landing emote (hunger/thirst/state-off). "You feel/look/sense/seem …" only.
    if (EMOTE_SELF_RE.test(text)) return { kind: 'spellEmote', seq, ts, raw, subject: 'self', text }
  } else {
    const m = EMOTE_PET_RE.exec(text)
    // Never treat "You"/"Your" as a pet subject (self form handled above).
    if (m && idKey(m[1]) !== 'you') return { kind: 'spellEmote', seq, ts, raw, subject: norm(m[1]), text }
  }
  return null
}
