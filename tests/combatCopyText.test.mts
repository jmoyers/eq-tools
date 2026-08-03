// COPY-OUT: the plain text a user pastes into guild chat IS a spec, so these are goldens.
//
// `src/renderer/src/features/combat/copyText.ts` serializes whatever the combat panel is
// currently showing — the ranked source meter, one source's skill list, one mob's skill list,
// or the Damage-by-mob card — as plain text. Every assertion below is the EXACT string, because
// the value of this feature is entirely in its shape: column alignment that survives a paste,
// a width that no chat client re-wraps, no markdown for a destination to mangle, and the app's
// own number formatting so a pasted '45.2k' reads like the meter it came from.
//
// These are pure derivations over already-aggregated data (the same territory as
// combatSlayGrouping), so the window is SYNTHETIC — one hand-built segment carrying every
// optional dimension at once (crits, avoided swings, resists, a pet, a slay group, enemy heals,
// incoming healers, an estimated event ring) plus the degenerate empties. There is no log line
// to hand-read here, only arithmetic and layout.
//
// The honesty laws are asserted, not assumed:
//   - a column NEVER exists for data the segment doesn't have (no '100%' Hit column on a fight
//     where nothing was avoided);
//   - ring-derived numbers keep their '~' prefix, and an observed Max never wears one (it is a
//     lower bound, not a scaled estimate) — see dashboardData.ts's header;
//   - nothing anywhere exceeds MAX_WIDTH.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_WIDTH,
  formatEntityText,
  formatMobsText,
  formatSegmentText,
  formatTargetText
} from '../src/renderer/src/features/combat/copyText'
import type { MobBreakdown, SkillRow, TargetDetail } from '../src/renderer/src/features/combat/dashboardData'
import type { CategoryView, SegmentView, SkillView, SourceView } from '../src/shared/combat'

// ── fixtures ────────────────────────────────────────────────────────────────────────

function skill(name: string, over: Partial<SkillView> = {}): SkillView {
  return { name, total: 0, pct: 0, hits: 0, crits: 0, max: 0, ...over }
}

function cat(category: CategoryView['category'], skills: SkillView[]): CategoryView {
  return {
    category,
    total: skills.reduce((n, s) => n + s.total, 0),
    pct: 100,
    hits: skills.reduce((n, s) => n + s.hits, 0),
    crits: skills.reduce((n, s) => n + s.crits, 0),
    critPct: 0,
    max: Math.max(0, ...skills.map((s) => s.max)),
    resists: skills.reduce((n, s) => n + (s.resists ?? 0), 0),
    resistPct: 0,
    skills
  }
}

function source(over: Partial<SourceView>): SourceView {
  return {
    id: 'x',
    name: 'x',
    kind: 'you',
    total: 0,
    dps: 0,
    pct: 100,
    hits: 0,
    crits: 0,
    critPct: 0,
    ambiguousHits: 0,
    ambiguousTotal: 0,
    misses: 0,
    hitPct: 100,
    missBreakdown: { miss: 0, dodge: 0, parry: 0, riposte: 0, block: 0, absorb: 0 },
    resists: 0,
    resistPct: 0,
    skills: [],
    categories: [],
    ...over
  }
}

/** You: melee + a two-weapon Slay Undead proc + one spell that got resisted twice. */
const YOU = source({
  id: 'you',
  name: 'You',
  kind: 'you',
  total: 31200,
  dps: 375,
  hits: 260,
  crits: 31,
  critPct: 11.9,
  misses: 57,
  hitPct: 82,
  resists: 2,
  resistPct: 28.6,
  categories: [
    cat('melee', [skill('Melee', { total: 21200, hits: 210, crits: 23, max: 412, min: 12, misses: 45 })]),
    cat('slay', [
      skill('Melee', { total: 3200, hits: 30, crits: 6, max: 300, min: 40, misses: 9 }),
      skill('Backstab', { total: 2800, hits: 15, crits: 2, max: 500, min: 60, misses: 3 })
    ]),
    cat('spell', [skill('Ancient Wrath', { total: 4000, hits: 5, crits: 0, max: 900, min: 700, resists: 2 })])
  ],
  rounds: { totalRounds: 186, avgHitsPerRound: 1.29, maxHitsInRound: 3, multiHitRounds: 41, histogram: [145, 37, 4] }
})

