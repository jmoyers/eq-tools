// ObservedItemWindow — an ItemWindow that knows YOUR item levels (Task #60).
//
// ItemWindow itself stays PURE (props only): it is also rendered by the overlay bundle,
// which has the minimal `eqOverlay` bridge and no `window.eq` module transport, and it must
// keep working there with nothing but the name in front of it. So the module lookup lives
// in this thin wrapper, which the two MAIN-WINDOW surfaces use — the loot detail dialog and
// the posky hover tooltip.
//
// MOUNT COST: the wrapper subscribes via useModule, so it must only be mounted where an item
// window is actually on screen. MUI renders a Tooltip's `title` node only while the tooltip
// is open, so putting the wrapper INSIDE the tooltip body (not around it) keeps this to one
// subscription at a time even in a list of hundreds of item rows.

import { ItemWindow, type ItemWindowProps } from './ItemWindow'
import { useModule } from './useModule'
import { itemTierKey } from '@shared/itemStats'
import type { ItemTiersDelta, ItemTiersSnap } from '@shared/types'

/** Merge a delta's changed rows over the known map (kills-style transport). */
function applyItemTiers(state: ItemTiersSnap, delta: ItemTiersDelta): ItemTiersSnap {
  return { ...state, ...delta.changed }
}

/** The whole observed-tier map for the current character, or null before hydration. */
export function useItemTiers(): ItemTiersSnap | null {
  return useModule<ItemTiersSnap, ItemTiersDelta>('itemTiers', applyItemTiers)
}

/**
 * The tier THIS character was observed to merge `name` to, or undefined when we've never
 * seen it merged. Undefined means UNKNOWN — the caller must not substitute 0.
 */
export function observedTierOf(tiers: ItemTiersSnap | null, name: string): number | undefined {
  return tiers?.[itemTierKey(name)]?.tier
}

/** ItemWindow + the observed item level for the item it is describing. */
export function ObservedItemWindow(props: ItemWindowProps): JSX.Element {
  const tiers = useItemTiers()
  return <ItemWindow {...props} observedTier={props.observedTier ?? observedTierOf(tiers, props.name)} />
}
