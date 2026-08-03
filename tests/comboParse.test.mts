// CLASS-EVIDENCE PARSING — Wave 1 of docs/plans/class-combo-inference.md.
//
// Two new line families, and everything about them is load-bearing for a model that has to
// infer a three-class loadout the game NEVER logs:
//   selfWho  the character's own `/who` row — the ONLY line that states the loadout outright
//   skillUp  `You have become better at <Skill>! (<n>)` — the only window into BER/MNK/WAR/ROG
//
// The fixtures replay through the REAL parser (tests/extract-combo-fixtures.mjs cut them from
// the live log through the shared scrub), so these are golden windows in the house sense:
// hand-read spans of the user's actual log, not synthesized lines. The full-log replays are
// guarded on the log existing (CI has no game log) and assert FLOORS, never today's counts —
// the log grows by append.
//
// THE THIRD-PARTY GUARD IS A TEST, NOT A COMMENT. A `/who` prints every stranger in the zone
// in exactly the player's grammar (410 of the 421 rows in the real log are somebody else), so
// there is a test below proving a stranger's row stays `unknown` — and another proving that
// with NO character installed even the player's own row does.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parseEqTimestamp, parseEvent } from '../src/main/log/parser'
import { installCharacterName } from '../src/main/log/rulesets'
import type { LogEvent, SelfWhoEvent, SkillUpEvent } from '../src/shared/logEvents'
import { readFixture } from './harness.mts'

const LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

/** The tailed character for every window here — the parser keys the self row on THIS name. */
const SELF = 'Primitive'

function parseAll(lines: string[]): LogEvent[] {
  const out: LogEvent[] = []
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) out.push(ev)
  }
  return out
}

const whoRows = (evs: LogEvent[]): SelfWhoEvent[] =>
  evs.filter((e): e is SelfWhoEvent => e.kind === 'selfWho')
const skillUps = (evs: LogEvent[]): SkillUpEvent[] =>
  evs.filter((e): e is SkillUpEvent => e.kind === 'skillUp')

/** The row as a comparable tuple: level, combo, race, zone. */
const rowOf = (w: SelfWhoEvent): [number, string, string | undefined, string | undefined] => [
  w.level,
  w.classes.join('/'),
  w.race,
  w.zone
]

/** One line, parsed with the character installed. */
function one(raw: string): LogEvent {
  installCharacterName(SELF)
  const ev = parseEvent(raw, 0)
  assert.ok(ev, `line did not parse at all: ${raw}`)
  return ev
}

// ---------------------------------------------------------------------------
// The self /who row — every real row, and every variant of the grammar.
// ---------------------------------------------------------------------------

test('CW1: the four DISTINCT /who anchors parse to their exact combos', () => {
  installCharacterName(SELF)
  const rows = whoRows(parseAll(readFixture('cw1-who-anchored.log')))
  // Seven rows in the Jul 28 14:00–20:45 span; the four distinct combos are what the design
  // anchors on, and the 2→3 arity change is the tertiary slot unlocking at level 10.
  assert.deepEqual(rows.map(rowOf), [
    [7, 'CLR/BER', 'Froglok', 'West Commonlands'],
    [7, 'PAL/ENC', 'Froglok', 'West Commonlands'],
    [10, 'PAL/ROG/ENC', 'Froglok', 'The Ocean of Tears'],
    [17, 'PAL/MNK/ENC', 'Dark Elf', 'The City of Guk'],
    [17, 'PAL/MNK/ENC', 'Dark Elf', 'The City of Guk'],
    [17, 'PAL/MNK/ENC', 'Dark Elf', 'The City of Guk'],
    [18, 'PAL/MNK/ENC', 'Dark Elf', 'The City of Guk']
  ])
  // Arity IS the cardinality statement: 2 slots below level 10, 3 at/after it.
  for (const r of rows) assert.equal(r.classes.length, r.level < 10 ? 2 : 3)
})

