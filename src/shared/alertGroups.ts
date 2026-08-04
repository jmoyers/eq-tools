// alertGroups.ts — the CURATED one-click alert groups ("grounded sane defaults").
//
// A GROUP is a small, coherent set of AlertDefs the user turns on with one click: "Out of
// range", "Resists", "Mez / root broke". It is the counterpart to the per-spell suggestion
// templates in features/alerts/suggestions.ts — those answer "alert me about THIS spell",
// these answer "alert me about the things that silently cost you a pull".
//
// THE LAW HERE IS VERIFICATION. Every trigger below was checked READ-ONLY against the real
// log (eqlog_Primitive_freeport.txt, 1,144,036 lines, 2026-08-03) and the exact matched line
// shape + its occurrence count is quoted beside it. A group whose line does NOT exist in the
// log ships `verified: false` and is NOT rendered — a guessed regex that never fires is worse
// than an absent feature, because the user believes they are covered. Two groups the owner
// asked for are in exactly that state (feign-death failure, pet death); their comments say
// why, so nobody re-derives the same dead end.
//
// PARSED EVENTS OVER RAW REGEXES. Where the parser already emits a typed event for the line
// (resist, uncharm, cc, castFizzle, castInterrupted, playerDeath) the trigger uses the EVENT
// kind: it survives log-format drift, it carries structured `where` fields, and the parse is
// already golden-window tested. Raw regexes are used only for lines no event covers — the
// four client-side notices ("too far away", "out of range", "cannot see", "Insufficient
// Mana"), the two invisibility lines and the block notice.
//
// SOUNDS mirror the shipped Alan Rickman pack the same way suggestions.ts does — the ids are
// repeated as literals because a renderer module cannot import from src/main. They are
// declared in src/main/data/defaultPacks.ts (`DEFAULT_ALERT_SOUNDS`) so provisionPacks
// verifies they resolved after an install; keep the two lists in sync.
//
// COOLDOWNS are per-group judgment calls, documented on each group. The rule of thumb: the
// cooldown is the length of ONE user-visible episode, not the gap between two log lines — a
// melee out-of-range notice repeats 2-4× per second for as long as you hold auto-attack, so
// its cooldown is "tell me once per approach", not "once per line".

import type { AlertDef, AlertTrigger } from './alertTypes'

/** The shipped pack every group's sound points at (mirrors DEFAULT_ALERT_PACK_ID). */
export const GROUP_PACK_ID = 'alan-rickman'

/**
 * The rogue-slow group's id and its ONE def's id, named here so the two entry points that
 * create it — the groups panel and the observed-driven offer strip
 * (docs/plans/poison-slow-alerts.md §1.3) — author the SAME def. One id, two doors: creating
 * it from either is idempotent, and having it from either retires the offer.
 */
export const POISON_SLOW_GROUP_ID = 'poisonSlow'
export const POISON_SLOW_ALERT_ID = 'alert:poison-slow-landed'

/**
 * Alan Rickman lines used by the groups (derived soundIds; see defaultPacks.ts header).
 * The spoken line each one is, so a future edit keeps the INTENT rather than the id.
 */
const SOUND = {
  /** "You are out of position." — you cannot reach what you are attacking. */
  outOfRange: 'resource-limit-resource-limit-01',
  /** a dry error read — your spell was shrugged off. */
  resisted: 'task-error-task-error-01',
  /** a dry error read — the cast never happened. */
  castFailed: 'task-error-task-error-02',
  /** a limit read — you are becoming visible again. */
  invisDrop: 'resource-limit-resource-limit-02',
  /** a limit read — the mana is not there. */
  outOfMana: 'resource-limit-resource-limit-03',
  /** an error read — the spell bounced off an existing effect. */
  spellBlocked: 'task-error-task-error-03',
  /** a flat error read — you are dead. */
  playerDeath: 'task-error-task-error-04',
  /** "I find myself... requiring your attention." — the seeded charm-break line. */
  charmBreak: 'input-required-input-required-02',
  /** an attention read — the thing you were holding is loose again. */
  ccBreak: 'input-required-input-required-03',
  /** "Consider this my opening move." — a debuff took hold on the mob in front of you. */
  debuffLanded: 'task-acknowledge-task-acknowledge-05'
} as const

