// Refund-proof AA accounting (Task #48).
//
// THE PROBLEM. EQ Legends logs AA economy as two line kinds and NOTHING else:
//   gain:  "You have gained N ability point(s)!  You now have M ability point(s)."
//   spend: "You have gained the ability \"X\" at a cost of N ability points."   (rank 1)
//          "You have improved X <rank> at a cost of N ability point(s)."         (rank ≥2)
// A respec REFUNDS points and lets you re-buy — but there is NO refund line. Instead the
// refunded points RE-ENTER the pool and re-fire as fresh gain lines, then re-fire as fresh
// spend lines when re-bought. So over a log with respecs:
//   Σ gain amounts  ==  Σ spend costs  (verified: 228 == 228 on the real log; the pool
//   simulated from gains−spends tracks the game's own "You now have M" EXACTLY, 0 drift)
// and BOTH double-count every refunded point. The old "earned = Σ gains" headline was thus
// inflated by the refund churn (228 vs the game's true 206).
//
// THE FIX (the identity the user validated Aug 1: net 204 + unspent 2 = 206):
//   earned = allocated + unspent
//   allocated = Σ, over each DISTINCT (ability, rank), of the LATEST purchase's cost,
//               excluding cost-0 auto-grants. Latest-per-key collapses a respec re-buy of
//               the same rank to one — the ONLY refund signal the log carries.
//   unspent   = the last authoritative "You now have M", minus spends logged after it.
// This is refund-proof for the re-bought-same-rank case (the common respec). It CANNOT see
// a refund whose points were re-spent on a DIFFERENT ability (no log signal exists for that);
// on this character that path doesn't occur (only Mnemonic Retention's ladder was re-bought),
// and the identity reproduces the ground truth to the point. See tests/aaAccounting*.

/** The minimal shapes this module needs (structurally satisfied by AAEvent/AASpendEvent). */
export interface AAGainLike {
  ts: number
  amount: number
  nowHave: number
}
export interface AASpendLike {
  ts: number
  /** ability name INCLUDING the trailing rank for the improved form (e.g. "Combat Fury 3");
   *  the quoted rank-1 form has no rank suffix. This string is therefore a valid
   *  (ability, rank) dedupe key on its own. */
  ability: string
  cost: number
  rank?: number
}

export interface AAAccounting {
  /** Current net allocation: latest-epoch cost per (ability, rank), cost-0 excluded. */
  allocated: number
  /** Unspent balance: last authoritative "You now have", minus spends after it. */
  unspent: number
  /** earned = allocated + unspent (the refund-proof headline). */
  earned: number
  /** Distinct purchased abilities (cost > 0), after respec dedupe — for the "N bought" caption. */
  boughtCount: number
  /** Lifetime Σ of every purchase cost, refunds and all — kept only as a diagnostic figure. */
  lifetimeCost: number
}

/**
 * Fold the (log-ordered) gain + spend arrays into the refund-proof accounting.
 * Arrays are the raw module snapshot (append-only, log order preserved).
 */
export function computeAAAccounting(gains: AAGainLike[], spends: AASpendLike[]): AAAccounting {
  const lifetimeCost = spends.reduce((s, x) => s + x.cost, 0)

  // allocated: keep the LATEST purchase per (ability, rank) key, then sum cost>0.
  const latest = new Map<string, AASpendLike>()
  for (const s of spends) {
    const prev = latest.get(s.ability)
    if (!prev || s.ts >= prev.ts) latest.set(s.ability, s)
  }
  let allocated = 0
  let boughtCount = 0
  for (const s of latest.values()) {
    if (s.cost > 0) {
      allocated += s.cost
      boughtCount++
    }
  }

  // unspent: last authoritative "You now have M" minus spends strictly after it.
  // (Same rule as before — index/ts order from the main process is authoritative.)
  let unspent = 0
  if (gains.length) {
    let lastGain = gains[0]
    for (const g of gains) if (g.ts >= lastGain.ts) lastGain = g
    let pool = lastGain.nowHave
    for (const s of spends) if (s.ts > lastGain.ts) pool = Math.max(0, pool - s.cost)
    unspent = pool
  }

  return { allocated, unspent, earned: allocated + unspent, boughtCount, lifetimeCost }
}