/** A summoned pet — the row that must wear a '(pet)' tag and carries no crits. */
const PET = source({
  id: 'pet:vebarn',
  name: 'Vebarn',
  kind: 'pet',
  total: 9030,
  dps: 108,
  hits: 120,
  crits: 0,
  critPct: 0,
  misses: 36,
  hitPct: 76.9,
  categories: [cat('melee', [skill('Melee', { total: 9030, hits: 120, max: 180, min: 8, misses: 36 })])]
})

/** A grouped ally: no avoided swings, no crits, no resists — every optional CELL empty. */
const ALLY = source({
  id: 'other:grinn',
  name: 'Grinn Frostbeard',
  kind: 'you',
  total: 5000,
  dps: 60,
  hits: 40,
  categories: [cat('melee', [skill('Melee', { total: 5000, hits: 40, max: 260, min: 30 })])]
})

const SEG: SegmentView = {
  id: 'f1',
  kind: 'fight',
  name: 'a deadly black widow +2',
  durationSec: 83,
  active: false,
  activeSec: 70,
  outTotal: 45230,
  outDps: 545,
  activeDps: 646,
  entities: [YOU, PET, ALLY],
  inTotal: 3200,
  inDps: 39,
  incoming: [
    source({ id: 'e1', name: 'a deadly black widow (7)', kind: 'enemy', total: 2400, dps: 29, hits: 60, crits: 4, critPct: 6.7 }),
    source({ id: 'e2', name: 'a deadly black widow (8)', kind: 'enemy', total: 800, dps: 10, hits: 20 })
  ],
  enemyHealTotal: 1200,
  incomingHealTotal: 2100,
  incomingHealers: [
    { name: 'Grinn Frostbeard', total: 1800, count: 6 },
    { name: 'You', total: 300, count: 2 }
  ],
  healing: { total: 0, restoredTotal: 0, absorbedTotal: 0, sources: [] } as unknown as SegmentView['healing']
}

function row(name: string, over: Partial<SkillRow> = {}): SkillRow {
  return { name, category: 'melee', total: 0, pct: 100, hits: 0, crits: 0, max: 0, ...over }
}

/** A DOWNSAMPLED per-mob drill — every derived number here is an estimate. */
const TARGET: TargetDetail = {
  rows: [
    row('Melee', { total: 7400, hits: 92, crits: 9, max: 412, min: 12, misses: 21 }),
    row('Slay Undead', { category: 'slay', total: 2600, hits: 24, crits: 4, max: 500, min: 40, misses: 6 }),
    row('Ancient Wrath', { category: 'spell', total: 2000, hits: 2, max: 900, min: 700, resists: 1 })
  ],
  total: 12000,
  hits: 118,
  crits: 13,
  misses: 27,
  resists: 1,
  estimated: true
}

const MOBS: MobBreakdown = {
  rows: [
    { target: 'a deadly black widow (7)', total: 24000, hits: 210, crits: 22, misses: 40, resists: 1, pct: 100, share: 53 },
    { target: 'a deadly black widow (8)', total: 16000, hits: 150, crits: 14, misses: 28, resists: 0, pct: 66.7, share: 35.4 },
    { target: 'a vampire bat', total: 4000, hits: 40, crits: 3, misses: 9, resists: 0, pct: 16.7, share: 8.8 },
    { target: 'a zol ghoul knight', total: 1230, hits: 12, crits: 0, misses: 2, resists: 0, pct: 5.1, share: 2.7 }
  ],
  total: 45230,
  estimated: false
}

/** An empty fight — the honest degenerate case (a pull that opened on a miss). */
const EMPTY: SegmentView = {
  ...SEG,
  name: 'a vampire bat',
  durationSec: 7,
  activeSec: 0,
  outTotal: 0,
  outDps: 0,
  activeDps: 0,
  entities: [],
  inTotal: 0,
  inDps: 0,
  incoming: [],
  enemyHealTotal: 0,
  incomingHealTotal: 0,
  incomingHealers: []
}