/** Every group sound id, for the defaultPacks.ts cross-check + provisioning verification. */
export const GROUP_SOUND_IDS: string[] = [...new Set(Object.values(SOUND))]

/** One alert a group authors. `id` is the FINAL alert id (stable, for created-detection). */
export interface AlertGroupDefSpec {
  id: string
  name: string
  trigger: AlertTrigger
  soundId: string
  cooldownMs: number
  /** the verified log line this def fires on — quoted into the def's `note`. */
  line: string
  /** how many times that shape occurs in the reference log (provenance, not a threshold). */
  observed: number
  /**
   * Extra provenance appended to the created def's `note` — what the alert MEANS in the
   * fight (a duration, a re-landing habit), never how the matcher works. Optional; most
   * groups' quoted line says everything there is to say.
   */
  note?: string
}

/** A one-click group of alerts. */
export interface AlertGroup {
  id: string
  /** what the group is, in the user's words. */
  title: string
  /** the STATE it reports (never how it works). */
  subtitle: string
  /**
   * false ⇒ the group is NOT offered: the log carries no line that could fire it. The UI
   * filters on this; `unverifiedReason` exists so the omission stays documented in one place.
   */
  verified: boolean
  unverifiedReason?: string
  defs: AlertGroupDefSpec[]
}

/**
 * A raw-line trigger for an EXACT client notice.
 *
 * A raw trigger is tested against `LogEvent.raw`, which is the WHOLE line INCLUDING the
 * `[Tue Jul 28 13:04:53 2026] ` timestamp prefix (parser.ts keeps `raw` verbatim and only
 * `text` is stripped). So the left anchor is the `] ` that closes the timestamp, never `^` —
 * a `^`-anchored pattern here would match nothing at all, silently.
 */
function rawLine(text: string): AlertTrigger {
  return { type: 'raw', regex: `\\] ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` }
}

/**
 * THE CATALOG. Order is the order the surface renders them: the two the owner called out
 * first (range, resists), then the crowd-control pair, then the cast/resource failures.
 */
