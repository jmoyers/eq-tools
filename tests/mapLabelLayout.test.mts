// The map viewer's LABEL DECLUTTER (src/renderer/src/features/maps/labelLayout.ts) — the
// boundary between "the pack ships 320 labels for this zone" and "you can read this map".
//
// WHY THIS BOUNDARY EXISTS. Drawing every label at fit zoom makes a dense zone a wall of text
// (the reported case is 'The Ruins of Old Paineel'; `brewall\poknowledge_1.txt` is the measured
// worst at 320 points). The fix is the Mapbox/MapLibre model — screen-space collision boxes,
// greedy placement in priority order — and it has three failure modes that look fine in a
// screenshot and are wrong in use:
//
//   * THE WRONG LABEL WINS. If the ranking is not deliberate, the label the collision keeps is
//     whichever one the file happened to list first, and 'to Highpass Hold' loses to a rock.
//   * LABELS SWAP WHILE YOU PAN. If anything screen-derived enters the ranking, a one-pixel pan
//     reorders placement and the map shimmers. MapLibre spends a whole CrossTileSymbolIndex on
//     this; our cheap version is "rank from the data only", and it is pinned below.
//   * A DROPPED LABEL TAKES ITS POI WITH IT. Hiding the text must never hide the point — it
//     becomes a dot (Google Maps' icon-without-text tier), and an out-of-band point must not
//     BLOCK an in-band one, or the floor filter would silently thin the floor you selected.
//
// Arithmetic only — no React, no DOM, no font metrics — so this suite NEVER skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  labelBox,
  labelKind,
  labelRank,
  layoutLabels,
  type LabelItem
} from '../src/renderer/src/features/maps/labelLayout'
import type { MapPoint } from '../src/shared/maps'

function point(display: string, size: 1 | 2 | 3 = 2, z = 0): MapPoint {
  return {
    x: 0,
    y: 0,
    z,
    r: 0,
    g: 0,
    b: 0,
    size,
    label: display.replace(/ /g, '_'),
    display,
    layer: 1
  }
}

function item(index: number, display: string, px: number, py: number): LabelItem {
  return { index, point: point(display), px, py, inBand: true }
}

function shownLabels(slots: readonly { shown: boolean; point: MapPoint }[]): string[] {
  return slots.filter((s) => s.shown).map((s) => s.point.display)
}

test('the label kinds come from Brewall’s own affixes, and an unknown label is generic', () => {
  assert.equal(labelKind('to Highpass Hold'), 'connection')
  assert.equal(labelKind('Gnasher (Hunter)'), 'named')
  assert.equal(labelKind('Grimfeather (Named)'), 'named')
  assert.equal(labelKind('Kaligia Sotoll (Merchant)'), 'service')
  assert.equal(labelKind('Guild Master'), 'service')
  assert.equal(labelKind('a wooden bridge'), 'generic')
  // 'Torto' merely CONTAINS 'to' — the prefix is anchored and word-bounded, or half the corpus
  // would claim to be a zone connection.
  assert.equal(labelKind('Tortoise Pond'), 'generic')
})

test('the size class is the major rank key and the kind is the minor one', () => {
  // Within one size class, wayfinding beats people beats services beats scenery.
  assert.ok(labelRank(point('to Kithicor', 3)) < labelRank(point('Sir Lucan (Named)', 3)))
  assert.ok(labelRank(point('Sir Lucan (Named)', 3)) < labelRank(point('a banker', 3)))
  assert.ok(labelRank(point('a banker', 3)) < labelRank(point('a bridge', 3)))
  // Across size classes the FILE wins: the mapmaker reserved size 3 for what matters.
  assert.ok(labelRank(point('a bridge', 3)) < labelRank(point('to Kithicor', 2)))
  assert.ok(labelRank(point('a bridge', 2)) < labelRank(point('to Kithicor', 1)))
})

test('a wider box is claimed by a longer label and by a larger size class', () => {
  assert.ok(labelBox(point('Ambassador DVinn')).w > labelBox(point('Guk')).w)
  assert.ok(labelBox(point('Guk', 3)).w > labelBox(point('Guk', 1)).w)
  assert.ok(labelBox(point('Guk', 3)).h > labelBox(point('Guk', 1)).h)
})

test('stacked labels collide and the higher-priority one keeps the space', () => {
  const slots = layoutLabels([item(0, 'a rusty gate', 100, 100), item(1, 'to Befallen', 100, 100)])
  assert.deepEqual(shownLabels(slots), ['to Befallen'])
})

test('labels far enough apart all survive — the declutter drops nothing it need not', () => {
  const slots = layoutLabels([item(0, 'north', 0, 0), item(1, 'south', 0, 400), item(2, 'east', 600, 0)])
  assert.equal(shownLabels(slots).length, 3)
})

test('the result is in INPUT order, so React keys and the DOM never churn on a pan', () => {
  const slots = layoutLabels([item(0, 'a rusty gate', 100, 100), item(1, 'to Befallen', 100, 100)])
  assert.deepEqual(
    slots.map((s) => s.index),
    [0, 1]
  )
})

test('the ranking is data-only: panning every label by the same delta changes nothing', () => {
  const base = [item(0, 'a rusty gate', 100, 100), item(1, 'to Befallen', 108, 103), item(2, 'a lever', 300, 100)]
  const panned = base.map((i) => ({ ...i, px: i.px + 37.4, py: i.py - 11.2 }))
  assert.deepEqual(shownLabels(layoutLabels(panned)), shownLabels(layoutLabels(base)))
})

test('the ranking is order-independent: shuffling the input keeps the same survivors', () => {
  const base = [item(0, 'a rusty gate', 100, 100), item(1, 'to Befallen', 104, 100), item(2, 'a lever', 96, 102)]
  assert.deepEqual(shownLabels(layoutLabels([...base].reverse())).sort(), shownLabels(layoutLabels(base)).sort())
})

test('zoom IS the density control: the same points, further apart, fit more labels', () => {
  const at = (spread: number): LabelItem[] =>
    Array.from({ length: 8 }, (_, i) => item(i, `landmark ${String(i)}`, 200, 100 + i * spread))
  assert.ok(shownLabels(layoutLabels(at(30))).length > shownLabels(layoutLabels(at(4))).length)
})

test('an out-of-band label is never drawn as text and never BLOCKS an in-band one', () => {
  const off = { ...item(0, 'to Befallen', 100, 100), inBand: false }
  const on = item(1, 'a rusty gate', 100, 100)
  const slots = layoutLabels([off, on])
  // The higher-priority label would have won the space outright had it been in band.
  assert.deepEqual(shownLabels(slots), ['a rusty gate'])
})

test('a dropped label keeps its point: every input comes back with a position to draw a dot at', () => {
  const slots = layoutLabels([item(0, 'a rusty gate', 100, 100), item(1, 'to Befallen', 100, 100)])
  assert.equal(slots.length, 2)
  for (const s of slots) {
    assert.equal(typeof s.px, 'number')
    assert.equal(typeof s.py, 'number')
    assert.ok(s.w > 0 && s.h > 0)
  }
})
