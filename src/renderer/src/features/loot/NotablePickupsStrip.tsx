import { type JSX, useMemo, useState } from 'react'
import { Box, Chip, FormControlLabel, Stack, Switch, Tooltip, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import AutoStoriesIcon from '@mui/icons-material/AutoStories'
import type { ItemKnowledge, LootEvent } from '@shared/types'
import { recipeUseLabel } from '@shared/itemKnowledge'
import { itemCountKey } from '../../lib/itemName'
import { KnownItemTooltip } from '../../lib/KnownItemTooltip'
import { isTradeskillOnly } from '../../lib/itemKnowledgeView'
import { useNotablePickups, type NotablePickup } from './useNotablePickups'

// Renderer-local view pref (same shape as App.tsx's saved view / `eq.combat.scope`): does the
// notable-pickups strip surface pure tradeskill components? Default OFF — a grinding session
// loots hundreds of spider legs, and a strip full of ingredients drowns the one coin that
// actually starts a quest. The loot HISTORY table is never filtered by this: it is a ledger.
const TRADESKILL_KEY = 'eq.loot.showTradeskill'

function loadShowTradeskill(): boolean {
  try {
    return localStorage.getItem(TRADESKILL_KEY) === '1'
  } catch {
    return false
  }
}

/** Everything the strip needs except the "open this item" callback the view owns. */
export interface NotableStripState {
  notable: NotablePickup[]
  hiddenTradeskill: number
  showTradeskill: boolean
  onToggleTradeskill: (v: boolean) => void
  onDismiss: (key: string) => void
}

/**
 * "Notable pickups" (Task #53): probe the most-recent distinct looted items for lore/quest
 * knowledge (main: local-posky-first + cached wiki). Dismissed keys hide from the strip.
 * `byKey` also feeds the per-row LORE/quest indicator, so the view gets it back too.
 */
export function useNotableStrip(history: LootEvent[]): {
  knowledgeByKey: Map<string, ItemKnowledge>
  strip: NotableStripState
} {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const { byKey, notable } = useNotablePickups(history, dismissed)
  // Tradeskill-only pickups are hidden by default (see TRADESKILL_KEY).
  const [showTradeskill, setShowTradeskill] = useState<boolean>(loadShowTradeskill)
  const tradeskillHidden = useMemo(() => notable.filter((n) => isTradeskillOnly(n.knowledge)), [notable])
  const visibleNotable = useMemo(
    () => (showTradeskill ? notable : notable.filter((n) => !isTradeskillOnly(n.knowledge))),
    [notable, showTradeskill]
  )
  const onToggleTradeskill = (v: boolean): void => {
    setShowTradeskill(v)
    try {
      localStorage.setItem(TRADESKILL_KEY, v ? '1' : '0')
    } catch {
      /* a renderer without storage just doesn't remember — never a crash */
    }
  }
  return {
    knowledgeByKey: byKey,
    strip: {
      notable: visibleNotable,
      hiddenTradeskill: showTradeskill ? 0 : tradeskillHidden.length,
      showTradeskill,
      onToggleTradeskill,
      onDismiss: (key) => setDismissed((prev) => new Set(prev).add(key))
    }
  }
}

// One pickup: hovering shows the item card, clicking opens that item's detail dialog, and
// the delete affordance dismisses it from the strip.
function PickupChip({
  n,
  onSelect,
  onDismiss
}: {
  n: NotablePickup
  onSelect: (item: string) => void
  onDismiss: (key: string) => void
}): JSX.Element {
  const uses = n.knowledge.questUses
  // Nothing quest-side? A recipe that consumes it is the honest "what for" (Task #61).
  const firstRecipe = n.knowledge.recipes?.[0]
  const label =
    uses.length > 0
      ? `${n.item} → ${uses[0].quest}`
      : firstRecipe
        ? `${n.item} → ${recipeUseLabel(firstRecipe)}`
        : n.item
  const key = itemCountKey(n.item)
  return (
    <KnownItemTooltip name={n.item} knowledge={n.knowledge}>
      <Chip
        size="small"
        variant="outlined"
        color={n.knowledge.lore ? 'warning' : 'secondary'}
        icon={n.knowledge.lore ? <AutoStoriesIcon /> : undefined}
        label={label}
        onClick={() => onSelect(n.item)}
        onDelete={() => onDismiss(key)}
        deleteIcon={<CloseIcon />}
        sx={{ maxWidth: 320 }}
      />
    </KnownItemTooltip>
  )
}

// The toggle that reveals the hidden components — it says how many are behind it rather
// than pretending the pickups didn't happen.
function TradeskillToggle({
  hiddenTradeskill,
  showTradeskill,
  onToggleTradeskill
}: {
  hiddenTradeskill: number
  showTradeskill: boolean
  onToggleTradeskill: (v: boolean) => void
}): JSX.Element {
  return (
    <Tooltip title="Tradeskill components (spider legs, bone chips, gnome meat…) are ingredients, not quest items — hidden here by default. Hover any item name to see what it's for.">
      <FormControlLabel
        sx={{ m: 0 }}
        control={
          <Switch size="small" checked={showTradeskill} onChange={(e) => onToggleTradeskill(e.target.checked)} />
        }
        label={
          <Typography variant="caption" color="text.secondary">
            show tradeskill{hiddenTradeskill > 0 ? ` (${hiddenTradeskill})` : ''}
          </Typography>
        }
      />
    </Tooltip>
  )
}

// "Notable pickups" strip (Task #53): the last few looted items that are lore- or
// quest-relevant. Dense, dismissable, no narration — a quiet "hey, that coin you grabbed
// is for the Tashania spell quest". Hovering a chip shows the item card; clicking it opens
// that item's detail dialog.
//
// TRADESKILL (Task #62): components are hidden by default — see TRADESKILL_KEY above. The
// strip stays mounted while any are hidden so the toggle that reveals them is reachable, and
// it says how many are behind it rather than pretending the pickups didn't happen.
export function NotablePickupsStrip({
  notable,
  hiddenTradeskill,
  showTradeskill,
  onToggleTradeskill,
  onSelect,
  onDismiss
}: NotableStripState & { onSelect: (item: string) => void }): JSX.Element | null {
  if (notable.length === 0 && hiddenTradeskill === 0) return null
  return (
    <Box
      sx={{
        p: 1,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'action.hover'
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <AutoStoriesIcon fontSize="small" sx={{ color: 'secondary.main' }} />
        <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
          Notable pickups
        </Typography>
        {notable.slice(0, 8).map((n) => (
          <PickupChip key={itemCountKey(n.item)} n={n} onSelect={onSelect} onDismiss={onDismiss} />
        ))}
        <Box sx={{ flexGrow: 1 }} />
        <TradeskillToggle
          hiddenTradeskill={hiddenTradeskill}
          showTradeskill={showTradeskill}
          onToggleTradeskill={onToggleTradeskill}
        />
      </Stack>
    </Box>
  )
}
