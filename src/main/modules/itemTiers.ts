// itemTiers module (Task #60) — the per-item OBSERVED item level ("tier") for the items the
// CURRENT character has actually upgraded.
//
// WHY IT EXISTS. The wiki documents BASE items only (per-INSTANCE tier is not on any item
// page), so before this the ItemWindow could draw its tier meter for exactly one reason: the
// display name in front of it happened to carry ` +N`. Look up "Ghoulbane" and the window had
// nothing to say about the Ghoulbane +4 in your bags. The log DOES say it — once, at the
// moment of the merge — so we fold those statements into character-scoped state.
//
// WHAT COUNTS AS EVIDENCE (law 1: messages over inference; unknown ≠ zero). Only MERGE
// evidence — a line where the game told us an upgraded item came into existence in OUR hands:
//   1. `itemMerge` with a tier — `You have successfully merged two items together to create a
//      new item: <Name> +N`. (Rank-suffixed spell-scroll merges carry no tier and are counted
//      as merges only — never as an item level.)
//   2. loot with disposition 'combined' — the auto-merge-on-pickup line
//      `You looted <item> … to create a <item> +N`; `created` is the result, same as (1).
//   3. `itemMergeFailed` reason 'mismatch' — `Your request to merge <target> with
//      <component> failed. …` The line quotes YOUR item's name verbatim, tier suffix and
//      all, so it is a direct statement that you hold that item at that tier.
// Ordinary loot of a `+N` drop is deliberately NOT evidence: an unmerged drop is routinely
// auto-sold or destroyed on pickup (the log shows both), so it says nothing about what you
// KEEP and would mint a tier for an item you never upgraded. The real log makes the
// distinction visible: four `Kitchen Toolbelt +4` drops were looted post-launch and all four
// were destroyed minutes later.
//
// WHAT IT NEVER CLAIMS. Item exp WITHIN a tier is unobservable (no log line reports it), so
// nothing here models progress toward the next tier — the UI draws position only. An item we
// have never merged has NO row: absent means UNKNOWN, never tier 0.
//
// TIER SEMANTICS: `tier` is the HIGHEST tier ever observed for the item's base name, not the
// latest. Merges are per-INSTANCE and the user levels several copies of the same item in
// parallel — the real log has `Whitened Treant Fists +1, +2, +2, +3, +3, +4` inside one
// minute (two instances climbing together), so "latest" would report +3 for a bag holding a
// +4. `lastTier` keeps the most recent result for anyone who wants the raw sequence.
//
// CHARACTER-SCOPED, EPOCH-AWARE. Item tiers belong to a character exactly like loot/kills/
// leveling do: the beta character (wiped at the 2026-07-28 launch, same log file) merged a
// Kitchen Toolbelt to +5 and Pristine Studded Leather to +4, none of which the current
// character owns. On the derived `epoch` event we drop the whole map, same as loot.ts.
//
// NAMES ARE DIRTY (law 2): rows are keyed by `itemTierKey` (lowercased, ` +N` stripped) — the
// shared counting-boundary rule loot already uses — while `name` keeps the RAW base name for
// display ("Thelvorn, Blade of Light", commas and all).

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import type { ItemTierRow, ItemTiersDelta, ItemTiersSnap } from '../../shared/types'
import { itemBaseName, itemTierFromName, itemTierKey } from '../../shared/itemStats'

export class ItemTiersModule implements EqModule<ItemTiersSnap, ItemTiersDelta> {
  readonly id = 'itemTiers'
  private rows: ItemTiersSnap = {}
  private seq = 0
  private dirty = new Set<string>()

  reset(): void {
    this.rows = {}
    this.seq = 0
    this.dirty.clear()
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    if (ev.kind === 'epoch') {
      // Character rebirth (Task #49): every merge before the boundary was performed by a
      // dead same-name character. Their upgrades are not in this character's bags.
      this.rows = {}
      this.dirty.clear()
      return
    }
    if (ev.kind === 'itemMerge') {
      // Tier-less results are SPELL-SCROLL merges (Roman rank). Still a merge we observed —
      // recorded as one, with no tier claimed for it.
      this.observe(ev.item, ev.ts, 'merge')
      return
    }
    if (ev.kind === 'itemMergeFailed') {
      // Only the 'mismatch' shape names items; it is an inventory statement, not an upgrade,
      // so it never counts as a merge — it can only reveal a tier we hadn't seen.
      if (ev.reason === 'mismatch' && ev.target) this.observe(ev.target, ev.ts, 'held')
      return
    }
    if (ev.kind === 'loot' && ev.disposition === 'combined' && ev.created) {
      this.observe(ev.created, ev.ts, 'merge')
    }
  }

  /**
   * Fold one observation of `raw` (a display name that may carry ` +N`) at `ts`.
   * `how` is 'merge' when an upgrade happened, 'held' when a line merely quoted an item we
   * are holding. A tier-less name advances nothing but the merge count.
   */
  private observe(raw: string, ts: number, how: 'merge' | 'held'): void {
    const name = itemBaseName(raw)
    if (!name) return
    const key = itemTierKey(raw)
    const tier = itemTierFromName(raw)
    const prev = this.rows[key]
    if (!prev) {
      // A 'held' first sighting with no tier tells us nothing at all — skip it rather than
      // create an empty row (absent = unknown).
      if (how === 'held' && tier === undefined) return
      this.rows[key] = {
        key,
        name,
        tier,
        lastTier: tier,
        merges: how === 'merge' ? 1 : 0,
        firstAt: ts,
        lastAt: ts
      }
      this.dirty.add(key)
      return
    }
    const next: ItemTierRow = {
      ...prev,
      name,
      lastAt: ts,
      merges: how === 'merge' ? prev.merges + 1 : prev.merges
    }
    if (tier !== undefined) {
      next.tier = prev.tier === undefined ? tier : Math.max(prev.tier, tier)
      next.lastTier = tier
    }
    this.rows[key] = next
    this.dirty.add(key)
  }

  snapshot(): { seq: number; state: ItemTiersSnap } {
    return { seq: this.seq, state: this.rows }
  }

  flushDelta(): { seq: number; delta: ItemTiersDelta } | null {
    if (this.dirty.size === 0) return null
    const changed: ItemTiersSnap = {}
    for (const key of this.dirty) changed[key] = this.rows[key]
    this.dirty.clear()
    return { seq: this.seq, delta: { changed } }
  }
}
