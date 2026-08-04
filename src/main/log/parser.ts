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
//
// FACTORING: the line-shape cascade is split across four sibling modules by family
// (parseCombat / parseCasts / parseWorld, over parseCommon's shared context+names).
// The CASCADE ORDER below is SEMANTIC, not cosmetic — several families overlap on
// purpose and are disambiguated by which one is offered the line first (the resist
// family tests YOUR form before the named-caster form because 712 spell names
// contain `'s`; the spell-landing emote is matched LAST so it can never shadow a
// real family; item merges come after loot so an auto-merge-on-pickup stays one
// 'combined' loot event). NEVER reorder CLASSIFIERS.

import { DEFAULT_PROFILE } from '../../shared/profiles'
import type { LogEvent } from '../../shared/logEvents'
import { getParserConfig } from './rulesets'
import type { ClassifyCtx, Classifier } from './parseCommon'
import { classifyDamage, classifyHeal, classifyMiss, classifyMitigation, classifyResist } from './parseCombat'
import {
  classifyAaActivate,
  classifyCastLifecycle,
  classifyCcApply,
  classifyCharm,
  classifyDbBuff,
  classifyIllusionFade,
  classifyPetClaim,
  classifyPoisonCoat,
  classifyPoisonProc,
  classifySpellEmote,
  classifyStance,
  classifyWornOff
} from './parseCasts'
import { classifyItemActivate, classifySelfWho, classifySkillUp } from './parseWho'
import { classifyCamp, classifySessionStart } from './parseSession'
import {
  classifyAa,
  classifyConsider,
  classifyDeath,
  classifyExp,
  classifyItemMerge,
  classifyLevel,
  classifyLoot,
  classifyTurnIn,
  classifyZone
} from './parseWorld'

export { idKey, looksDamage, spellCanonKey } from './parseCommon'
export { TIER_LABELS, zoneTier } from './parseWorld'

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

// ----- the single pass -----

/**
 * The ordered line-shape cascade. Each entry is offered the line and either claims it
 * (returns its event) or declines (null). ORDER IS SEMANTIC — see the module header.
 * Ordering is cheap-discriminator-first: each family is gated by a substring probe on
 * the message text so the regex battery only runs for candidate lines. The huge
 * miss/avoid family is checked first (via a single `, but ` probe) and short-circuits,
 * since it dominates a real combat log by an order of magnitude.
 */
const CLASSIFIERS: readonly Classifier[] = [
  classifyMiss,
  classifyMitigation,
  classifyResist,
  classifyDamage,
  classifyHeal,
  classifyConsider,
  classifyCastLifecycle,
  classifyCharm,
  classifyWornOff,
  classifyCcApply,
  classifyPetClaim,
  classifyDeath,
  classifyZone,
  // SESSION frame (login / camp-out / camp-abort). Beside the zone rule because they answer
  // the same question one level up — zone says WHERE you are, these say WHETHER you are in
  // the world at all — and because a Welcome is always followed within 0–1 lines by a zone
  // line, so reading the pair adjacently is how the log itself reads. All three are EXACT
  // string matches on lines that were measured to be `{kind:'unknown'}` before they existed
  // (41 lines total), so they can neither shadow nor be shadowed by any other family; the
  // position is for legibility, not disambiguation.
  classifySessionStart,
  classifyCamp,
  classifyLoot,
  classifyItemMerge,
  classifyTurnIn,
  classifyLevel,
  // Experience: gated on a `You gain ` prefix and END-anchored, so it can only ever claim the
  // four exp shapes — all of which produced `{kind:'unknown'}` before this entry existed. It
  // sits after classifyLevel because a ding prints the level line first and the exp line
  // second; neither can shadow the other, and this keeps the progression families adjacent.
  classifyExp,
  classifyAa,
  classifyAaActivate,
  classifyStance,
  // CLASS EVIDENCE (class-combo inference Wave 1). Both are gated on a substring probe and
  // both were MEASURED to claim only lines that previously produced `{kind:'unknown'}` (all
  // 421 /who rows, all 10,216 skill-ups). They sit beside the stance/invocation rule because
  // that is the same evidence family — what the character can DO tells you what it IS — and
  // ahead of the DB-driven buff matchers, which no /who or skill-up line can reach anyway.
  classifySelfWho,
  classifySkillUp,
  classifyIllusionFade,
  classifyPoisonCoat,
  classifyPoisonProc,
  classifyDbBuff,
  // ITEM ACTIVATION (class-combo inference Wave 3) — `Your <item> shimmers briefly.` It sits
  // here, immediately before the permissive landing-emote matcher, for two reasons: the buff
  // fade / worn-off families own the other `Your …` shapes and are matched far earlier, and
  // the emote matcher WOULD otherwise claim 172 of these lines as a subject-"Your Idol of the
  // Underking" candidate (measured; the other 7,749 were `unknown`). Moving them here was
  // proven inert against a full-log BuffsModule replay.
  classifyItemActivate,
  classifySpellEmote
]

/**
 * Parse one raw log line into a canonical LogEvent, or null if it isn't a
 * timestamped log line. `seq` is stamped onto the event by the feeder.
 */
export function parseEvent(raw: string, seq: number, profileId: string = DEFAULT_PROFILE): LogEvent | null {
  const pm = LINE_RE.exec(raw)
  if (!pm) return null
  const ts = parseEqTimestamp(pm[1])
  const text = pm[2]
  const cfg = getParserConfig(profileId)
  return classify({ text, ts, seq, raw, cfg })
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

function classify(c: ClassifyCtx): LogEvent {
  for (const match of CLASSIFIERS) {
    const ev = match(c)
    if (ev) return ev
  }
  return { kind: 'unknown', seq: c.seq, ts: c.ts, raw: c.raw }
}
