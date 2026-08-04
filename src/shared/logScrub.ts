// ============================================================================
// SHARED LOG SCRUB — the ONE definition of "third-party chat/social".
// ============================================================================
//
// PROMOTED from `tests/fixture-scrub.mjs` (which is now a thin shim over this module) so that
// the SAME drop list governs two things that must never disagree:
//
//   1. `tests/fixtures/*.log` — committed to a PUBLIC repo by `tests/extract-*.mjs`.
//   2. the log slice a user attaches to an in-app feedback report (src/main/feedback/slice.ts).
//
// Re-implementing a second drop list for the app was FORBIDDEN by AGENTS.md ("never
// re-implement a drop list"), and rightly: two lists diverge, and the divergence ships as
// someone else's words in a public artifact.
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
// stances, and system messages.
//
// TWO CARVE-OUTS, both load-bearing, both checked BEFORE the drop list:
//
//   * THE PET-CLAIM TELL —
//       `<Name> told you, 'Attacking <target> Master.'`
//       `<Name> told you, 'I am unable to wake <mob>, Master.'`
//     IS a tell, but it is spoken by an NPC pet, not a person, and per AGENTS.md it is the
//     ONLY binding signal for a summoned pet (random proper names: Vebarn, Garer...). 3050 of
//     the 3403 `told you` lines in the log are this family; the rest are merchant NPCs.
//     Dropping it would silently unbind every pet in every combat fixture, so it is kept
//     verbatim. It has NO self-name dependency: a pet's name is not the user's.
//
//   * THE SELF `/who` ROW — `opts.selfName`. The owner's own identity is theirs to publish,
//     and their row is the ONLY line in the log that states the class loadout
//     (`extract-leveling-fixtures.mjs` and the class-combo model's single Tier-A observation
//     depend on it). PARAMETERIZED, not a constant: for a fixture self is 'Primitive'; for a
//     user's feedback report self is THEIR active character. Absent ⇒ no self carve-out at
//     all, which is the safe default — every /who row then falls to the drop list.
//
// This module is PURE: zero imports, no `node:`, no Electron, no DOM. It compiles under both
// tsconfigs and is safe to call 50,000 times in a row on a slice.

/** The owner-only pet-claim tell — an NPC pet's binding signal, NOT a person's words. */
export const PET_CLAIM_RE =
  /told you, '(?:Attacking .+ Master|I am unable to wake .+?, Master)\.'$/

export interface ScrubOpts {
  /** The character whose own `/who` row survives. Fixtures: 'Primitive'. A user's report:
   *  their active character name. Absent ⇒ no self carve-out. */
  readonly selfName?: string
}

const SOCIAL_EMOTE_VERBS =
  'waves|bows|cheers|claps|nods|agrees|thanks|salutes|smiles|laughs|giggles|dances|hugs|kneels|points|cries|apologizes|greets|welcomes|congratulates|shrugs|winks|whistles|slaps|tickles|pokes|beckons'
const SELF_EMOTE_VERBS =
  'wave|bow|cheer|clap|nod|agree|thank|salute|smile|laugh|giggle|dance|hug|kneel|point|cry|apologize|greet|welcome|congratulate|shrug|wink|whistle|slap|tickle|poke|beckon'

/** Patterns applied to the line body (timestamp already stripped). */
const DROP: readonly RegExp[] = [
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
  /^(?:GUILD MOTD|Guild MOTD|Guild message of the day)/i,
]

/** Strip the `[Day Mon DD HH:MM:SS YYYY] ` prefix, if present. */
function body(line: string): string {
  const i = line.indexOf('] ')
  return i === -1 ? line : line.slice(i + 2)
}

/** Regex metacharacters in a name are literal text (EQ names carry backticks and apostrophes;
 *  a `.` in a name must not become "any character"). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The self `/who` row matcher for one character name.
 *
 * The optional `* RIP *` / ` AFK ` prefixes mirror what the RUNTIME rule accepts
 * (src/main/log/parseWho.ts): this character has printed neither yet, but a scrub that drops a
 * row the parser would have claimed silently deletes evidence from a future fixture. The
 * trailing `\b` already covers the corpse row's `<Name>'s corpse`. The NAME is the whole
 * guard — every stranger's row falls through to the /who DROP rule.
 */
function selfWhoRe(selfName: string): RegExp {
  return new RegExp(
    `^\\s*(?:\\* RIP \\*\\s*)?(?:AFK\\s+)?\\[\\d+ [A-Z]{3}(?:/[A-Z]{3})*\\] ${escapeRe(selfName)}\\b`,
  )
}

/** One compiled regex per character name — this runs per line over a 50k-line slice. */
const selfWhoCache = new Map<string, RegExp>()
function cachedSelfWhoRe(selfName: string): RegExp {
  let re = selfWhoCache.get(selfName)
  if (!re) {
    re = selfWhoRe(selfName)
    selfWhoCache.set(selfName, re)
  }
  return re
}

/**
 * True when the line is third-party chat/social and must be DROPPED from a public artifact.
 * The pet-claim carve-out and the owner's own `/who` row are checked FIRST.
 */
export function isThirdPartyChat(line: string, opts?: ScrubOpts): boolean {
  if (PET_CLAIM_RE.test(line)) return false
  const b = body(line)
  const selfName = opts?.selfName
  // the owner's own /who row (`[50 PAL/MNK/ENC] Primitive (Dark Elf) ...`) is their identity
  if (selfName !== undefined && selfName !== '' && cachedSelfWhoRe(selfName).test(b))
    return false
  return DROP.some((re) => re.test(b))
}

/** Convenience inverse — `lines.filter((l) => scrubKeep(l, opts))`. */
export function scrubKeep(line: string, opts?: ScrubOpts): boolean {
  return !isThirdPartyChat(line, opts)
}

/**
 * One pass over a slice: the kept lines plus how many were dropped.
 *
 * `dropped` is what makes the feedback dialog's preview honest by construction — the user is
 * told the exact number of lines removed, not a claim that "chat was removed".
 */
export function scrubLines(
  lines: readonly string[],
  opts?: ScrubOpts,
): { kept: string[]; dropped: number } {
  const kept: string[] = []
  let dropped = 0
  for (const line of lines) {
    if (isThirdPartyChat(line, opts)) dropped++
    else kept.push(line)
  }
  return { kept, dropped }
}
