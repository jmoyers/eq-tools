// SHARED FIXTURE SCRUB — the single gate every fixture extractor routes through.
//
// `tests/fixtures/*.log` are COMMITTED to a PUBLIC repo, so they must not carry any other
// player's words or identity. This module is the one place that decides what "third-party
// chat/social" means; `tests/extract-*.mjs` all call `scrubKeep()` and never re-implement it.
//
// LAW: a scrubbed line is DROPPED ENTIRELY. Never rewrite it with a placeholder — a rewritten
// line can still parse into a fake event and pollute the fixture (and therefore the golden
// expectation) with something the real log never said.
//
// Families enumerated by sweeping the real 1.02M-line log (never guessed):
//   1. QUOTED SPEECH — every chat channel in this game prints `<sender> <verb>, '<text>'`:
//      direct tells (`X tells you`, `You told X`), channel tells (`X tells General:1`,
//      `You tell NewPlayers6:1`), group (`X tells the group`, `You tell your party`), guild /
//      raid variants, `X says`, `X says out of character`, `X shouts`, `X auctions`, and the
//      `You say...` first-person forms. A whole-log sweep proved the ONLY non-chat lines that
//      contain `, '` are mob flavor growls, so "contains a quoted-speech comma-quote" is a
//      complete and safe test — we drop mob speech too rather than try to tell a named NPC
//      (Kahaptra Z`Taj, Innoruuk`s Chosen) apart from a player name. Nothing in the parser
//      consumes mob speech.
//   2. /who OUTPUT — the header, the dashed rules, `[ANONYMOUS] Name`,
//      `[<lvl> CLS/CLS] Name (Race) <Guild> ZONE: ...` rows (incl. the ` AFK ` and `* RIP *`
//      corpse variants) and the `There are N players...` footer. Every row names a stranger.
//   3. GROUP SOCIAL naming a third party — `X has joined/left the group.`,
//      `X invites you to join a group.`, `X is now the leader of your group.`
//   4. PLAYER EMOTES — social emotes with a proper-name subject (`Rykkerr waves at
//      Primitive.`). Mob emotes (`a Teir`Dal ranger yawns.`, `... sighs in tranquility.`) are
//      NOT social emotes and stay.
//   5. GUILD MOTD — defensive; this log has none, but a public fixture must never grow one.
//
// KEPT (the world model needs them): all combat (damage/miss/resist/heal/death), casts, buff
// landings + wear-offs, loot/currency/turn-ins, zone lines, level-ups, AA, charm/pet lines,
// stances, and system messages. The user's OWN character (Primitive) is theirs to publish, so
// their self `/who` row survives — it is the ONLY line in the log that states the class
// loadout and `extract-leveling-fixtures.mjs` depends on it.
//
// CARVE-OUT (deliberate, load-bearing): the pet-claim tell
//   `<Name> told you, 'Attacking <target> Master.'`
//   `<Name> told you, 'I am unable to wake <mob>, Master.'`
// IS a tell, but it is spoken by an NPC pet, not a person, and per AGENTS.md it is the ONLY
// binding signal for a summoned pet (random proper names: Vebarn, Garer...). 3050 of the 3403
// `told you` lines in the log are this family; the rest are merchant NPCs. Dropping it would
// silently unbind every pet in every combat fixture, so it is kept verbatim.

/** The owner-only pet-claim tell — an NPC pet's binding signal, NOT a person's words. */
export const PET_CLAIM_RE =
  /told you, '(?:Attacking .+ Master|I am unable to wake .+?, Master)\.'$/

/** The user's own character; their own identity may stay in their own repo. */
export const SELF_NAME = 'Primitive'

const SOCIAL_EMOTE_VERBS =
  'waves|bows|cheers|claps|nods|agrees|thanks|salutes|smiles|laughs|giggles|dances|hugs|kneels|points|cries|apologizes|greets|welcomes|congratulates|shrugs|winks|whistles|slaps|tickles|pokes|beckons'
const SELF_EMOTE_VERBS =
  'wave|bow|cheer|clap|nod|agree|thank|salute|smile|laugh|giggle|dance|hug|kneel|point|cry|apologize|greet|welcome|congratulate|shrug|wink|whistle|slap|tickle|poke|beckon'

/** Patterns applied to the line body (timestamp already stripped). */
const DROP = [
  // 1. quoted speech — every chat channel, plus mob speech (parser consumes none of it)
  /, '/,
  // 2. /who output
  /^Players (in|on) EverQuest Legends:$/,
  /^-{5,}\s*$/,
  /^\s*(?:\* RIP \*\s*)?(?:AFK\s+)?\[(?:ANONYMOUS|\d+ [A-Z]{3}(?:\/[A-Z]{3})*)\]/,
  /^There (?:are|is) (?:no|\d+) players? in EverQuest Legends/,
  // 3. group social naming a third party
  /^\S.* has (?:joined|left) the group\.$/,
  /^\S.* invites you to join a group\.$/,
  /^\S.* is now the leader of your group\.$/,
  // 4. player social emotes (proper-name or first-person subject)
  new RegExp(`^[A-Z][a-z'\`]+ (?:${SOCIAL_EMOTE_VERBS})\\b`),
  new RegExp(`^You (?:${SELF_EMOTE_VERBS}) at \\b`),
  // 5. guild MOTD (defensive — this log has none)
  /^(?:GUILD MOTD|Guild MOTD|Guild message of the day)/i
]

/** Strip the `[Day Mon DD HH:MM:SS YYYY] ` prefix, if present. */
function body(line) {
  const i = line.indexOf('] ')
  return i === -1 ? line : line.slice(i + 2)
}

/**
 * True when the line is third-party chat/social and must be dropped from a committed fixture.
 * The pet-claim carve-out and the user's own /who row are checked FIRST.
 */
export function isThirdPartyChat(line) {
  if (PET_CLAIM_RE.test(line)) return false
  const b = body(line)
  // the user's own /who row (`[50 PAL/MNK/ENC] Primitive (Dark Elf) ...`) is their own identity
  if (new RegExp(`^\\[\\d+ [A-Z]{3}(?:/[A-Z]{3})*\\] ${SELF_NAME}\\b`).test(b)) return false
  return DROP.some((re) => re.test(b))
}

/** Convenience inverse — `lines.filter(scrubKeep)`. */
export const scrubKeep = (line) => !isThirdPartyChat(line)