test('CW2 / CW3: the remaining fixture rows parse, and no stranger ever does', () => {
  installCharacterName(SELF)
  assert.deepEqual(whoRows(parseAll(readFixture('cw2-loadout-swap-aug2.log'))).map(rowOf), [
    [50, 'PAL/MNK/ENC', 'Dark Elf', 'East Freeport']
  ])
  assert.deepEqual(whoRows(parseAll(readFixture('cw3-ambiguous-clr-pal.log'))).map(rowOf), [
    [7, 'CLR/BER', 'Froglok', 'West Commonlands'],
    [7, 'PAL/ENC', 'Froglok', 'West Commonlands']
  ])
  // The scrub drops every stranger's row, so a committed fixture must contain exactly the
  // player's own — belt and braces on top of the parser's name guard.
  for (const f of ['cw1-who-anchored.log', 'cw2-loadout-swap-aug2.log', 'cw3-ambiguous-clr-pal.log', 'cw4-stray-cast.log']) {
    for (const line of readFixture(f)) {
      if (/\[\d+ [A-Z]{3}/.test(line)) assert.match(line, /\] Primitive /, `stranger row in ${f}: ${line}`)
    }
  }
})

test("a THIRD PARTY's /who row stays unknown — the self-name is the whole guard", () => {
  // Real shapes, verbatim from the log (names are mechanical, not anyone's words).
  const strangers = [
    '[Tue Jul 28 14:11:26 2026] [9 WAR/MAG] Korros (Ogre) <Gothic Circle> ZONE: The City of Guk (guktop)  ',
    '[Tue Jul 28 14:11:26 2026]  AFK [4 WAR/ENC] Frogmage (Human)  ZONE: West Commonlands (commons)  ',
    "[Tue Jul 28 14:11:26 2026] * RIP *[3 MNK/BER] Norvyn's corpse (Iksar)  ZONE: West Commonlands (commons)  ",
    '[Tue Jul 28 14:11:26 2026] [ANONYMOUS] Brash '
  ]
  installCharacterName(SELF)
  for (const raw of strangers) assert.equal(parseEvent(raw, 0)?.kind, 'unknown', raw)
})

test('with NO character installed the rule declines even the player\'s own row', () => {
  // A parser that does not know whose log it is reads a loadout for nobody. Better silent
  // than wrong: this is the state during any replay that never called installCharacterName.
  installCharacterName(undefined)
  const raw =
    '[Fri Jul 31 23:48:53 2026] [50 PAL/MNK/ENC] Primitive (Dark Elf)  ZONE: East Freeport (freporte)  '
  assert.equal(parseEvent(raw, 0)?.kind, 'unknown')
  installCharacterName(SELF)
  assert.equal(parseEvent(raw, 0)?.kind, 'selfWho')
})

test('the /who variants this character has not printed yet still parse for THEM', () => {
  // The general grammar carries a guild tag, an AFK marker and a corpse row. None appear on
  // Primitive's 11 rows, but a scrub/parse pair that refused them would silently drop the only
  // loadout statement in a future log. Synthetic — the SHAPES are copied from real rows.
  const guild = one('[Fri Jul 31 23:48:53 2026] [50 PAL/MNK/ENC] Primitive (Dark Elf) <Gothic Circle> ZONE: East Freeport (freporte)  ')
  assert.deepEqual(guild.kind === 'selfWho' ? rowOf(guild) : null, [50, 'PAL/MNK/ENC', 'Dark Elf', 'East Freeport'])
  const afk = one('[Fri Jul 31 23:48:53 2026]  AFK [50 PAL/MNK/ENC] Primitive (Dark Elf)  ZONE: East Freeport (freporte)  ')
  assert.equal(afk.kind, 'selfWho')
  const rip = one("[Fri Jul 31 23:48:53 2026] * RIP *[50 PAL/MNK/ENC] Primitive's corpse (Dark Elf)  ZONE: East Freeport (freporte)  ")
  assert.deepEqual(rip.kind === 'selfWho' ? rowOf(rip) : null, [50, 'PAL/MNK/ENC', 'Dark Elf', 'East Freeport'])
  // A zone printed as a bare short name has no display twin to strip.
  const shortZone = one('[Fri Jul 31 23:48:53 2026] [50 PAL/MNK/ENC] Primitive (Dark Elf)  ZONE: befallen_78  ')
  assert.equal(shortZone.kind === 'selfWho' ? shortZone.zone : null, 'befallen_78')
})

// ---------------------------------------------------------------------------
// Skill-ups.
// ---------------------------------------------------------------------------