/** Every line of every block must fit the paste width — asserted on each golden below. */
function fits(text: string): boolean {
  return text.split('\n').every((l) => l.length <= MAX_WIDTH)
}

// ── level 1: the ranked source meter ────────────────────────────────────────────────

test('formatSegmentText (outgoing) is the meter header + the ranked source table', () => {
  const text = formatSegmentText(SEG, 'out')
  assert.equal(
    text,
    [
      'a deadly black widow +2 · 1:23',
      'Outgoing damage · 45.2k · 545 dps (act 646 dps) · +1.2k enemy heal',
      '',
      '   Source            Total      DPS  Crit  Hit  Resist',
      '1  You               31.2k  375 dps   12%  82%     29%',
      // The pet wears its tag; its empty Crit cell is EMPTY, not '0%' — and the row is
      // right-trimmed, so no invisible padding travels with the paste.
      '2  Vebarn (pet)       9.0k  108 dps        77%',
      // Nothing was avoided against this source and it never crit: both cells stay blank
      // rather than claiming a 100% hit rate the meter itself declines to show.
      '3  Grinn Frostbeard   5.0k   60 dps'
    ].join('\n')
  )
  assert.ok(fits(text))
})

test('formatSegmentText (incoming) uses the incoming totals and appends the heal footer', () => {
  const text = formatSegmentText(SEG, 'in')
  assert.equal(
    text,
    [
      'a deadly black widow +2 · 1:23',
      // Incoming carries NO active-dps and NO enemy-heal note — both are outgoing-only claims.
      'Incoming damage · 3.2k · 39 dps',
      '',
      '   Attacker                  Total     DPS  Crit',
      '1  a deadly black widow (7)   2.4k  29 dps    7%',
      '2  a deadly black widow (8)    800  10 dps',
      '',
      'Heals received: 2.1k',
      '  Grinn Frostbeard · 1.8k (6)',
      '  You · 300 (2)'
    ].join('\n')
  )
  assert.ok(fits(text))
})

// ── level 2: one source ─────────────────────────────────────────────────────────────

test('formatEntityText is the flat skill list, slay grouped, with the rounds footer', () => {
  const text = formatEntityText(SEG, YOU)
  assert.equal(
    text,
    [
      'You — a deadly black widow +2 · 1:23',
      '31.2k · 375 dps · 260 hits · 12% crit · 82% hit · 29% resist',
      '',
      'Skill          Total  Hits  Avg  Max  Crit  Miss  Resist',
      'Melee          21.2k   210  101  412   11%   18%',
      // The two slay weapons arrive as ONE row (groupSlay), exactly as the panel lists them:
      // 3.2k+2.8k over 45 hits, max 500 across both weapons.
      'Slay Undead     6.0k    45  133  500   18%   21%',
      // A spell lane has no avoided swings, so its Miss cell is blank while its Resist isn't.
      'Ancient Wrath   4.0k     5  800  900                 29%',
      '',
      'Melee rounds: 186 · avg 1.29 hits/round · 41 multi-hit · up to 3/round'
    ].join('\n')
  )
  assert.ok(fits(text))
})

test('formatEntityText omits every column the source has no data for', () => {
  const text = formatEntityText(SEG, ALLY)
  assert.equal(
    text,
    [
      'Grinn Frostbeard — a deadly black widow +2 · 1:23',
      '5.0k · 60 dps · 40 hits',
      '',
      // No Crit / Miss / Resist columns exist at all here — an absent dimension is absent,
      // never a column of zeroes.
      'Skill  Total  Hits  Avg  Max',
      'Melee   5.0k    40  125  260'
    ].join('\n')
  )
  assert.ok(fits(text))
})

// ── level 2: one mob ────────────────────────────────────────────────────────────────

