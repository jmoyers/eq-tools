// Pure unit tests for the class-combo UI's two pure layers:
//
//   * src/renderer/src/features/leveling/comboAdapter.ts — the ONE reconciliation between the
//     combo MODEL's interval (candidate sets, provenance, `endTs: null` for the open one) and
//     the thinner `ComboInterval` that `shared/progressionStats` declared for itself. The name
//     collision is real and deliberate; this file is where it is pinned.
//   * src/renderer/src/features/profiles/ClassComboLabels.ts — the wording. Every honesty rule
//     the surface has is ultimately a formatting decision:
//       1. an AMBIGUOUS slot prints its candidate SET (`CLR|PAL`) and never picks a member —
//          the real log has spans where CLR is never exclusively evidenced, so "PAL" there
//          would be fabricated;
//       2. an UNKNOWN slot prints an em-dash — not a class, not a blank, not a zero;
//       3. a fuzzy boundary prints a WINDOW, because a loadout swap writes nothing to the log
//          and the events bracketing it can be a day and a half apart.
//
// No log, no fixture, no DOM — so this file never skips. Imported RELATIVELY: node tests run
// through tsx with no `@shared` / `@renderer` aliases (which is also why the modules under test
// take only TYPE imports from `@shared`).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  comboSource,
  EMPTY_COMBO_SOURCE
} from '../src/renderer/src/features/leveling/comboAdapter'
import {
  ALL_CLASSES,
  NONE,
  boundaryReasonLabel,
  comboLabel,
  confidenceText,
  hasInferredSlot,
  intervalProvenance,
  levelRangeText,
  slotKind,
  slotLabel,
  startFuzzMs,
  startFuzzText
} from '../src/renderer/src/features/profiles/ClassComboLabels'
import {
  CLASS_ABBRS,
  type ClassAbbr,
  type ComboInterval,
  type ComboProvenance,
  type ComboSlot
} from '../src/shared/classCombo'

const HOUR = 3_600_000
const T0 = Date.parse('Fri Jul 31 16:00:00 2026')

function slot(candidates: ClassAbbr[], provenance: ComboProvenance = 'inferred'): ComboSlot {
  return { candidates, confidence: candidates.length === 1 ? 0.75 : 0.3, provenance, because: [] }
}

