// KnownItemTooltip — the hover layer for an item NAME anywhere in the main window.
//
// It answers the two questions a name alone can't: "what IS this" (the EQ-style item window)
// and "what is it FOR" (the quests that use it / the recipes that consume it) — plus, one hop
// deep, "and what do I get out of that" (the quest's reward items, the recipe's result), each
// of which is itself hoverable.
//
// RELATIONSHIP TO THE OTHER TWO SURFACES:
//   ItemTooltip (features/posky) — the posky-specific hover: it already HAS its stat blob and
//     shows drop/island knowledge. Unchanged; this one is the generic, knowledge-fetching kin.
//   ItemDetailDialog (features/loot) — the CLICK layer, the deep dive (drop rates, timeline).
//     Unchanged. Hover explains, click investigates.
//
// FETCH-ON-OPEN, NEVER PER ROW: the lookup lives inside the tooltip BODY, and MUI mounts a
// Tooltip's `title` node only while the tooltip is open. So a 5,000-row loot table costs zero
// lookups and zero module subscriptions until a name is actually hovered (the same precedent
// ObservedItemWindow's header states). A caller that already holds the record (the loot view's
// knowledgeByKey map) passes it in and no fetch happens at all.
//
// NESTING: nested MUI Tooltips, capped at ONE level. The outer card is interactive (the mouse
// may enter it — that's how you reach an outcome name); the nested card is NOT interactive and
// opens to the SIDE, so you read it without ever needing to move onto it, and the outer never
// has to close to let you. A depth-1 card renders its own outcomes as plain text, so there is
// no third popper and no infinite chain. A click-to-pin Popover was the alternative; hover won
// because every other item surface in the app is hover-first and a pin would need a dismiss
// affordance on a surface that has none.
//
// MAIN WINDOW ONLY: it draws ObservedItemWindow, which subscribes to the itemTiers module over
// `window.eq`. The overlay bundle has no such bridge (and stays MUI-free) — the overlay gets
// the tradeskill FILTER, not this card.

import { type JSX, useEffect, useState, type ReactElement } from 'react'
import { Box, CircularProgress, Stack, Tooltip, Typography } from '@mui/material'
import type { ItemKnowledge } from '@shared/types'
import { EQ_ITEM_COLORS } from './ItemWindow'
import { ObservedItemWindow } from './ObservedItemWindow'
import { questUseOutcomes, questUseWhere } from './itemKnowledgeView'

/** How many quest uses / recipes the card lists before collapsing to "+N more". */
const MAX_LISTED = 4

/** Deepest card that still offers hoverable outcomes. 0 = only the top card does. */
const MAX_HOVER_DEPTH = 0

/**
 * Fetch an item's knowledge, unless the caller already has it. Runs on MOUNT, which for a
 * tooltip body means "on open". Never throws — main degrades to an offline/negative record.
 */
