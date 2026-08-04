// The ROGUE POISON catalog (Task #64) — the tables the parser matches against and the
// classification the UI groups by. Split out of logEvents.ts because it is DATA, not the
// event stream's shape: the event interfaces (PoisonCoatEvent / PoisonDryEvent /
// PoisonProcEvent) stay there beside every other LogEvent variant and import from here.
//
// ---------------------------------------------------------------------------
// EQ Legends rogues coat their blades with poisons; each coat grants a chance for a named
// "<X> Strike" to fire on a melee swing. The Strike is what the fight actually feels — a
// slow, a stun, a mana drain — and it prints a landing EMOTE, never a cast line.
//
// TWO SOURCES, both authoritative, neither guessed:
//   1. `src/main/data/spells.json` (the committed eqlwiki `Template:Spellpage` scrape) —
//      it ALREADY carries every poison and every Strike with their exact
//      msgCastOnYou / msgCastOnOther / msgWearsOff strings. Those strings are copied
//      verbatim into the tables below, which is why no message here was invented.
//   2. https://eqlwiki.com/Rogue — the only place that states the two MECHANICS the
//      messages cannot: (a) COMBAT poisons STACK with each other while only ONE UTILITY
//      poison is active at a time, and (b) which effect each poison's Strike applies.
//
// (a) is not cosmetic — it is the whole reason the user's log shows Asp Venom Strike,
// Blood Siphon Strike AND a Weakening-Strike slow all firing at 01:2x on 2026-08-03 while
// the last coat line was Neurotoxic: three combat venoms (asp / siphoning / stunning, coated
// 01:05:10–01:05:36) were still up alongside the utility Neurotoxic (01:16:29). A
// single-slot "current poison" model would have had to call four of those five procs
// impossible. Hence `PoisonGroup` and the engine's slot state.
//
// FOUR COATS, AND WHY IT IS FOUR (the owner's "3 combat + 1 utility", verified 2026-08-04).
// The cap is NOT an arbitrary slot count the game enforces — it falls out of the roster, and
// the per-spell wiki pages say so in their own words:
//   * Cobra Venom       — "stacks with all other combat poisons, excluding Asp Venom, which
//                          this replaces."
//   * Blood Draw Venom  — "stacks with all other combat poisons, except Blood Siphon Venom,
//                          which this ability replaces."
//   * Stunning Venom    — "stacks with all other combat poisons." (no exception at all)
// So the five combat venoms form exactly THREE mutually-exclusive LINES — asp, blood,
// stunning — and at most one member of each can be on the blades. Three combat + the one
// utility slot = four concurrent coats, at any level. `PoisonDef.line` is that grouping, and
// it is what the engine keys its combat stack on; keying on the NAME (the pre-2026-08-04
// model) would have let Cobra sit beside Asp for a fourth simultaneous venom.
//
// WHAT THE PLAYER'S LOG CANNOT SHOW (say it rather than claim the observation): this
// character is level 45 and both upgrade venoms are level 46, so the log has never carried a
// Cobra or Blood Draw coat line. Every observed venom burst is exactly asp + siphoning +
// stunning — consistent with the model, but the CONFIRMATION is the wiki's replacement
// wording, not the log's three-at-a-time.
//
// TWO MORE LINES THE LOG PRINTS AROUND A COAT, neither of which this file matches (they are
// recorded here so nobody later mistakes them for coat evidence):
//   `You activate Neurotoxic Poison.`   — the ITEM/ability activation, 2–3s before the coat
//                                         line. It names the poison outright, but it fires
//                                         even when the coat then FAILS, so it is not a coat.
//   `Your Antimagic Poison spell did not take hold. (Blocked by Neurotoxic Poison.)`
//                                       — the coat FAILED. Three in the log (Antimagic ×2,
//                                         Paralytic ×1, all blocked by the utility poison
//                                         already on), and each is followed by NO coat line,
//                                         so the model correctly records nothing. This is
//                                         also the log's own proof that the utility slot is
//                                         exclusive: two utility poisons cannot coexist.
//
// WHAT THE LOG CANNOT SAY (law 6): a Strike emote names no caster. `<mob>'s limbs move
// slower!` is Weakening Strike's landing message and nothing else's (verified: exactly one
// spell in the DB carries it), but FOUR poisons grant Weakening Strike — Weakening,
// Binding, Neurotoxic and Paralytic — so a slow landing proves "a rogue slow proc", never
// "your Neurotoxic". The engine attributes it to your coat only when one of those four was
// active, and says so.
// ---------------------------------------------------------------------------

/**
 * How a poison behaves while coated. COMBAT venoms stack with each other (several can be
 * active at once); UTILITY poisons occupy a single slot and replace one another. Straight
 * from the Rogue page's own two lists — never inferred from the log.
 */