test('a skill-up parses WITH and WITHOUT the trailing (n)', () => {
  // The real log's 10,216 lines all carry the value; the value-less shape must still yield
  // the SKILL, which is the class evidence — and `value` is omitted, never 0 (law 1).
  const withVal = one('[Tue Jul 28 12:32:17 2026] You have become better at Frenzy! (9)')
  assert.deepEqual(withVal, { kind: 'skillUp', seq: 0, ts: withVal.ts, raw: withVal.raw, skill: 'Frenzy', value: 9 })
  const noVal = one('[Tue Jul 28 12:32:17 2026] You have become better at Frenzy!')
  assert.deepEqual(noVal, { kind: 'skillUp', seq: 0, ts: noVal.ts, raw: noVal.raw, skill: 'Frenzy' })
  assert.equal('value' in noVal, false)
})

test('the skill name is the CLIENT spelling, verbatim — multi-word and abbreviated', () => {
  // classes.json keys its skills table by exactly these strings (the wiki writes "1 Hand
  // Slashing", "Channelling", "String"), so the event must never pre-translate.
  const cases: [string, string][] = [
    ['You have become better at Flying Kick! (48)', 'Flying Kick'],
    ['You have become better at 1H Slashing! (200)', '1H Slashing'],
    ['You have become better at Stringed Instruments! (12)', 'Stringed Instruments'],
    ['You have become better at Specialize Alteration! (75)', 'Specialize Alteration']
  ]
  for (const [text, skill] of cases) {
    const ev = one(`[Sun Aug 02 01:57:42 2026] ${text}`)
    assert.equal(ev.kind === 'skillUp' ? ev.skill : null, skill)
  }
})

test('CW2 carries the EVIDENCE SHIFT: MNK stops and ROG starts, one hour apart', () => {
  // The design's headline inference. Nothing in the log announces the swap; this ordering IS
  // the signal, and Wave 3 asserts a boundary inside exactly this window.
  installCharacterName(SELF)
  const ups = skillUps(parseAll(readFixture('cw2-loadout-swap-aug2.log')))
  const last = (skill: string): number => Math.max(...ups.filter((u) => u.skill === skill).map((u) => u.ts))
  const first = (skill: string): number => Math.min(...ups.filter((u) => u.skill === skill).map((u) => u.ts))
  // Compared as instants against the log's own clock (parseEqTimestamp is user-local; an ISO
  // string would be UTC and would drift with the machine's zone — see the formatDate law).
  const lastMnk = Math.max(last('Feign Death'), last('Mend'), last('Flying Kick'))
  assert.equal(lastMnk, parseEqTimestamp('Sun Aug 02 00:57:55 2026'))
  assert.ok(first('Backstab') > lastMnk, 'the first ROG evidence must follow the last MNK evidence')
  assert.equal(first('Backstab'), parseEqTimestamp('Sun Aug 02 01:57:42 2026'))
  // After the shift, MNK is not merely rarer — it is GONE, which is what makes it evidence.
  assert.equal(ups.filter((u) => u.ts > first('Backstab') && ['Mend', 'Flying Kick', 'Feign Death'].includes(u.skill)).length, 0)
  // And the ROG/BER side sustains across many hourly buckets (the admission rule's `sustain`).
  const buckets = new Set(
    ups.filter((u) => u.skill === 'Backstab' || u.skill === 'Frenzy').map((u) => Math.floor(u.ts / 3_600_000))
  )
  assert.ok(buckets.size >= 8, `ROG/BER evidence spans ${buckets.size} hourly buckets`)
})

test('CW4: the stray cast window carries exactly one out-of-loadout cast', () => {
  // `You begin casting Rampage I.` at Sun Aug 02 20:52:33 — spells.json maps Rampage to
  // {ENC}, deep inside the PAL/ROG/BER period. One cast in one bucket must never admit a
  // class (design § 4.2's `sustain >= 2`). NOTE: the design calls this window "the lone Chaos
  // Flux"; there is no player Chaos Flux cast on Aug 2 at all (the only Aug 2 occurrences are
  // a ghoul scribe's, which never become a castBegin). Rampage I is the real instance.
  installCharacterName(SELF)
  const evs = parseAll(readFixture('cw4-stray-cast.log'))
  const casts = evs.filter((e) => e.kind === 'castBegin').map((e) => e.spell)
  assert.equal(casts.filter((s) => s === 'Rampage I').length, 1)
  assert.equal(whoRows(evs).length, 0, 'no /who row in this window — the model is on its own here')
})

