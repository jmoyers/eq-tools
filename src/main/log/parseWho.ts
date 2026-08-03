// CLASS-EVIDENCE families of the parse cascade (see parser.ts for the ordered list):
// the character's own `/who` row and the skill-up tick. Wave 1 of
// docs/plans/class-combo-inference.md — the two lines the combo model needs that nothing
// else on the bus can supply.
//
// Why its own module rather than a branch of parseCasts/parseWorld: neither line is a cast
// and neither is progression state. A `/who` row is a STATEMENT ABOUT THE CHARACTER (the
// only one the game ever prints — EQ Legends runs up to three classes at once and never
// logs a loadout swap), and a skill-up is the only signal that can see the four classes with
// no spell list at all. Keeping them together keeps the self-name guard — the thing that
// separates the player's row from the 410 strangers' rows in the same grammar — in one place.
//
// NEITHER RULE CLAIMS A LINE ANY OTHER FAMILY WANTS. Measured, not assumed: a full-log
// replay through the pre-change parser (spell DB installed, exactly as pipeline.ts wires it)
// classified all 421 `/who` rows and all 10,216 skill-up lines as `{kind:'unknown'}`.

import type { LogEvent } from '../../shared/logEvents'
import type { ClassifyCtx } from './parseCommon'

/**
 * A `/who` row, self or stranger — the NAME is what tells them apart, so the shape is matched
 * first and the name checked after (see classifySelfWho).
 *
 *   [50 PAL/MNK/ENC] Primitive (Dark Elf)  ZONE: East Freeport (freporte)··
 *
 * Every group is anchored on punctuation the row always prints, so a mob name or a chat line
 * can never drift into it:
 *   `^\s*`              — the ` AFK ` variant leaves one leading space after the timestamp.
 *   `(?:\* RIP \*\s*)?` — the corpse variant, which prints `* RIP *` flush against the `[`.
 *   `(?:AFK\s+)?`       — the away marker.
 *   `\[(\d+) (CODES)\]` — the level + the slash-joined three-letter class codes. `[ANONYMOUS]`
 *                         states no classes and deliberately does NOT match.
 *   `(.+?)`             — the character name (a corpse row appends `'s corpse`).
 *   `(?: \(([^)]*)\))?` — the race. Optional: it is an ILLUSION-driven field, never combo
 *                         evidence, so a row without it must still parse.
 *   `(?: <([^>]*)>)?`   — the guild tag. Captured only so it can't be eaten by the name.
 *   `\s+ZONE: (.+?)\s*$`— all 421 rows in the real log carry a ZONE clause.
 */
const WHO_ROW_RE =
  /^\s*(?:\* RIP \*\s*)?(?:AFK\s+)?\[(\d+) ([A-Z]{3}(?:\/[A-Z]{3})*)\] (.+?)(?: \(([^)]*)\))?(?: <([^>]*)>)?\s+ZONE: (.+?)\s*$/

/**
 * The `/who` ZONE clause repeats the zone as `<Display Name> (<shortname>)` — "East Freeport
 * (freporte)", "The City of Guk 15 (guktop_15)". The short id is the same fact in the game's
 * internal spelling, so the event carries the DISPLAY name (the vocabulary every `zone` event
 * already uses) and drops the parenthesized twin. Rows that print only the raw short name
 * ("ZONE: befallen_78") have no parens and pass through verbatim — never invent a display
 * name we were not given.
 */
const WHO_ZONE_SHORTNAME_RE = /\s*\([a-z0-9_]+\)$/

/** A corpse row names `<Name>'s corpse`; the character it describes is still `<Name>`. */
const CORPSE_SUFFIX_RE = /['`’]s corpse$/

/** `You have become better at Flying Kick! (48)` — the trailing value is optional (see below). */
const SKILL_UP_RE = /^You have become better at (.+?)!(?: \((\d+)\))?$/

/**
 * The character's OWN `/who` row — the only authoritative statement of the class loadout.
 *
 * The self-name check is the WHOLE guard. A `/who` prints every player in the zone in exactly
 * this grammar (410 of the 421 rows in the real log are strangers), so without a name to key
 * on this rule would hand somebody else's classes to the player. The name comes from
 * ParserConfig (session.ts injects the tailed character), never from a constant: the hardcoded
 * `SELF_NAME` in tests/fixture-scrub.mjs is an extraction-time convenience and has no business
 * in the runtime parser. With no character installed the rule declines every line.
 *
 * Compared case-insensitively for the same reason every other name in this parser is
 * (world-model law 2), and after stripping a corpse row's `'s corpse` suffix — a dead
 * character's row still states the loadout.
 */
export function classifySelfWho({ text, ts, seq, raw, cfg }: ClassifyCtx): LogEvent | null {
  const self = cfg.characterName
  if (!self || !text.includes('ZONE: ')) return null
  const m = WHO_ROW_RE.exec(text)
  if (!m) return null
  const name = m[3].trim().replace(CORPSE_SUFFIX_RE, '')
  if (name.toLowerCase() !== self.trim().toLowerCase()) return null
  const ev: LogEvent & { kind: 'selfWho' } = {
    kind: 'selfWho',
    seq,
    ts,
    raw,
    level: Number(m[1]),
    classes: m[2].split('/')
  }
  const race = m[4] === undefined ? '' : m[4].trim()
  if (race) ev.race = race
  const zone = m[6].replace(WHO_ZONE_SHORTNAME_RE, '').trim()
  if (zone) ev.zone = zone
  return ev
}

/**
 * Skill ticks — `You have become better at <Skill>! (<n>)`.
 *
 * The skill string is kept EXACTLY as the client prints it. The wiki (and therefore the
 * scraped class table's source) spells several of them differently — "1 Hand Slashing" vs the
 * client's "1H Slashing", "Channelling" vs "Channeling", "String" vs "Stringed Instruments" —
 * and classes.json's `skills` table is keyed by the CLIENT name with the aliasing already
 * resolved. Translating here would put the alias in two places and let them drift.
 *
 * The trailing `(n)` is present on all 10,216 lines in the real log; the group is optional so
 * a value-less variant still yields a skill (the skill NAME is the class evidence — the value
 * is a bonus), and `value` is omitted rather than 0 when the line printed none (law 1).
 */
export function classifySkillUp({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (!text.startsWith('You have become better at ')) return null
  const m = SKILL_UP_RE.exec(text)
  if (!m) return null
  const skill = m[1].trim()
  return m[2] === undefined
    ? { kind: 'skillUp', seq, ts, raw, skill }
    : { kind: 'skillUp', seq, ts, raw, skill, value: Number(m[2]) }
}