/** An interval with every field defaulted, so each test states only what it is about. */
function interval(over: Partial<ComboInterval> & { id: string }): ComboInterval {
  const startTs = over.startTs ?? T0
  const base: ComboInterval = {
    id: over.id,
    startTs,
    endTs: null,
    // An exact boundary by default — the fuzzy cases say so explicitly.
    startLo: startTs,
    startHi: startTs,
    endLo: null,
    endHi: null,
    startReason: 'logStart',
    expectedSlots: 3,
    slots: [slot(['PAL']), slot(['ROG']), slot(['BER'])],
    levelLo: null,
    levelHi: null,
    evidenceCount: 0,
    userLocked: false
  }
  return { ...base, ...over }
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

test('ALL_CLASSES matches the real roster size (the literal is a test-import workaround)', () => {
  assert.equal(ALL_CLASSES, CLASS_ABBRS.length)
})

test('a resolved slot prints its abbreviation', () => {
  assert.equal(slotKind(slot(['PAL'])), 'resolved')
  assert.equal(slotLabel(slot(['PAL'])), 'PAL')
})

test('an ambiguous slot prints the SET and never picks a member', () => {
  const s = slot(['CLR', 'PAL'])
  assert.equal(slotKind(s), 'ambiguous')
  assert.equal(slotLabel(s), 'CLR|PAL')
  // The measured {CLR,PAL} case: resolving it to PAL is the exact lie this rule prevents.
  assert.ok(!/^PAL$/.test(slotLabel(s)))
})

test('an unknown slot prints an em-dash — empty and whole-roster both', () => {
  assert.equal(slotKind(slot([])), 'unknown')
  assert.equal(slotLabel(slot([])), NONE)
  assert.equal(slotKind(slot([...CLASS_ABBRS])), 'unknown')
  assert.equal(slotLabel(slot([...CLASS_ABBRS])), NONE)
})

test('comboLabel keeps slot order and mixes the three kinds honestly', () => {
  const i = interval({ id: 'ci1', slots: [slot(['PAL']), slot(['CLR', 'PAL']), slot([])] })
  assert.equal(comboLabel(i), `PAL / CLR|PAL / ${NONE}`)
})

test('provenance takes the strongest slot, and any inferred slot is reported', () => {
  const mixed = interval({ id: 'ci1', slots: [slot(['PAL'], 'who'), slot(['ROG'], 'inferred')] })
  assert.equal(intervalProvenance(mixed), 'who')
  assert.equal(hasInferredSlot(mixed), true)
  const corrected = interval({ id: 'ci2', slots: [slot(['PAL'], 'user'), slot(['ROG'], 'who')] })
  assert.equal(intervalProvenance(corrected), 'user')
  assert.equal(hasInferredSlot(corrected), false)
})

test('an exact boundary has no ~ annotation; a fuzzy one states its window', () => {
  const exact = interval({ id: 'ci1' })
  assert.equal(startFuzzMs(exact), 0)
  assert.equal(startFuzzText(exact), null)

  // The real Aug 2 swap: bracketed by two level dings 33.9 h apart.
  const fuzzy = interval({
    id: 'ci2',
    startTs: T0 + 20 * HOUR,
    startLo: T0,
    startHi: T0 + 34 * HOUR,
    startReason: 'levelDrop',
    startAlso: ['evidenceShift']
  })
  assert.equal(startFuzzMs(fuzzy), 34 * HOUR)
  const text = startFuzzText(fuzzy) ?? ''
  assert.match(text, /34h 0m/) // the window is stated as a DURATION, not implied
  assert.match(text, /level dropped/)
  assert.match(text, /classes showing up in the log changed/)
})

test('every boundary reason has prose — no raw enum reaches the UI', () => {
  for (const reason of ['who', 'levelDrop', 'evidenceShift', 'overDetermined', 'user', 'logStart'] as const) {
    const label = boundaryReasonLabel(reason)
    assert.ok(label.length > 0)
    assert.notEqual(label, reason)
  }
})

test('confidence and level range read as the panel prints them', () => {
  assert.equal(confidenceText(0.75), '75%')
  assert.equal(confidenceText(0), '0%')
  assert.equal(levelRangeText(interval({ id: 'ci1' })), null)
  assert.equal(levelRangeText(interval({ id: 'ci2', levelLo: 50, levelHi: 50 })), 'level 50')
  assert.equal(levelRangeText(interval({ id: 'ci3', levelLo: 11, levelHi: 24 })), 'levels 11–24')
})

// ---------------------------------------------------------------------------
// the adapter
// ---------------------------------------------------------------------------

test('the empty seam answers empty, never null-shaped garbage', () => {
  assert.equal(EMPTY_COMBO_SOURCE.comboAt(T0), null)
  assert.deepEqual(EMPTY_COMBO_SOURCE.intervalsIn(T0, T0 + HOUR), [])
  assert.deepEqual(comboSource([]).intervalsIn(T0, T0 + HOUR), [])
})

test('a model interval reduces to the thin shape rangeStats declared', () => {
  const src = comboSource([
    interval({
      id: 'ci1',
      startTs: T0,
      endTs: T0 + 2 * HOUR,
      slots: [slot(['PAL'], 'who'), slot(['CLR', 'PAL'], 'inferred'), slot([], 'inferred')]
    })
  ])
  const [row] = src.intervalsIn(T0, T0 + 2 * HOUR)
  assert.deepEqual(row.classes, ['PAL', 'CLR|PAL', NONE])
  assert.equal(row.inferred, true)
  assert.equal(row.startTs, T0)
  assert.equal(row.endTs, T0 + 2 * HOUR)
})

test('inferred is false only when NO slot is still inference', () => {
  const stated = comboSource([
    interval({ id: 'ci1', endTs: T0 + HOUR, slots: [slot(['PAL'], 'who'), slot(['ROG'], 'user')] })
  ])
  assert.equal(stated.intervalsIn(T0, T0 + HOUR)[0].inferred, false)
})

test('intervalsIn clips to the query window, both edges', () => {
  const src = comboSource([
    interval({ id: 'ci1', startTs: T0, endTs: T0 + 4 * HOUR }),
    interval({ id: 'ci2', startTs: T0 + 4 * HOUR, endTs: T0 + 8 * HOUR })
  ])
  const rows = src.intervalsIn(T0 + 2 * HOUR, T0 + 6 * HOUR)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].startTs, T0 + 2 * HOUR)
  assert.equal(rows[0].endTs, T0 + 4 * HOUR)
  assert.equal(rows[1].startTs, T0 + 4 * HOUR)
  assert.equal(rows[1].endTs, T0 + 6 * HOUR)
})

test('an interval that does not overlap the window is omitted, not zero-width', () => {
  const src = comboSource([interval({ id: 'ci1', startTs: T0, endTs: T0 + HOUR })])
  assert.deepEqual(src.intervalsIn(T0 + HOUR, T0 + 2 * HOUR), [])
  assert.deepEqual(src.intervalsIn(T0 - 2 * HOUR, T0), [])
})

test('the OPEN interval is clipped to the query end, never fabricated', () => {
  const src = comboSource([interval({ id: 'ci1', startTs: T0, endTs: null })])
  const [row] = src.intervalsIn(T0, T0 + 3 * HOUR)
  assert.equal(row.endTs, T0 + 3 * HOUR)
  // comboAt has no window to clip against, so it says "no end stated" rather than inventing one.
  const at = src.comboAt(T0 + 100 * HOUR)
  assert.equal(at?.endTs, Number.POSITIVE_INFINITY)
})

test('comboAt picks the interval whose ESTIMATE covers ts, and nothing before the first', () => {
  const src = comboSource([
    interval({ id: 'ci1', startTs: T0, endTs: T0 + 2 * HOUR, slots: [slot(['PAL'])] }),
    interval({ id: 'ci2', startTs: T0 + 2 * HOUR, endTs: T0 + 4 * HOUR, slots: [slot(['ENC'])] })
  ])
  assert.equal(src.comboAt(T0 - 1), null)
  assert.deepEqual(src.comboAt(T0)?.classes, ['PAL'])
  assert.deepEqual(src.comboAt(T0 + 2 * HOUR)?.classes, ['ENC'])
  // Past the last CLOSED interval nothing is known — a gap is a gap, not the nearest neighbour.
  assert.equal(src.comboAt(T0 + 5 * HOUR), null)
})
