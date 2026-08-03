// progression module — the range-queryable time series behind the leveling analytics
// (docs/plans/leveling-analytics.md §3). Folds experience, CREDITED kills, witnessed kills,
// loot (an activity signal), the zone timeline and a mirror of the tiny level/AA series into
// ONE columnar snapshot, so `shared/progressionStats.rangeStats` has a single input.
//
// WHY NOT extend LevelingModule (leveling.ts stays byte-untouched):
//   1. DIFFERENT CAP POLICY. LevelingSnap is deliberately uncapped — the AA identity (law 5)
//      needs the whole history, and 81 levels + 139 AA gains over 6 days is nothing. This
//      series grows at ~1.7k rows/day and MUST be capped. Folding a drop-oldest ring into a
//      snapshot whose contract is "everything, forever" is a semantic trap.
//   2. DISJOINT OWNERSHIP. leveling.ts / levelSeries.ts untouched keeps the swap-series
//      golden tests (tests/levelingSwapWindows.test.mts) an unmodified regression gate.
// It duplicates the ~220 level/AA rows on purpose (cheap) but duplicates no DERIVATION — the
// AA identity stays in shared/aa.ts and is NOT what `aaGained` reports (see rangeStats).
//
// KILL CREDIT. `killTs` holds only kills the log attributes to YOU: your own killing blow
// (`You have slain X!`) plus a BOUND PET's (`X has been slain by <pet>!`). Measured post-epoch:
// 2999 self + 1111 bound-pet = 4110 credited against 4157 exp lines in the same span (98.9%) —
// a strong correlation, never an identity (group-mates' killing blows still pay party exp;
// grey kills pay nothing). The 954 THIRD-PARTY kills go to `witnessTs` and enter no rate, so a
// busy zone cannot silently inflate your farming numbers. `killer` starting with "you" is
// dropped as the de-dupe of the self shape, exactly as reducers.ts `isCountedKill` does.
//
// PET BINDING mirrors the combat engine (combat/ingest.ts), which is the repo's established
// semantics, with the ONE distinction a world-model-less module can still make (law 4):
// summoned pets persist across zones, charmed pets do not. So claims and charms are kept in
// two sets and a zone line clears only the charmed one. A charmed mob also sends the pet-claim
// tell, so a claim for a name already charmed is ignored rather than promoted to "summoned" —
// the same rule `world.claim()` applies when it leaves an already-charmed instance alone.

import type { EqModule } from './types'
import { idKey } from '../log/parser'
import type { LogEvent } from '../../shared/logEvents'
import type { ProgressionDelta, ProgressionDropFront, ProgressionSnap } from '../../shared/types'

/**
 * DROP-OLDEST CAPS — a retention FLOOR, not a hard length (see TRIM_BATCH). Precedent: the
 * combat engine's 8k event ring / 20 zone sessions / <1MB
 * payload). At these caps the columnar payload is ~124k numbers + ~4k short strings ≈ 1.2MB
 * structured-clone, covering ~24 days of this user's play. Deliberately NOT downsampled or
 * rolled into buckets: a mixed-resolution store makes every range query lie about its own
 * precision, and exact counts over a user-chosen window are the whole point. Drop-oldest with
 * a stated retention floor (`windowStart`) is the honest bound. Nothing is persisted — the
 * store is rebuilt from the log on every launch.
 */
export const EXP_CAP = 40_000
export const KILL_CAP = 40_000
export const WITNESS_CAP = 20_000
export const LOOT_CAP = 20_000
/** Zone bands are the cheapest and most valuable column (~344 intervals / 6 days ⇒ ~70 days). */
export const ZONE_CAP = 4_000

/** levelTs / aaGainTs are UNCAPPED (~5k rows/year; the chart needs every ding). */

function emptyDropFront(): ProgressionDropFront {
  return { exp: 0, kill: 0, witness: 0, loot: 0, zone: 0 }
}

/**
 * How much slack a full column is allowed before it is trimmed back to its cap. Trimming the
 * front of a 40k array costs a full memmove, so trimming on EVERY sample past the cap would
 * make a long historical replay O(samples × cap) — quadratic, and the replay budget is
 * "a full 68MB log in seconds". Batching makes it O(samples × cap / TRIM_BATCH) instead.
 * The consequence, and the reason the caps are documented as a retention FLOOR: a column can
 * transiently hold up to this many entries MORE than its cap. It never holds fewer.
 */
const TRIM_BATCH = 1024

/**
 * Drop-oldest across parallel columns that must stay index-aligned. Returns how many leading
 * entries went (0 while the column is still inside cap + TRIM_BATCH).
 */
function capColumns(cap: number, cols: unknown[][]): number {
  if (cols[0].length < cap + TRIM_BATCH) return 0
  const drop = cols[0].length - cap
  for (const col of cols) col.splice(0, drop)
  return drop
}

