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

//
// THE RECENT-KILLS RING + THE EXPERIENCE JOIN. The columns above carry no names, so a small
// bounded ring (RECENT_KILL_CAP rows, drop-oldest) records WHAT each credited kill was and what
// it paid. The pairing is MEASURED, not assumed:
//
//   FULL-LOG SWEEP (read-only, 1.11M lines): 4909 experience lines, 5988 slain lines. For 4887
//   of the 4909 the nearest slain line is the one AFTER it, and the timestamp gap is 0 s (4856)
//   or 1 s (25). The experience line PRECEDES its kill line — always, and essentially always in
//   the same second. Not one experience line in the log follows its kill inside 4 s.
//
// So the join looks BACKWARD: a kill takes the most recent UNCLAIMED experience line within
// KILL_EXP_JOIN_MS before it. That makes the ring row complete the instant it is created, which
// is why the delta stays a pure append with no patch channel and no deferred commit.
// An experience line is CONSUMED by the first kill line that claims it and can never be
// attributed twice — including by a WITNESSED kill, which consumes without recording: a
// group-mate's kill pays party experience, and letting that line survive would hand it to your
// own next kill seconds later. A kill with no line in its window carries no exp at all, which
// the UI states as such — never as 0% (law 1).

import type { EqModule } from './types'
import { idKey } from '../log/parser'
import type { LogEvent } from '../../shared/logEvents'
import type {
  ProgressionDelta,
  ProgressionDropFront,
  ProgressionKill,
  ProgressionSnap
} from '../../shared/types'

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

/**
 * The named recent-kills ring. Capped by COUNT, not by the column policy above: it is a display
 * feed for a glance card that renders 25 rows, so 50 is one screenful of headroom and ~50 small
 * objects against a ~1.2MB columnar payload is nothing. Its drops are deliberately kept out of
 * `dropped`/`windowStart` (see ProgressionDelta.recentKillsDrop) — those describe the columns.
 */
export const RECENT_KILL_CAP = 50

/**
 * How far BACK a kill may reach for its experience line. The measured gap is 0 s or 1 s (sweep
 * in the header), so 2.5 s is generous slack over the observed spread while staying far under
 * the time between kills — it exists to absorb the log's one-second timestamp resolution, not
 * to hunt for a plausible line.
 */
export const KILL_EXP_JOIN_MS = 2500

/** An experience line waiting to be claimed by the kill line that follows it. */
interface PendingExp {
  ts: number
  pct?: number
  party: boolean
}

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
  /** The experience line the next kill line may claim (see the header's join sweep). */
  private pendingExp: PendingExp | null = null

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
        this.onDeath(ev)
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
    // Offer it to the kill line that follows. An UNCLAIMED older line is simply replaced: two
    // experience lines with no kill between them means the first one's kill never printed, and
    // handing a stale line to a later kill would be a fabricated attribution.
    this.pendingExp = { ts, pct, party }
    this.trim()
  }

  /**
   * The experience line this kill line claims, or undefined. Claiming CONSUMES it, so no line
   * is ever attributed twice — and every kill line consumes, witnessed ones included, because
   * the line belongs to the kill it precedes whoever landed the blow.
   */
  private takeExp(ts: number): PendingExp | undefined {
    const p = this.pendingExp
    this.pendingExp = null
    if (!p || ts < p.ts || ts - p.ts > KILL_EXP_JOIN_MS) return undefined
    return p
  }

  /** Self kill / bound-pet kill (credited) vs everybody else's (witnessed). */
  private onDeath(ev: { ts: number; name: string; bySelf: boolean; killer?: string }): void {
    const exp = this.takeExp(ev.ts)
    if (ev.bySelf) {
      this.pushKill(ev.ts, 0, ev.name, exp)
      return
    }
    // `X has been slain by You` is the third-person twin of the self shape — counting it
    // would double every one of your own kills (reducers.ts isCountedKill, same rule).
    const killer = ev.killer
    if (!killer || /^you\b/i.test(killer)) return
    const k = idKey(killer)
    if (this.claimed.has(k) || this.charmed.has(k)) {
      this.pushKill(ev.ts, 1, ev.name, exp)
      return
    }
    push1(this.s.witnessTs, this.p.witnessTs, ev.ts)
    this.trim()
  }

  private pushKill(ts: number, credit: number, name: string, exp: PendingExp | undefined): void {
    // -1 before the first zone line: unknown zone, never a fabricated one.
    const zone = this.s.zoneStart.length - 1
    this.s.killTs.push(ts)
    this.s.killZone.push(zone)
    this.s.killCredit.push(credit)
    this.p.killTs.push(ts)
    this.p.killZone.push(zone)
    this.p.killCredit.push(credit)
    this.pushKillRow(ts, credit, name, exp)
    this.trim()
  }

  /** The named ring row for a credited kill (a DISPLAY duplicate — no statistic reads it). */
  private pushKillRow(ts: number, credit: number, name: string, exp: PendingExp | undefined): void {
    const row: ProgressionKill = {
      ts,
      name,
      credit,
      // RAW zone name, or '' before the first zone line — the same "unknown, never fabricated"
      // rule the -1 zone index states in the column.
      zone: this.s.zoneName[this.s.zoneName.length - 1] ?? ''
    }
    if (exp) {
      row.expFlag = (exp.pct === undefined ? 1 : 0) | (exp.party ? 2 : 0)
      if (exp.pct !== undefined) row.expPct = exp.pct
    }
    this.s.recentKills.push(row)
    this.p.recentKills.push(row)
    // Drop-oldest by COUNT, exactly (a 50-entry splice is free — no TRIM_BATCH slack needed),
    // and deliberately NOT through noteDrop: this ring's churn must not move `dropped`.
    const over = this.s.recentKills.length - RECENT_KILL_CAP
    if (over > 0) {
      this.s.recentKills.splice(0, over)
      this.p.recentKillsDrop += over
    }
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
    this.pendingExp = null
  }

  snapshot(): { seq: number; state: ProgressionSnap } {
    return { seq: this.seq, state: this.s }
  }

  flushDelta(): { seq: number; delta: ProgressionDelta } | null {
    const p = this.p
    const appended =
      p.expTs.length + p.killTs.length + p.witnessTs.length + p.lootTs.length + p.zoneStart.length +
      p.levelTs.length + p.aaGainTs.length + p.recentKills.length
    const dropped =
      p.dropFront.exp + p.dropFront.kill + p.dropFront.witness + p.dropFront.loot + p.dropFront.zone +
      p.recentKillsDrop
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
    recentKills: [],
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
    recentKills: [], recentKillsDrop: 0,
    lootTs: [],
    zoneStart: [], zoneEnd: [], zoneName: [],
    levelTs: [], levelValue: [], aaGainTs: [], aaGainAmount: [],
    lastTs: 0, windowStart: 0, dropped: 0, dropFront: emptyDropFront()
  }
}