export type PoisonGroup = 'combat' | 'utility'

/**
 * What a poison Strike DOES, as the wiki's Rogue page classifies it. Deliberately coarse:
 * these are the buckets the UI groups procs into, not a simulation of the spell's slots.
 */
export type PoisonEffect =
  | 'slow' // melee/attack slow (Weakening Strike)
  | 'spellSlow' // casting slow (Clumsiness Strike)
  | 'manaDrain' // Befuddling Strike
  | 'dispel' // Banishing Strike
  | 'stun' // Stunning Strike
  | 'interrupt' // Concussive Strike
  | 'root' // Grounding Strike
  | 'snare' // Hobbling Strike
  | 'dot' // Blood Siphon / Blood Draw Strike (a real duration DoT)
  | 'damage' // Asp Venom / Cobra Venom Strike (instant direct damage)

/** Human label for an effect class (one spelling, shared by every surface). */
export const POISON_EFFECT_LABEL: Record<PoisonEffect, string> = {
  slow: 'slow',
  spellSlow: 'spell slow',
  manaDrain: 'mana drain',
  dispel: 'dispel',
  stun: 'stun',
  interrupt: 'interrupt',
  root: 'root',
  snare: 'snare',
  dot: 'DoT',
  damage: 'damage'
}

/** One coatable poison. `coatMsg` is the spell DB's msgCastOnYou, verbatim. */
export interface PoisonDef {
  /** DB spell name — the display name and the catalog key. */
  name: string
  group: PoisonGroup
  /** The exact `You coat your blades …` line this poison prints (DB msgCastOnYou). */
  coatMsg: string
  /** Rogue level from the wiki's roster; absent where the roster doesn't state one. */
  level?: number
  /** Strike names this poison grants (wiki Rogue page). Drives `slowCapable` below. */
  strikes: string[]
  /**
   * COMBAT venoms only: the mutually-exclusive LINE this venom belongs to (see the header).
   * Two venoms sharing a line replace one another; venoms on different lines stack. Utility
   * poisons leave it undefined — they already share ONE slot, so a line would say nothing.
   */
  line?: string
}

/**
 * THE POISON ROSTER — 15 utility + 5 combat, exactly the two lists on the wiki's Rogue page,
 * with every `coatMsg` copied from spells.json (so a coat line matches by equality, not by a
 * pattern). The prose is idiosyncratic per poison on purpose — "a weak paralytic", "a
 * tar-like poison", "with a stunning agent" — which is why this is a TABLE and not a regex
 * over `in <name> poison`.
 *
 * OBSERVED IN THE USER'S LOG (full sweep of eqlog_Primitive_freeport.txt, re-run 2026-08-04 —
 * 26 coat lines, all on Aug 03; the original sweep saw 6 because the log was younger, and the
 * live log grows): SIX poisons in all — Asp Venom, Blood Siphon Venom, Stunning Venom,
 * Neurotoxic, Mage Bane, Paralytic. The venom bursts are the interesting shape: 01:05:10–:36,
 * 18:21:24–:32 and 21:15:27–:38 each coat asp + siphoning + stunning and nothing else, which
 * is the full combat set available below level 46. The other 14 poisons have never been coated
 * here; they are listed anyway for the same reason the consider ladder lists unobserved rungs —
 * recognising a line we haven't seen costs nothing, and declining it would silently drop a real
 * coat.
 */
