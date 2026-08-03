// Default overlay placement (Task #59 follow-up: UNIFORM default size).
//
// This is pure geometry — no log, no fixture, so it never skips. It pins the two properties the
// first-open layout has to have on any display, and the one product rule behind them:
//   1. EVERY kind opens at the SAME width x height (user decision). No per-kind sizes.
//   2. The reserved slots never overlap and never leave the work area — with uniform sizes the
//      bottom-right stack wraps into a new column instead of running off the top of the screen.
// Persisted bounds are not exercised here: they short-circuit this module entirely in
// createOverlayWindow (index.ts prefers `cfg.bounds` and only calls in here when there are none).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultOverlayBounds, overlayDefaultSize, type Bounds } from '../src/main/overlayLayout'
import { OVERLAY_KINDS } from '../src/shared/types'

/** Work areas worth proving: a 1080p desktop with a taskbar, a tall 1440p, a small laptop, and a
 *  non-zero-origin display (a second monitor left of the primary). */
const WORK_AREAS: Record<string, Bounds> = {
  '1080p': { x: 0, y: 0, width: 1920, height: 1040 },
  '1440p': { x: 0, y: 0, width: 2560, height: 1400 },
  'small laptop': { x: 0, y: 0, width: 1366, height: 728 },
  'offset display': { x: -1920, y: 120, width: 1920, height: 960 }
}

const overlaps = (a: Bounds, b: Bounds): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

test('every overlay kind opens at ONE uniform default size', () => {
  const sizes = OVERLAY_KINDS.map((k) => overlayDefaultSize(k))
  const first = sizes[0]
  assert.ok(OVERLAY_KINDS.length >= 5, 'all five kinds are still registered')
  for (const [i, s] of sizes.entries()) {
    assert.deepEqual(s, first, `${OVERLAY_KINDS[i]} must use the uniform size`)
  }
  // Erring slightly larger than every per-kind size this replaced (the largest was 360x300), so
  // the event log — the only kind that is a list rather than dense bars — is not cramped.
  assert.ok(first.width >= 360, `width ${first.width} must not be smaller than the old event log`)
  assert.ok(first.height >= 300, `height ${first.height} must not be smaller than the old event log`)
})

test('the reserved slots never overlap and stay inside the work area', () => {
  for (const [name, wa] of Object.entries(WORK_AREAS)) {
    const placed = OVERLAY_KINDS.map((k) => defaultOverlayBounds(k, wa))
    for (const [i, b] of placed.entries()) {
      assert.equal(b.width, overlayDefaultSize(OVERLAY_KINDS[i]).width)
      assert.equal(b.height, overlayDefaultSize(OVERLAY_KINDS[i]).height)
      assert.ok(b.x >= wa.x, `${name}/${OVERLAY_KINDS[i]}: off the left edge`)
      assert.ok(b.y >= wa.y, `${name}/${OVERLAY_KINDS[i]}: off the top edge`)
      assert.ok(b.x + b.width <= wa.x + wa.width, `${name}/${OVERLAY_KINDS[i]}: off the right edge`)
      assert.ok(b.y + b.height <= wa.y + wa.height, `${name}/${OVERLAY_KINDS[i]}: off the bottom edge`)
    }
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        assert.ok(
          !overlaps(placed[i], placed[j]),
          `${name}: ${OVERLAY_KINDS[i]} overlaps ${OVERLAY_KINDS[j]} (${JSON.stringify(placed[i])} vs ${JSON.stringify(placed[j])})`
        )
      }
    }
  }
})

test('the first kind docks to the bottom-right corner, and the stack walks upward from it', () => {
  const wa = WORK_AREAS['1080p']
  const [first, second] = [defaultOverlayBounds(OVERLAY_KINDS[0], wa), defaultOverlayBounds(OVERLAY_KINDS[1], wa)]
  assert.equal(first.x + first.width, wa.x + wa.width - 16, 'right margin')
  assert.equal(first.y + first.height, wa.y + wa.height - 16, 'bottom margin')
  assert.equal(second.x, first.x, 'the second slot is in the same column')
  assert.ok(second.y < first.y, 'the stack grows upward')
})

test('a full column wraps LEFT rather than off the top of the screen', () => {
  // Deliberately short: only two uniform slots fit vertically, so the five kinds must spill into
  // additional columns. This is the case the old modulo wrap got wrong (it could overlap).
  const wa: Bounds = { x: 0, y: 0, width: 2000, height: 700 }
  const placed = OVERLAY_KINDS.map((k) => defaultOverlayBounds(k, wa))
  const columns = new Set(placed.map((b) => b.x))
  assert.ok(columns.size > 1, 'a short work area must use more than one column')
  for (const b of placed) {
    assert.ok(b.y >= wa.y && b.y + b.height <= wa.y + wa.height, 'still on-screen vertically')
  }
})
