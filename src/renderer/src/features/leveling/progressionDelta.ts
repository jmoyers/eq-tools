// progressionDelta.ts — the renderer half of the `progression` module's delta contract.
//
// Split out of LevelingView.tsx because the contract is subtle enough to deserve its own
// documented file (and the view sits near the measured 400-code-line factoring ceiling).
// Pure: state in, state out, no React.
//
// THE CONTRACT (src/shared/progressionTypes.ts + src/main/modules/progression.ts), in the
// exact order it must be applied:
//
//   1. `zoneCloseEnd` — the ONE in-place edit. When a new zone line closed an interval the
//      consumer ALREADY holds, main sends the new end here instead of resending the row.
//      It targets the last interval in the CURRENT state, so it must be applied BEFORE the
//      appended slices land. (Intervals appended within this same flush already carry their
//      correct `zoneEnd`; main patches those in the pending slice itself.)
//   2. APPEND every column's slice.
//   3. `dropFront.<col>` — splice that many leading entries off each CAPPED column group,
//      AFTER appending. Order matters: main pushes into the live column and only then trims
//      it, so a single flush can append 5k rows and drop 1k of the combined array. Splicing
//      first would drop off a shorter array and leave the two sides permanently out of step.
//      (Front-drops and back-appends commute, which is what makes "append then splice"
//      exactly reproduce main's interleaving.)
//   4. Scalars (`lastTs`, `windowStart`, `dropped`) REPLACE — never accumulate.
//
// `levelTs/levelValue/aaGainTs/aaGainAmount` are UNCAPPED (~5k rows/year) and so are a plain
// concat with no drop bookkeeping at all.

import type { ProgressionDelta, ProgressionSnap } from '@shared/types'

export const EMPTY_PROGRESSION: ProgressionSnap = {
  expTs: [], expPct: [], expFlag: [],
  killTs: [], killZone: [], killCredit: [],
  witnessTs: [],
  lootTs: [],
  zoneStart: [], zoneEnd: [], zoneName: [],
  levelTs: [], levelValue: [], aaGainTs: [], aaGainAmount: [],
  lastTs: 0, windowStart: 0, dropped: 0
}

/** Append then front-drop, in that order (see step 3 of the contract above). */
function cat<T>(held: readonly T[], added: readonly T[], dropFront: number): T[] {
  const out = [...held, ...added]
  return dropFront > 0 ? out.slice(dropFront) : out
}

export function applyProgressionDelta(s: ProgressionSnap, d: ProgressionDelta): ProgressionSnap {
  // 1. close the interval we already hold, before anything is appended to the column.
  const zoneEnd = [...s.zoneEnd]
  if (d.zoneCloseEnd !== undefined && zoneEnd.length > 0) zoneEnd[zoneEnd.length - 1] = d.zoneCloseEnd

  const drop = d.dropFront
  const killZone = cat(s.killZone, d.killZone, drop.kill)
  if (drop.zone > 0) {
    // `killZone` indexes `zoneName`, so a zone front-drop shifts every one of them; a kill
    // whose zone aged out becomes -1 (unknown), never a WRONG zone — the same clamp main
    // applies. A blanket shift is an approximation when a drop lands mid-flush (kills pushed
    // after it were already recorded in the post-drop frame), and that is acceptable for
    // exactly the reason the field is documented ADVISORY: `rangeStats` attributes every
    // sample by TIMESTAMP against the zone intervals, so a skew here cannot move a number.
    // It also takes 4000+ zone intervals — roughly 70 days of this user's play — to occur.
    for (let i = 0; i < killZone.length; i++) killZone[i] = Math.max(-1, killZone[i] - drop.zone)
  }

  return {
    expTs: cat(s.expTs, d.expTs, drop.exp),
    expPct: cat(s.expPct, d.expPct, drop.exp),
    expFlag: cat(s.expFlag, d.expFlag, drop.exp),
    killTs: cat(s.killTs, d.killTs, drop.kill),
    killZone,
    killCredit: cat(s.killCredit, d.killCredit, drop.kill),
    witnessTs: cat(s.witnessTs, d.witnessTs, drop.witness),
    lootTs: cat(s.lootTs, d.lootTs, drop.loot),
    zoneStart: cat(s.zoneStart, d.zoneStart, drop.zone),
    zoneEnd: cat(zoneEnd, d.zoneEnd, drop.zone),
    zoneName: cat(s.zoneName, d.zoneName, drop.zone),
    levelTs: [...s.levelTs, ...d.levelTs],
    levelValue: [...s.levelValue, ...d.levelValue],
    aaGainTs: [...s.aaGainTs, ...d.aaGainTs],
    aaGainAmount: [...s.aaGainAmount, ...d.aaGainAmount],
    lastTs: d.lastTs,
    windowStart: d.windowStart,
    dropped: d.dropped
  }
}