export class ProgressionModule implements EqModule<ProgressionSnap, ProgressionDelta> {
  readonly id = 'progression'
  private s: ProgressionSnap = blankSnap()
  private p: ProgressionDelta = blankDelta()
  private seq = 0
  /** cumulative drops per capped column — feeds `windowStart` (see recomputeWindow). */
  private droppedBy: ProgressionDropFront = emptyDropFront()
  /** SUMMONED pets (pet-claim tells, never charmed). They follow you through a zone line. */
  private claimed = new Set<string>()
  /** Pets bound RIGHT NOW by charm. Charm cannot survive a zone transition (law 4). */
  private charmed = new Set<string>()
  /** Every name ever charmed this epoch — see onClaim: a charmed mob tells you it is your
   *  pet too, and that claim must never promote it to a zone-surviving summoned pet. */
  private everCharmed = new Set<string>()

  reset(): void {
    this.clear()
    this.seq = 0
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    // Character rebirth (Task #49): everything before the boundary belongs to a dead
    // same-name character and would contaminate every rate. Character-scoped ⇒ full clear,
    // pending deltas included (a rescan resets mid-replay and pushes nothing; a live crossing
    // re-hydrates from the post-epoch snapshot, which index.ts triggers via onCharacter).
    if (ev.kind === 'epoch') {
      this.clear()
      return
    }
    if (ev.ts > this.s.lastTs) this.s.lastTs = ev.ts
    this.fold(ev)
  }

  private fold(ev: LogEvent): void {
    switch (ev.kind) {
      case 'expGain':
        // pct UNDEFINED (the line stated none) is stored as -1 plus flag bit 1 — never 0.
        this.pushExp(ev.ts, ev.pct, ev.party)
        return
      case 'death':
        this.onDeath(ev.ts, ev.bySelf, ev.killer)
        return
      case 'zone':
        this.onZone(ev.ts, ev.zone)
        return
      case 'loot':
        push1(this.s.lootTs, this.p.lootTs, ev.ts)
        this.trim()
        return
      case 'level':
        // UNCAPPED (with aaGain): ~5k rows/year, and the chart needs every ding.
        push1(this.s.levelTs, this.p.levelTs, ev.ts)
        push1(this.s.levelValue, this.p.levelValue, ev.level)
        return
      case 'aaGain':
        push1(this.s.aaGainTs, this.p.aaGainTs, ev.ts)
        push1(this.s.aaGainAmount, this.p.aaGainAmount, ev.amount)
        return
      case 'petClaim':
        this.onClaim(idKey(ev.name))
        return
      case 'charm':
        this.charmed.add(idKey(ev.mob))
        this.everCharmed.add(idKey(ev.mob))
        return
      case 'uncharm':
        this.charmed.delete(idKey(ev.mob))
        return
      default:
        return
    }
  }

  /**
   * A pet addressed you as master. For a name we have NEVER seen charmed this is the only
   * binding signal a random-named SUMMONED pet ever gets, and summoned pets follow you across
   * zones — so it binds permanently. For a name we HAVE seen charmed it is a charmed mob
   * re-stating a relationship that a zone line ends, so it re-arms the charmed set instead
   * (message-driven, law 1) and is cleared again by the next zone. Without that split, one
   * tell from a charmed mob would credit its kills to you forever, in every zone.
   */
  private onClaim(key: string): void {
    if (this.everCharmed.has(key)) this.charmed.add(key)
    else this.claimed.add(key)
  }

  private pushExp(ts: number, pct: number | undefined, party: boolean): void {
    const flag = (pct === undefined ? 1 : 0) | (party ? 2 : 0)
    this.s.expTs.push(ts)
    this.s.expPct.push(pct ?? -1)
    this.s.expFlag.push(flag)
    this.p.expTs.push(ts)
    this.p.expPct.push(pct ?? -1)
    this.p.expFlag.push(flag)
    this.trim()
  }

  /** Self kill / bound-pet kill (credited) vs everybody else's (witnessed). */
  private onDeath(ts: number, bySelf: boolean, killer: string | undefined): void {
    if (bySelf) {
      this.pushKill(ts, 0)
      return
    }
    // `X has been slain by You` is the third-person twin of the self shape — counting it
    // would double every one of your own kills (reducers.ts isCountedKill, same rule).
    if (!killer || /^you\b/i.test(killer)) return
    const k = idKey(killer)
    if (this.claimed.has(k) || this.charmed.has(k)) {
      this.pushKill(ts, 1)
      return
    }
    push1(this.s.witnessTs, this.p.witnessTs, ts)
    this.trim()
  }

  private pushKill(ts: number, credit: number): void {
    // -1 before the first zone line: unknown zone, never a fabricated one.
    const zone = this.s.zoneStart.length - 1
    this.s.killTs.push(ts)
    this.s.killZone.push(zone)
    this.s.killCredit.push(credit)
    this.p.killTs.push(ts)
    this.p.killZone.push(zone)
    this.p.killCredit.push(credit)
    this.trim()
  }

