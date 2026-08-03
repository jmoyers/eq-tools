// MobDropRow — the ITEM-facing half of the mob page (see MobPage.tsx for the page itself).
//
// ITEM NAMES ARE LIVE. Every one is a KnownItemTooltip anchor (hover = the EQ-style item window
// plus what it's for) AND clicks through to the loot tab's ItemDetailDialog. That second dialog
// needs the item's own loot history, so the loot module is subscribed inside a component that
// mounts only once an item is actually clicked — a mob page costs zero loot subscriptions until
// you drill into one of its drops.

import { type JSX } from 'react'
import { Box, Stack, Typography } from '@mui/material'
import type { LootDelta, LootSnap, MobSeenDrop } from '@shared/types'
import { formatDate } from '../../lib/formatDate'
import { itemCountKey } from '../../lib/itemName'
import { KnownItemTooltip } from '../../lib/KnownItemTooltip'
import { useModule } from '../../lib/useModule'
import { getPoskyData } from '../../data'
import { ItemDetailDialog } from '../loot/ItemDetailDialog'

// The Plane of Sky dataset, reused exactly as LootView reads it, so an item drilled into from a
// mob page gets the same "Plane of Sky" badge and offline stat blob it gets from the loot table.
const posky = getPoskyData()
const questItemNames = new Set<string>(posky.quests.flatMap((q) => q.items.map((i) => itemCountKey(i.name))))
const itemStats: Record<string, string> = {}
for (const q of posky.quests) {
  for (const it of q.items) if (it.stats) itemStats[itemCountKey(it.name)] = it.stats
  if (q.reward && q.rewardStats) itemStats[itemCountKey(q.reward)] = q.rewardStats
}

/**
 * ONE drop row: the item name (hoverable + clickable), whatever the page said about how often
 * it drops, and — when your own history corroborates it — how many you've had and when.
 */
export function DropRow({
  item,
  rarity,
  seen,
  onOpenItem
}: {
  item: string
  rarity?: string
  seen?: MobSeenDrop
  onOpenItem: (item: string) => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="baseline" sx={{ py: 0.2, minWidth: 0 }}>
      <KnownItemTooltip name={item}>
        <Box
          component="span"
          role="button"
          tabIndex={0}
          onClick={() => onOpenItem(item)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onOpenItem(item)
          }}
          sx={{
            color: 'text.primary',
            cursor: 'pointer',
            textDecoration: 'underline dotted',
            textUnderlineOffset: 2,
            '&:hover': { color: 'primary.main' }
          }}
        >
          {item}
        </Box>
      </KnownItemTooltip>
      {rarity && (
        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
          {rarity}
        </Typography>
      )}
      <Box sx={{ flexGrow: 1 }} />
      {seen && (
        <Typography variant="caption" sx={{ color: 'success.main', flexShrink: 0 }}>
          seen by you: {seen.count}× · last {formatDate(seen.lastTs)}
        </Typography>
      )}
    </Stack>
  )
}

/**
 * The nested item drill-down. Mounted ONLY once an item name is clicked, which is what keeps
 * the mob page free of the loot module's full history until it is actually needed.
 */
export function ItemDrillDown({ item, onClose }: { item: string; onClose: () => void }): JSX.Element {
  const history = useModule<LootSnap, LootDelta>('loot', (s, d) => [...s, ...d.appended])
  const key = itemCountKey(item)
  return (
    <ItemDetailDialog
      open
      onClose={onClose}
      item={item}
      events={(history ?? []).filter((e) => e.item.toLowerCase() === item.toLowerCase())}
      stats={itemStats[key]}
      isQuestItem={questItemNames.has(key)}
    />
  )
}
