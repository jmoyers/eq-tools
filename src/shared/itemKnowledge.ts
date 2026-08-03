// The "notable pickup" predicate (Task #53), shared by main and the renderer.
//
// It used to live only in features/loot/useNotablePickups.ts, but the event-log overlay's
// feed module (main-side) needs the SAME rule — a notable loot is a feed event. One
// definition, imported by both, so the strip and the feed can never disagree about what
// counts as notable.

import type { ItemKnowledge, ItemRecipeUse } from './types'

/** Is a knowledge record "notable" (worth flagging / listing)? Lore, quest-flagged, or used
 *  by at least one known quest. Everything else is ordinary vendor trash.
 *
 *  Tradeskill recipes deliberately do NOT make an item notable: this predicate drives the
 *  PUSH surfaces (the pickups strip, the event-log feed), and every bone chip / spider leg
 *  in the game is a recipe ingredient. Recipes answer "what is it for" on the PULL surfaces
 *  (the item dialog, the row tooltip) instead. */
export function isNotableKnowledge(k: ItemKnowledge): boolean {
  return k.lore || k.quest || k.questUses.length > 0
}

/** ONE spelling of a recipe use: `Gnome Kabobs (Baking 56)`. Degrades as the page does —
 *  no tradeskill / no trivial simply drops out, never a guess. */
export function recipeUseLabel(r: ItemRecipeUse): string {
  const inner = [r.tradeskill, r.trivial != null ? String(r.trivial) : null].filter(Boolean).join(' ')
  return inner ? `${r.recipe} (${inner})` : r.recipe
}

/** ONE spelling of "how this item is made": `Baking 56 (Oven)`, joined with ` · ` across
 *  recipes, or the prose fallback. Undefined when the page said nothing. */
export function craftedByLabel(k: ItemKnowledge): string | undefined {
  const made = (k.craftedBy ?? [])
    .map((c) => {
      const head = [c.tradeskill, c.trivial != null ? String(c.trivial) : null].filter(Boolean).join(' ')
      return c.container ? `${head} (${c.container})` : head
    })
    .filter(Boolean)
  if (made.length > 0) return made.join(' · ')
  return k.craftedNote
}
