import type { JSX } from 'react'
import { Chip, Stack, Tooltip } from '@mui/material'
import type { ItemKnowledge, ItemRecipeUse } from '@shared/types'
import { recipeUseLabel } from '@shared/itemKnowledge'

interface BadgeFlags {
  recipes: ItemRecipeUse[]
  hasQuests: boolean
  showQuest: boolean
  showTradeskill: boolean
}

// Task #61: an item whose stats block says QUEST ITEM but which no quest anywhere uses is a
// TRADESKILL component (Gnome Meat → Gnome Kabobs). Those get a `tradeskill` chip naming
// the recipes instead of a "quest" chip that leads nowhere. The PoSky chip already covers
// Sky items, so suppress a redundant "quest" badge there.
function badgeFlags(knowledge: ItemKnowledge, isPosky: boolean): BadgeFlags {
  const recipes = knowledge.recipes ?? []
  const hasQuests = knowledge.questUses.length > 0
  const tradeskillOnly = recipes.length > 0 && !hasQuests
  return {
    recipes,
    hasQuests,
    showQuest: (knowledge.quest || hasQuests) && !isPosky && !tradeskillOnly,
    showTradeskill: tradeskillOnly && !isPosky
  }
}

// The hover text answers "what is this FOR" with the most specific thing we know: the
// quests, else the recipes, else the bare flag that made the badge appear at all.
function badgeTitle(knowledge: ItemKnowledge, flags: BadgeFlags): string {
  if (flags.hasQuests) return `Used in: ${knowledge.questUses.map((u) => u.quest).join(', ')}`
  if (flags.showTradeskill) return `Used in: ${flags.recipes.map(recipeUseLabel).join(', ')}`
  return knowledge.lore ? 'Lore item' : 'Quest item'
}

// A subtle indicator for an item the wiki knows is LORE or quest-relevant (Task #53),
// EXTENDING the local PoSky flag to any wiki-known quest item. Shown only when the async
// knowledge probe has resolved AND flags it; ordinary items render nothing (no noise).
export function KnowledgeBadge({
  knowledge,
  isPosky
}: {
  knowledge?: ItemKnowledge
  isPosky: boolean
}): JSX.Element | null {
  if (!knowledge) return null
  const flags = badgeFlags(knowledge, isPosky)
  if (!knowledge.lore && !flags.showQuest && !flags.showTradeskill) return null
  return (
    <Tooltip title={badgeTitle(knowledge, flags)}>
      <Stack direction="row" spacing={0.5} alignItems="center" component="span">
        {knowledge.lore && (
          <Chip size="small" color="warning" variant="outlined" label="LORE" sx={{ height: 18, fontSize: 10 }} />
        )}
        {flags.showQuest && (
          <Chip size="small" color="secondary" variant="outlined" label="quest" sx={{ height: 18, fontSize: 10 }} />
        )}
        {flags.showTradeskill && (
          <Chip size="small" color="info" variant="outlined" label="tradeskill" sx={{ height: 18, fontSize: 10 }} />
        )}
      </Stack>
    </Tooltip>
  )
}