export const ALERT_GROUPS: AlertGroup[] = [
  {
    id: 'range',
    title: 'Out of range',
    subtitle: 'Your swings and casts are not reaching the target.',
    verified: true,
    defs: [
      {
        // COOLDOWN 8s: the melee notice repeats 2-4× per second for the whole time auto-attack
        // is on and the mob is out of reach (3,329 lines, in bursts). 8s = one nudge per
        // approach; anything shorter is a machine-gun.
        id: 'group:range:melee',
        name: 'Out of range — melee',
        trigger: rawLine('Your target is too far away, get closer!'),
        soundId: SOUND.outOfRange,
        cooldownMs: 8000,
        line: 'Your target is too far away, get closer!',
        observed: 3329
      },
      {
        // The SPELL-side twin — a different sentence entirely, and rarer (you notice a failed
        // cast sooner than a failed swing). Same 8s episode length.
        id: 'group:range:spell',
        name: 'Out of range — spell',
        trigger: rawLine('Your target is out of range, get closer!'),
        soundId: SOUND.outOfRange,
        cooldownMs: 8000,
        line: 'Your target is out of range, get closer!',
        observed: 72
      },
      {
        // Line of sight, not distance — the third way "you are attacking nothing" happens, and
        // the one people mistake for lag. Same burst behaviour as the melee notice.
        id: 'group:range:sight',
        name: 'No line of sight',
        trigger: rawLine('You cannot see your target.'),
        soundId: SOUND.outOfRange,
        cooldownMs: 8000,
        line: 'You cannot see your target.',
        observed: 2600
      }
    ]
  },
  {
    id: 'resists',
    title: 'Resists',
    subtitle: 'A spell you cast was fully resisted.',
    verified: true,
    defs: [
      {
        // The FIRST-CLASS `resist` event, not a regex: the parser already separates the three
        // resist shapes and sets caster='you' for your own (Task #51 v2). `where:{caster:'you'}`
        // therefore excludes your pet's resists and every mob-vs-mob resist in the zone.
        // COOLDOWN 5s: a mez chain eats 2-3 resists back to back; 5s is one nudge per attempt
        // cycle rather than one per resist.
        id: 'group:resists:yours',
        name: 'Your spell was resisted',
        trigger: { type: 'event', kind: 'resist', where: { caster: 'you' } },
        soundId: SOUND.resisted,
        cooldownMs: 5000,
        line: '<target> resisted your <Spell>!',
        observed: 1779
      }
    ]
  },
  {
    id: 'charm',
    title: 'Charm break',
    subtitle: 'Your charmed pet is loose.',
    verified: true,
    defs: [
      {
        // Deliberately the SEEDED id: a user who already has the built-in charm-break alert
        // sees this group as already created instead of getting a duplicate.
        // COOLDOWN 3s: one event per break; the window only collapses a double-log.
        id: 'charm-break',
        name: 'Charm break',
        trigger: { type: 'event', kind: 'uncharm' },
        soundId: SOUND.charmBreak,
        cooldownMs: 3000,
        line: 'Your Allure spell has worn off of <mob>.',
        observed: 379
      }
    ]
  },
  {
    id: 'cc',
    title: 'Mez / root broke',
    subtitle: 'A mob you had mezzed or rooted is free again.',
    verified: true,
    defs: [
      {
        // The parser routes a CC spell's "worn off of <mob>" to `cc` with refresh:true (charm
        // goes to uncharm; anything else to buffFade), so this fires for mez/root ONLY.
        //
        // HONEST LIMIT: the log prints the SAME sentence whether the mez ran its full duration
        // or was broken early by damage. There is no "early break" line — so this alert is
        // "it broke", never "it broke early", and it is named that way.
        // COOLDOWN 3s: several mobs can break in the same tick; 3s makes that one alert.
        id: 'group:cc:broke',
        name: 'Mez / root broke',
        trigger: { type: 'event', kind: 'cc', where: { refresh: 'true' } },
        soundId: SOUND.ccBreak,
        cooldownMs: 3000,
        line: 'Your Mesmerization spell has worn off of <mob>.',
        observed: 1738
      }
    ]
  },
  {
    id: 'invis',
    title: 'Invisibility dropping',
    subtitle: 'You are becoming visible.',
    verified: true,
    defs: [
      {
        // ONE def over an 'any' composite of the two real lines rather than two defs: they fire
        // ~1s apart on the same drop (the warning, then the fact), and two defs would mean two
        // sounds for one event. Composite cooldown is alert-level (Task #47), so 5s collapses
        // the pair into a single alert.
        id: 'group:invis:drop',
        name: 'Invisibility dropping',
        trigger: {
          type: 'any',
          conditions: [
            { type: 'raw', regex: '\\] You feel yourself starting to appear\\.$' },
            { type: 'raw', regex: '\\] You become visible\\.$' }
          ]
        },
        soundId: SOUND.invisDrop,
        cooldownMs: 5000,
        line: 'You feel yourself starting to appear. / You become visible.',
        observed: 241
      }
    ]
  },
  {
    id: 'castFail',
    title: 'Cast failed',
    subtitle: 'A spell you started never went off.',
    verified: true,
    defs: [
      {
        // COOLDOWN 4s: fizzles come in streaks of 3-5 on a low skill; 4s reports the streak once.
        id: 'group:castFail:fizzle',
        name: 'Fizzle',
        trigger: { type: 'event', kind: 'castFizzle' },
        soundId: SOUND.castFailed,
        cooldownMs: 4000,
        line: 'Your Chaotic Feedback spell fizzles!',
        observed: 535
      },
      {
        // The other half of a dead cast — moved, stunned, or bashed mid-cast.
        id: 'group:castFail:interrupted',
        name: 'Cast interrupted',
        trigger: { type: 'event', kind: 'castInterrupted' },
        soundId: SOUND.castFailed,
        cooldownMs: 4000,
        line: 'Your Invisibility spell is interrupted.',
        observed: 979
      },
      {
        // A spell that was BLOCKED by a stronger/incompatible effect already on the target —
        // it consumed the cast and did nothing, which is easy to miss mid-fight.
        // Not anchored at the end: the line carries a trailing "(Blocked by X.)" clause.
        id: 'group:castFail:blocked',
        name: 'Spell did not take hold',
        trigger: { type: 'raw', regex: '\\] Your .+ spell did not take hold' },
        soundId: SOUND.spellBlocked,
        cooldownMs: 5000,
        line: 'Your Arch Shielding spell did not take hold. (Blocked by Talisman of Altuna.)',
        observed: 88
      }
    ]
  },
  {
    id: 'mana',
    title: 'Out of mana',
    subtitle: 'The cast never started — not enough mana.',
    verified: true,
    defs: [
      {
        // COOLDOWN 6s: this is a key-mash line (529 occurrences, always in clusters of 2-5).
        id: 'group:mana:insufficient',
        name: 'Not enough mana',
        trigger: rawLine('Insufficient Mana to cast this spell!'),
        soundId: SOUND.outOfMana,
        cooldownMs: 6000,
        line: 'Insufficient Mana to cast this spell!',
        observed: 529
      }
    ]
  },
  {
    id: 'death',
    title: 'You died',
    subtitle: 'Your corpse and your buffs are gone.',
    verified: true,
    defs: [
      {
        id: 'group:death:you',
        name: 'You died',
        trigger: { type: 'event', kind: 'playerDeath' },
        soundId: SOUND.playerDeath,
        cooldownMs: 5000,
        line: 'You have been slain by a magician!',
        observed: 21
      }
    ]
  },
  {
    // ON-YOU VARIANT: DELIBERATELY ABSENT. Weakening Strike's msgCastOnYou is
    // `Your limbs slow down!` (spells.json), but a full-log sweep of
    // eqlog_Primitive_freeport.txt (1,211,830 lines, 2026-08-03) finds it ZERO times, so
    // there is no fixture line to quote and no `observed` count to state — this file's law
    // forbids shipping it. It would also NOT be a `poisonProc`: that line's last word is
    // "down!", which is in no proc suffix, so the parser cascade falls through the poison
    // branch to the DB cast-on-you table and emits `buffApply { spell:'Weakening Strike' }`
    // (pinned in tests/poisonSlowAlerts.test.mts, so if the line ever appears, the shape it
    // needs is already measured rather than guessed).
    id: POISON_SLOW_GROUP_ID,
    title: 'Rogue slow poisons',
    subtitle: 'A mob in your fight just got slowed.',
    verified: true,
    defs: [
      {
        // THE ROGUE SLOW. Weakening Strike — the proc granted by the four utility poisons
        // (Weakening, Binding, Neurotoxic, Paralytic) — prints ONE line and no cast line at
        // all, so the parser's first-class `poisonProc` event is the only honest handle on
        // it. `where:{effect:'slow'}` is what picks this proc out of the other nine: the
        // effect class is unambiguous even for the two emotes shared by a pair of Strikes
        // (shared/poisons.ts), and it survives a Strike being renamed.
        //
        // NO PERCENTAGE APPEARS ANYWHERE IN THIS COPY, deliberately: the wiki states both
        // 35% and 15% for this line on different pages and the contradiction is unresolved.
        // The DURATION is safe — spells.json has 210000 ms for Weakening Strike — so that is
        // what the note says.
        //
        // COOLDOWN 30s: the proc RE-LANDS on a mob that is already slowed, several times a
        // pull — the reference window (tests/fixtures/w41-poison-asp-venom.log) lands four
        // on Stonesoul the Unmoving inside 44 s. 30 s is roughly one user-visible episode
        // per pull without muting the NEXT pull. Fight-scoped dedupe is not expressible in
        // the alert engine and is not worth building for this; the honest consequence is
        // that a long pull can nudge you twice, which the tests pin exactly.
        id: POISON_SLOW_ALERT_ID,
        name: 'Mob slowed (rogue poison)',
        trigger: { type: 'event', kind: 'poisonProc', where: { effect: 'slow' } },
        soundId: SOUND.debuffLanded,
        cooldownMs: 30000,
        line: "Stonesoul the Unmoving's limbs move slower!",
        observed: 482,
        note:
          'Weakening Strike, the rogue utility-poison slow — 3:30 duration. It re-lands on a ' +
          'mob that is already slowed several times a pull, so this alert is rate-limited to ' +
          'about one nudge per pull rather than one per landing.'
      }
    ]
  },
  {
    // ---- NOT OFFERED -------------------------------------------------------------------
    id: 'feignDeath',
    title: 'Feign death failed',
    subtitle: 'Not available — the log never says a feign failed.',
    verified: false,
    unverifiedReason:
      'Full-log sweep: the ONLY feign-death lines are the success emote "<Name> has fallen to ' +
      'the ground." (103), the spell casts ("Rigamortis begins casting Feign Death."), the ' +
      'interrupt of that spell, and skill-ups ("You have become better at Feign Death!"). ' +
      'There is no failure line at all — no "ruse", no "fooled", no "not successful". A failed ' +
      'feign is invisible in the log (world-model law 6: say what the log cannot say), so any ' +
      'regex here would be a guess that never fires.',
    defs: []
  },
  {
    id: 'petDeath',
    title: 'Pet died',
    subtitle: 'Not available — the log does not mark your pet.',
    verified: false,
    unverifiedReason:
      'Your summoned pet carries a random proper name (Giber, Kibn, Vebann…) and dies with the ' +
      'ordinary "<Name> has been slain by <X>!" line — byte-identical to any other entity\'s ' +
      'death. The " pet" token seen in "A necro neophyte pet has been slain by Kibn!" belongs ' +
      "to OTHER owners' pets, never to yours. Only the world model knows which name is your " +
      'pet (bound by the owner-only "…Master." tell), and an AlertDef cannot express that ' +
      'binding — it matches text, not entities. Needs a derived event before it can ship.',
    defs: []
  }
]