// ---------------------------------------------------------------------------
// Full-log replay. Floors and identities only (the log grows by append).
// ---------------------------------------------------------------------------

test('full-log replay: all 11 historical /who rows, in order, exactly', { skip: !existsSync(LOG) }, () => {
  installCharacterName(SELF)
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)
  const rows: SelfWhoEvent[] = []
  const ups: SkillUpEvent[] = []
  let seq = 0
  for (const raw of lines) {
    if (!raw) continue
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    if (ev.kind === 'selfWho') rows.push(ev)
    else if (ev.kind === 'skillUp') ups.push(ev)
  }
  // The 11 rows are FROZEN in the past — the log only appends — so the first 11 are an exact
  // assertion while the total stays a floor. (Design § 2/A1 enumerates them.)
  assert.ok(rows.length >= 11, `expected at least the 11 known /who rows, got ${rows.length}`)
  assert.deepEqual(rows.slice(0, 11).map(rowOf), [
    [7, 'CLR/BER', 'Froglok', 'West Commonlands'],
    [7, 'PAL/ENC', 'Froglok', 'West Commonlands'],
    [10, 'PAL/ROG/ENC', 'Froglok', 'The Ocean of Tears'],
    [17, 'PAL/MNK/ENC', 'Dark Elf', 'The City of Guk'],
    [17, 'PAL/MNK/ENC', 'Dark Elf', 'The City of Guk'],
    [17, 'PAL/MNK/ENC', 'Dark Elf', 'The City of Guk'],
    [18, 'PAL/MNK/ENC', 'Dark Elf', 'The City of Guk'],
    [20, 'PAL/MNK/ENC', 'Ogre', 'The City of Guk 15'],
    [10, 'PAL/ROG/ENC', 'Froglok', 'The Rathe Mountains'],
    [24, 'PAL/MNK/ENC', 'Ogre', 'The Ruins of Old Guk'],
    [50, 'PAL/MNK/ENC', 'Dark Elf', 'East Freeport']
  ])
  // MEASURED FLOOR: 10,216 skill-up lines over 54 distinct skills at 2026-08-03 (1.12M lines).
  // Floors, not equalities — the log grows, and the distinct count moved 53 → 54 during this
  // very wave when the character first ticked a new skill.
  assert.ok(ups.length >= 10_216, `skill-up floor: got ${ups.length}`)
  assert.ok(new Set(ups.map((u) => u.skill)).size >= 53, 'distinct-skill floor')
  // Every one of them stated a value, and every name is a plausible client skill string.
  for (const u of ups) {
    assert.ok(u.value !== undefined && u.value > 0, `no value on ${u.raw}`)
    assert.match(u.skill, /^[A-Za-z0-9][A-Za-z0-9 '-]{1,38}$/, `implausible skill ${JSON.stringify(u.skill)}`)
  }
  // The signature skills the whole model rests on are all present.
  const names = new Set(ups.map((u) => u.skill))
  for (const s of ['Frenzy', 'Backstab', 'Mend', 'Flying Kick', 'Feign Death', 'Singing']) {
    assert.ok(names.has(s), `missing signature skill ${s}`)
  }
})

test('full-log replay: no third-party /who row is ever claimed', { skip: !existsSync(LOG) }, () => {
  // 421 `/who` rows in the log; exactly 11 are the player's. The other 410 must stay unknown
  // — a stranger's classes attributed to the player would poison every interval.
  installCharacterName(SELF)
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)
  const ROW = /\]\s*(?:\* RIP \*\s*)?(?:AFK\s+)?\[(?:ANONYMOUS|\d+ [A-Z]{3})/
  let rowLines = 0
  let claimed = 0
  let seq = 0
  for (const raw of lines) {
    if (!raw) continue
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    if (ROW.test(raw)) {
      rowLines++
      if (ev.kind === 'selfWho') {
        claimed++
        assert.match(raw, /\] Primitive /, `claimed a row that is not the player's: ${raw}`)
      }
    }
  }
  assert.ok(rowLines >= 421, `/who row floor: got ${rowLines}`)
  assert.ok(claimed >= 11 && claimed < rowLines, `claimed ${claimed} of ${rowLines} rows`)
})