function useKnowledgeOnOpen(name: string, preloaded?: ItemKnowledge): {
  data: ItemKnowledge | null
  loading: boolean
} {
  const [data, setData] = useState<ItemKnowledge | null>(preloaded ?? null)
  const [loading, setLoading] = useState(!preloaded)

  useEffect(() => {
    if (preloaded) {
      setData(preloaded)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    void window.eq
      .lookupItem(name)
      .then((k) => {
        if (alive) setData(k)
      })
      .catch(() => {
        /* main never rejects; a null record just renders the name honestly */
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [name, preloaded])

  return { data, loading }
}

/** A dim label line inside the "what it's for" block. */
function Muted({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <Typography component="div" sx={{ color: EQ_ITEM_COLORS.label, fontSize: 11, lineHeight: 1.4 }}>
      {children}
    </Typography>
  )
}

/**
 * An OUTCOME item name — a quest reward, or a recipe's result. Hoverable (opening this same
 * card for that item) only while we're inside the depth cap; deeper than that it is plain
 * text, because a chain of poppers is a maze, not an explanation.
 */
function OutcomeName({ name, depth }: { name: string; depth: number }): JSX.Element {
  const label = (
    <Box
      component="span"
      sx={{
        color: EQ_ITEM_COLORS.name,
        ...(depth <= MAX_HOVER_DEPTH
          ? { cursor: 'help', textDecoration: 'underline dotted', textUnderlineOffset: 2 }
          : {})
      }}
    >
      {name}
    </Box>
  )
  if (depth > MAX_HOVER_DEPTH) return label
  return (
    <KnownItemTooltip name={name} depth={depth + 1}>
      {label}
    </KnownItemTooltip>
  )
}

/** `a`, `b` and `c` — outcome names, each independently hoverable. */
function Outcomes({ names, depth }: { names: string[]; depth: number }): JSX.Element | null {
  if (names.length === 0) return null
  return (
    <Typography component="div" sx={{ color: EQ_ITEM_COLORS.label, fontSize: 11, lineHeight: 1.4, pl: 1 }}>
      →{' '}
      {names.map((n, i) => (
        <Box component="span" key={n}>
          {i > 0 && ', '}
          <OutcomeName name={n} depth={depth} />
        </Box>
      ))}
    </Typography>
  )
}

/**
 * "What it's for" — the block BELOW the hairline. Quest uses first (they're the reason an item
 * is notable at all), then the recipes that consume it, which is the honest answer for the big
 * family of QUEST-ITEM-flagged tradeskill components. Renders nothing when we know nothing:
 * an empty block would read as "checked, nothing there", which we can't claim while a lookup
 * may simply have failed.
 */
function WhatItsFor({ data, depth }: { data: ItemKnowledge; depth: number }): JSX.Element | null {
  const uses = data.questUses
  const recipes = data.recipes ?? []
  if (uses.length === 0 && recipes.length === 0) return null

  const shownUses = uses.slice(0, MAX_LISTED)
  const shownRecipes = recipes.slice(0, MAX_LISTED)

  return (
    <Box sx={{ mt: 0.75, pt: 0.6, borderTop: '1px solid rgba(255,255,255,0.12)' }}>
      {shownUses.length > 0 && (
        <Box sx={{ mb: shownRecipes.length > 0 ? 0.6 : 0 }}>
          <Muted>Used in {uses.length === 1 ? 'quest' : 'quests'}:</Muted>
          {shownUses.map((u) => {
            const where = questUseWhere(u)
            return (
              <Box key={`${u.source}:${u.page ?? ''}:${u.quest}:${u.role ?? ''}`} sx={{ mt: 0.25 }}>
                <Typography component="div" sx={{ color: EQ_ITEM_COLORS.text, fontSize: 11, lineHeight: 1.4 }}>
                  {u.quest}
                  {u.role === 'reward' && (
                    <Box component="span" sx={{ color: EQ_ITEM_COLORS.label }}> · reward</Box>
                  )}
                  {where && <Box component="span" sx={{ color: EQ_ITEM_COLORS.label }}> · {where}</Box>}
                </Typography>
                {/* Turning it in yields these — one hop, each its own card. */}
                <Outcomes names={questUseOutcomes(u)} depth={depth} />
              </Box>
            )
          })}
          {uses.length > shownUses.length && <Muted>+{uses.length - shownUses.length} more</Muted>}
        </Box>
      )}

      {shownRecipes.length > 0 && (
        <Box>
          <Muted>Used in {recipes.length === 1 ? 'recipe' : 'recipes'}:</Muted>
          {shownRecipes.map((r) => {
            // `recipeUseLabel` is the ONE spelling of a recipe use ("Gnome Kabobs (Baking 56)").
            // Here the name is drawn separately (it's the hoverable crafted item), so the
            // tradeskill/trivial half is taken from the same fields the label uses.
            const how = [r.tradeskill, r.trivial != null ? String(r.trivial) : null].filter(Boolean).join(' ')
            return (
              <Typography
                key={`${r.tradeskill ?? ''}:${r.recipe}`}
                component="div"
                sx={{ color: EQ_ITEM_COLORS.label, fontSize: 11, lineHeight: 1.4, mt: 0.25 }}
              >
                {/* The recipe NAME is the crafted item — so it is the outcome, and hoverable. */}
                <OutcomeName name={r.recipe} depth={depth} />
                {how && <> · {how}</>}
              </Typography>
            )
          })}
          {recipes.length > shownRecipes.length && <Muted>+{recipes.length - shownRecipes.length} more</Muted>}
        </Box>
      )}
    </Box>
  )
}

/** The tooltip BODY: the game-style item window, then what our sources add beneath it. */
function KnownItemCard({
  name,
  knowledge,
  depth
}: {
  name: string
  knowledge?: ItemKnowledge
  depth: number
}): JSX.Element {
  const { data, loading } = useKnowledgeOnOpen(name, knowledge)
  return (
    <Box sx={{ p: 0.25, minWidth: 190 }}>
      {/* Both the module subscription (observed tier) and the lookup live INSIDE the body,
          so they exist only while this tooltip is open. */}
      <ObservedItemWindow
        name={name}
        stats={data?.stats}
        rawStats={data?.statsBlock}
        iconId={data?.iconId}
        flavor={data?.summary}
        compact
      />
      {loading && !data && (
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.5 }}>
          <CircularProgress size={11} sx={{ color: EQ_ITEM_COLORS.label }} />
          <Typography sx={{ color: EQ_ITEM_COLORS.label, fontSize: 11 }}>Looking up…</Typography>
        </Stack>
      )}
      {data && <WhatItsFor data={data} depth={depth} />}
      {data?.offline && (
        <Typography sx={{ color: EQ_ITEM_COLORS.label, fontSize: 10, mt: 0.4 }}>
          offline — showing what&apos;s known locally
        </Typography>
      )}
    </Box>
  )
}

export interface KnownItemTooltipProps {
  /** item name exactly as displayed (keeps its ` +N`) */
  name: string
  /** an already-fetched record, when the caller has one — skips the lookup entirely */
  knowledge?: ItemKnowledge
  /** nesting level; 0 = the card you hovered. Callers never pass this. */
  depth?: number
  /** the anchor: any single element that can hold a ref */
  children: ReactElement
}

/** Hover an item name → its EQ-style window plus what it's for. See the header for nesting. */
export function KnownItemTooltip({ name, knowledge, depth = 0, children }: KnownItemTooltipProps): JSX.Element {
  const nested = depth > 0
  return (
    <Tooltip
      title={<KnownItemCard name={name} knowledge={knowledge} depth={depth} />}
      arrow
      // The nested card opens to the SIDE and is NON-interactive: you read it in place, so the
      // outer card never has to surrender the pointer to keep it on screen.
      placement={nested ? 'right' : 'top'}
      disableInteractive={nested}
      enterDelay={nested ? 120 : 250}
      leaveDelay={nested ? 0 : 80}
      slotProps={{
        tooltip: {
          sx: {
            bgcolor: EQ_ITEM_COLORS.bg,
            border: `1px solid ${EQ_ITEM_COLORS.border}`,
            borderRadius: 1,
            maxWidth: 380,
            p: 1,
            boxShadow: 6
          }
        },
        arrow: { sx: { color: EQ_ITEM_COLORS.bg, '&::before': { border: `1px solid ${EQ_ITEM_COLORS.border}` } } }
      }}
    >
      {children}
    </Tooltip>
  )
}