/** The groups the surface actually renders — the unverified ones are documentation only. */
export const VERIFIED_ALERT_GROUPS: AlertGroup[] = ALERT_GROUPS.filter((g) => g.verified)

/** Build the concrete AlertDefs a group authors, pointed at `packId`. */
export function alertGroupDefs(group: AlertGroup, packId: string = GROUP_PACK_ID): AlertDef[] {
  return group.defs.map((spec) => ({
    id: spec.id,
    name: spec.name,
    enabled: true,
    trigger: spec.trigger,
    sound: { packId, soundId: spec.soundId },
    cooldownMs: spec.cooldownMs,
    note:
      `Suggested group "${group.title}" — fires on: ${spec.line}` +
      (spec.note ? ` ${spec.note}` : '')
  }))
}

/**
 * The def(s) the rogue-slow OFFER creates when accepted — the same list the groups panel's
 * "Add" button produces for that group, built from the same catalog entry. Two entry points,
 * one authored def: accepting the offer and clicking the group card are interchangeable, and
 * doing both is a no-op (the store upserts by id).
 */
export function poisonSlowAlertDefs(packId: string = GROUP_PACK_ID): AlertDef[] {
  const group = ALERT_GROUPS.find((g) => g.id === POISON_SLOW_GROUP_ID)
  return group ? alertGroupDefs(group, packId) : []
}

/** Every def id a group would create (for the created/partially-created chip state). */
export function alertGroupDefIds(group: AlertGroup): string[] {
  return group.defs.map((d) => d.id)
}