export const POISONS: readonly PoisonDef[] = [
  // ── utility (ONE at a time; replaces the previous utility coat) ────────────────────
  { name: 'Weakening Poison', group: 'utility', level: 4, coatMsg: 'You coat your blades in a weak paralytic.', strikes: ['Weakening Strike'] },
  { name: 'Hobbling Poison', group: 'utility', level: 5, coatMsg: 'You coat your blades in a thick venom.', strikes: ['Hobbling Strike'] },
  { name: 'Concussive Poison', group: 'utility', level: 7, coatMsg: 'You coat your blades with a potent venom.', strikes: ['Concussive Strike'] },
  { name: 'Befuddling Poison', group: 'utility', level: 9, coatMsg: 'You coat your blades in a mind numbing poison.', strikes: ['Befuddling Strike'] },
  { name: 'Grounding Poison', group: 'utility', level: 11, coatMsg: 'You coat your blades in a tar-like poison.', strikes: ['Grounding Strike'] },
  { name: 'Clumsiness Poison', group: 'utility', level: 18, coatMsg: 'You coat your blades in a numbing poison.', strikes: ['Clumsiness Strike'] },
  { name: 'Banishing Poison', group: 'utility', level: 20, coatMsg: 'You coat your blades with a magical poison.', strikes: ['Banishing Strike'] },
  { name: 'Fettering Poison', group: 'utility', level: 23, coatMsg: 'You coat your blades in a fettering poison.', strikes: ['Grounding Strike', 'Hobbling Strike'] },
  { name: 'Binding Poison', group: 'utility', level: 25, coatMsg: 'You coat your blades in a binding poison.', strikes: ['Weakening Strike', 'Hobbling Strike'] },
  { name: 'Neurotoxic Poison', group: 'utility', level: 28, coatMsg: 'You coat your blades in a neurotoxic poison.', strikes: ['Befuddling Strike', 'Weakening Strike'] },
  { name: 'Mind Wrack Poison', group: 'utility', level: 30, coatMsg: 'You coat your blades in a mind wracking poison.', strikes: ['Concussive Strike', 'Clumsiness Strike'] },
  { name: 'Thought Drain Poison', group: 'utility', level: 33, coatMsg: 'You coat your blades in a thought draining poison.', strikes: ['Befuddling Strike', 'Clumsiness Strike'] },
  { name: 'Antimagic Poison', group: 'utility', level: 36, coatMsg: 'You coat your blades in antimagic poison.', strikes: ['Concussive Strike', 'Banishing Strike'] },
  { name: 'Mage Bane Poison', group: 'utility', level: 39, coatMsg: 'You coat your blades in mage bane poison.', strikes: ['Befuddling Strike', 'Banishing Strike'] },
  { name: 'Paralytic Poison', group: 'utility', level: 42, coatMsg: 'You coat your blades in a paralytic poison.', strikes: ['Weakening Strike', 'Clumsiness Strike'] },
  // ── combat (STACK across lines; a line's two members REPLACE each other) ──────────
  { name: 'Blood Siphon Venom', group: 'combat', level: 1, coatMsg: 'You coat your blades in a siphoning poison.', strikes: ['Blood Siphon Strike'], line: 'blood' },
  { name: 'Asp Venom', group: 'combat', level: 2, coatMsg: 'You coat your blades in asp venom.', strikes: ['Asp Venom Strike'], line: 'asp' },
  { name: 'Stunning Venom', group: 'combat', level: 15, coatMsg: 'You coat your blades with a stunning agent.', strikes: ['Stunning Strike'], line: 'stunning' },
  { name: 'Blood Draw Venom', group: 'combat', level: 46, coatMsg: 'You coat your blades in a drawing poison.', strikes: ['Blood Draw Strike'], line: 'blood' },
  { name: 'Cobra Venom', group: 'combat', level: 46, coatMsg: 'You coat your blades in cobra venom.', strikes: ['Cobra Venom Strike'], line: 'asp' }
]

/** coat line → poison, for the parser's O(1) exact-match lookup. */
export const POISON_BY_COAT_MSG: ReadonlyMap<string, PoisonDef> = new Map(POISONS.map((p) => [p.coatMsg, p]))
/** poison NAME → poison, for consumers holding only a name (engine, renderer). */
export const POISON_BY_NAME: ReadonlyMap<string, PoisonDef> = new Map(POISONS.map((p) => [p.name, p]))

/**
 * The three combat-venom LINES, in roster order. `MAX_COMBAT_COATS` is DERIVED from this — the
 * cap is a consequence of the roster's replacement rules, never a magic number typed in
 * somewhere. Add a fourth line to POISONS and the cap moves with it.
 */
export const COMBAT_POISON_LINES: readonly string[] = [
  ...new Set(POISONS.filter((p) => p.group === 'combat').map((p) => p.line ?? p.name.toLowerCase()))
]

/** Most combat venoms that can be on the blades at once = one per line. Three today. */
export const MAX_COMBAT_COATS = COMBAT_POISON_LINES.length

/**
 * The exclusivity key for a COATED poison — what the engine's combat stack and the state
 * timeline's `coat:combat:<line>` group are keyed on.
 *
 * Falls back to the lowercased name for anything not in the roster (an 'unknown' coat never
 * reaches here, and a future venom without a `line` is honestly treated as its own line rather
 * than silently folded onto someone else's).
 */
export function coatLineKey(poison: string): string {
  const def = POISON_BY_NAME.get(poison)
  return def?.line ?? poison.toLowerCase()
}

/**
 * The two wears-off lines, split by group exactly as the DB records them. A utility poison
 * ALWAYS says "The poison dries from the blade."; a combat venom always says "The venom
 * drips away." NB in the user's log both `dries` lines land in the SAME SECOND as a new coat
 * (01:06:47 and 01:16:29) — i.e. every observed dry is a REPLACEMENT, not an expiry. Nothing
 * here assumes otherwise; the engine just clears the slot and the following coat refills it.
 */
export const POISON_DRY_MSG: Readonly<Record<string, PoisonGroup>> = {
  'The poison dries from the blade.': 'utility',
  'The venom drips away.': 'combat'
}