test('formatTargetText carries the ~ estimate prefix on every derived number but not on Max', () => {
  const text = formatTargetText(SEG, 'a deadly black widow (7)', TARGET)
  assert.equal(
    text,
    [
      'Damage to a deadly black widow (7) — a deadly black widow +2 · 1:23',
      // The stat run wraps on a separator rather than running past the paste width.
      '~12.0k · 27% of outgoing · ~118 hits · ~13 crit · ~27 avoided',
      '~1 resisted',
      'you + pet combined',
      '',
      'Skill          Total  Hits    Avg  Max  Crit  Miss  Resist',
      // Max is the ONE unprefixed column: an observed maximum is a lower bound, not a scaled
      // estimate, so wearing a '~' would claim it had been adjusted.
      'Melee          ~7.4k   ~92    ~80  412  ~10%  ~19%',
      'Slay Undead    ~2.6k   ~24   ~108  500  ~17%  ~20%',
      'Ancient Wrath  ~2.0k    ~2  ~1.0k  900                ~33%',
      '',
      '~ = estimated: this fight kept only a sample of its events.'
    ].join('\n')
  )
  assert.ok(fits(text))
})

test('an exact per-mob drill wears no ~ anywhere and no estimate footer', () => {
  const text = formatTargetText(SEG, 'a vampire bat', { ...TARGET, estimated: false })
  assert.ok(!text.includes('~'), text)
  assert.ok(!text.includes('estimated'), text)
})

// ── the Damage-by-mob card ──────────────────────────────────────────────────────────

test('formatMobsText copies the rows the card LISTS and says what it left off', () => {
  const text = formatMobsText(SEG, MOBS, 3)
  assert.equal(
    text,
    [
      'Damage by mob — a deadly black widow +2 · 1:23',
      // The count is of ALL mobs (4) while the table shows the card's cap (3) — so the header
      // can never disagree with the '+N more' line below it.
      '4 mobs · 45.2k',
      '',
      '   Mob                       Total  Share  Hits  Crit  Avoided  Resist',
      '1  a deadly black widow (7)  24.0k    53%   210    22       40       1',
      '2  a deadly black widow (8)  16.0k    35%   150    14       28',
      '3  a vampire bat              4.0k     9%    40     3        9',
      '+1 more not shown'
    ].join('\n')
  )
  assert.ok(fits(text))
})

test('formatMobsText with no cap copies every row and claims nothing was left off', () => {
  const text = formatMobsText(SEG, MOBS)
  assert.ok(text.includes('4  a zol ghoul knight'), text)
  assert.ok(!text.includes('more not shown'), text)
})

// ── degenerate cases ────────────────────────────────────────────────────────────────

test('an empty segment says so instead of printing an empty table', () => {
  assert.equal(
    formatSegmentText(EMPTY, 'out'),
    ['a vampire bat · 0:07', 'Outgoing damage · 0 · 0 dps', 'No outgoing damage in this segment.'].join('\n')
  )
  assert.equal(
    formatSegmentText(EMPTY, 'in'),
    ['a vampire bat · 0:07', 'Incoming damage · 0 · 0 dps', 'No incoming damage in this segment.'].join('\n')
  )
})

test('a long fight name is clipped to the paste width — never the clock, never a number', () => {
  const long = { ...SEG, name: 'an ancient chromadrac guardian of the fourth seal +11' }
  const first = (t: string): string => t.split('\n')[0]
  assert.ok(fits(formatSegmentText(long, 'out')))
  assert.ok(first(formatSegmentText(long, 'out')).endsWith(' · 1:23'))
  const drill = formatTargetText(long, 'a deadly black widow (7)', TARGET)
  assert.ok(fits(drill), first(drill))
  assert.ok(first(drill).endsWith(' · 1:23'))
  assert.ok(first(drill).startsWith('Damage to a deadly black widow (7) — '))
})

test('nothing anywhere is markdown — a paste must not be re-rendered by its destination', () => {
  const blocks = [
    formatSegmentText(SEG, 'out'),
    formatSegmentText(SEG, 'in'),
    formatEntityText(SEG, YOU),
    formatTargetText(SEG, 'a deadly black widow (7)', TARGET),
    formatMobsText(SEG, MOBS, 3)
  ]
  for (const b of blocks) {
    assert.ok(!/[*_`|#]/.test(b), b)
    assert.ok(fits(b), b)
  }
})