  /** Close the open interval at the new zone's start, then open the next one. */
  private onZone(ts: number, zone: string): void {
    const n = this.s.zoneStart.length
    if (n > 0 && this.s.zoneEnd[n - 1] === 0) {
      this.s.zoneEnd[n - 1] = ts
      // If that interval is still inside this flush's pending slice, correct it in place;
      // otherwise the consumer already holds it and needs the explicit close instruction.
      const base = n - this.p.zoneStart.length
      if (n - 1 >= base) this.p.zoneEnd[n - 1 - base] = ts
      else this.p.zoneCloseEnd = ts
    }
    this.s.zoneStart.push(ts)
    this.s.zoneEnd.push(0)
    this.s.zoneName.push(zone)
    this.p.zoneStart.push(ts)
    this.p.zoneEnd.push(0)
    this.p.zoneName.push(zone)
    // Charm cannot survive a zone transition; a SUMMONED pet does (law 4).
    this.charmed.clear()
    this.trim()
  }

  /** Enforce every cap, then re-derive the retention floor. */
  private trim(): void {
    const s = this.s
    this.noteDrop('exp', capColumns(EXP_CAP, [s.expTs, s.expPct, s.expFlag]))
    this.noteDrop('kill', capColumns(KILL_CAP, [s.killTs, s.killZone, s.killCredit]))
    this.noteDrop('witness', capColumns(WITNESS_CAP, [s.witnessTs]))
    this.noteDrop('loot', capColumns(LOOT_CAP, [s.lootTs]))
    const zoneDrop = capColumns(ZONE_CAP, [s.zoneStart, s.zoneEnd, s.zoneName])
    if (zoneDrop > 0) {
      // killZone is an index into zoneName, so a front-drop shifts every one of them; a kill
      // whose zone aged out becomes -1 (unknown), never a wrong zone. rangeStats attributes by
      // TIMESTAMP regardless, so this can only affect a consumer that trusts the index.
      for (let i = 0; i < s.killZone.length; i++) s.killZone[i] = Math.max(-1, s.killZone[i] - zoneDrop)
      this.noteDrop('zone', zoneDrop)
    }
    this.recomputeWindow()
  }

  private noteDrop(col: keyof ProgressionDropFront, n: number): void {
    if (n === 0) return
    this.droppedBy[col] += n
    this.p.dropFront[col] += n
    this.s.dropped += n
  }

  /**
   * The retention floor: 0 while nothing has aged out, else the MAX first-timestamp across the
   * columns that HAVE dropped — before that instant the record is partial and any rate over it
   * would silently under-count. `clipped` is exactly "the selection reaches below this".
   */
  private recomputeWindow(): void {
    const s = this.s
    let w = 0
    const bump = (dropped: number, first: number | undefined): void => {
      if (dropped > 0 && first !== undefined) w = Math.max(w, first)
    }
    bump(this.droppedBy.exp, s.expTs[0])
    bump(this.droppedBy.kill, s.killTs[0])
    bump(this.droppedBy.witness, s.witnessTs[0])
    bump(this.droppedBy.loot, s.lootTs[0])
    bump(this.droppedBy.zone, s.zoneStart[0])
    s.windowStart = w
  }

  private clear(): void {
    this.s = blankSnap()
    this.p = blankDelta()
    this.droppedBy = emptyDropFront()
    this.claimed = new Set()
    this.charmed = new Set()
    this.everCharmed = new Set()
  }

  snapshot(): { seq: number; state: ProgressionSnap } {
    return { seq: this.seq, state: this.s }
  }

  flushDelta(): { seq: number; delta: ProgressionDelta } | null {
    const p = this.p
    const appended =
      p.expTs.length + p.killTs.length + p.witnessTs.length + p.lootTs.length + p.zoneStart.length +
      p.levelTs.length + p.aaGainTs.length
    const dropped = p.dropFront.exp + p.dropFront.kill + p.dropFront.witness + p.dropFront.loot + p.dropFront.zone
    if (appended === 0 && dropped === 0 && p.zoneCloseEnd === undefined) return null
    p.lastTs = this.s.lastTs
    p.windowStart = this.s.windowStart
    p.dropped = this.s.dropped
    this.p = blankDelta()
    return { seq: this.seq, delta: p }
  }
}

/** Append one value to the live column and its pending twin. */
function push1(live: number[], pending: number[], v: number): void {
  live.push(v)
  pending.push(v)
}

function blankSnap(): ProgressionSnap {
  return {
    expTs: [], expPct: [], expFlag: [],
    killTs: [], killZone: [], killCredit: [],
    witnessTs: [],
    lootTs: [],
    zoneStart: [], zoneEnd: [], zoneName: [],
    levelTs: [], levelValue: [], aaGainTs: [], aaGainAmount: [],
    lastTs: 0, windowStart: 0, dropped: 0
  }
}

function blankDelta(): ProgressionDelta {
  return {
    expTs: [], expPct: [], expFlag: [],
    killTs: [], killZone: [], killCredit: [],
    witnessTs: [],
    lootTs: [],
    zoneStart: [], zoneEnd: [], zoneName: [],
    levelTs: [], levelValue: [], aaGainTs: [], aaGainAmount: [],
    lastTs: 0, windowStart: 0, dropped: 0, dropFront: emptyDropFront()
  }
}