/**
 * A poison Strike's landing emote, split into the suffix that identifies it. Both DB shapes
 * are here: POSSESSIVE (`'s limbs move slower!`, which attaches straight to the name) and
 * BARE (`stumbles, clutching their head!`, which follows a space) — the same two-shape rule
 * the DB's own cast-on-other matcher uses.
 *
 * `strikes` is a CANDIDATE list because two emotes are genuinely shared (law 3):
 *   `screams as poison burns their veins!`  → Asp Venom Strike | Cobra Venom Strike
 *   `begins to bleed profusely!`            → Blood Siphon Strike | Blood Draw Strike
 * Both members of each pair carry the same effect class, so `effect` is never ambiguous even
 * when the strike name is.
 */
export interface PoisonProcDef {
  /** DB msgCastOnOther, verbatim. */
  suffix: string
  strikes: string[]
  effect: PoisonEffect
}

export const POISON_PROCS: readonly PoisonProcDef[] = [
  { suffix: "'s limbs move slower!", strikes: ['Weakening Strike'], effect: 'slow' },
  { suffix: "'s fingers slow down.", strikes: ['Clumsiness Strike'], effect: 'spellSlow' },
  { suffix: "'s blessings wither!", strikes: ['Banishing Strike'], effect: 'dispel' },
  { suffix: "'s feet won't budge!", strikes: ['Grounding Strike'], effect: 'root' },
  { suffix: 'stumbles, clutching their head!', strikes: ['Befuddling Strike'], effect: 'manaDrain' },
  { suffix: 'begins to sway!', strikes: ['Stunning Strike'], effect: 'stun' },
  { suffix: 'blinks, looking confused!', strikes: ['Concussive Strike'], effect: 'interrupt' },
  { suffix: 'starts limping!', strikes: ['Hobbling Strike'], effect: 'snare' },
  { suffix: 'begins to bleed profusely!', strikes: ['Blood Siphon Strike', 'Blood Draw Strike'], effect: 'dot' },
  { suffix: 'screams as poison burns their veins!', strikes: ['Asp Venom Strike', 'Cobra Venom Strike'], effect: 'damage' }
]

/**
 * The Strike that prints `<mob>'s limbs move slower!` — the ONE proc this feature measures a
 * time-to-land for. Named once, here, so the parser, the engine and the UI cannot drift.
 */
export const SLOW_STRIKE = 'Weakening Strike'

/**
 * THE DISPEL FAMILY — "the dispel variants and such" (the user), and the one non-poison
 * effect the Procs tab counts.
 *
 * These seven spells are the complete set in the committed spell DB whose landing message
 * contains the word "dispelled", and they land in exactly THREE message tiers:
 *   `feels a bit dispelled.`   → Cancel Magic | Phobocancel                 (968 in the log)
 *   `feels dispelled.`         → Neutralize Magic | Nullify Magic           ( 41)
 *   `feels very dispelled.`    → Beholder Dispel | Pillage Enchantment |
 *                                Strip Enchantment                          (257)
 * plus 120 incoming `You feel a bit dispelled.` lines. The message names no caster and each
 * tier is shared by 2–3 spells, so a lane is labeled with EVERY candidate and flagged
 * ambiguous — the count is exact, the name is not.
 *
 * NOT A ROGUE PROC, and the UI must never imply otherwise. eqlwiki lists Cancel Magic on
 * eleven classes and the log carries NPCs casting it (`a glare lord begins casting Beholder
 * Dispel.`); the rogue's own dispel proc (Banishing Strike, from Banishing / Antimagic / Mage
 * Bane poison) prints a completely different line — `<mob>'s blessings wither!` — which is in
 * POISON_PROCS above and is counted as a Strike. When this was first written the log had 1,386
 * dispel landings and ZERO `blessings wither` lines; re-swept 2026-08-04 it has NINETEEN (plus
 * 3 `resisted your Banishing Strike!`), because the player has since coated Mage Bane. The
 * conclusion is unchanged and now has both arms: the two families are separately counted and
 * the 19 that ARE the rogue's proc are in the Strike ledger, not in this one.
 *
 * This list is a CURATED gate on purpose. The raw message-driven landing stream is far too
 * broad to tabulate — a single lifetap landing message resolves to 36 candidate spells — so a
 * panel fed by all of it would be noise. Only this family is counted.
 */
export const DISPEL_FAMILY: ReadonlySet<string> = new Set([
  'Cancel Magic',
  'Phobocancel',
  'Neutralize Magic',
  'Nullify Magic',
  'Beholder Dispel',
  'Pillage Enchantment',
  'Strip Enchantment'
])

/** True when coating this poison gives you a chance at the slow proc (grants SLOW_STRIKE). */
export function isSlowCapable(poison: string): boolean {
  return POISON_BY_NAME.get(poison)?.strikes.includes(SLOW_STRIKE) ?? false
}
