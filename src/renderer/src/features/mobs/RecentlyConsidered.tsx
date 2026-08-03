// RecentlyConsidered (Task #63; moved here from BossView in Task #64) — "what have I been
// sizing up".
//
// It shipped on the Raid Targets tab because that tab already answered the OTHER mob question
// ("which named things have I killed") and a con strip needed a home. It now has a real one:
// considering is the everyday form of looking a creature up, so it belongs on the tab whose
// whole job is creature knowledge, beside the search box that answers the same question
// deliberately. Raid Targets goes back to being about raid progression only.
//
// SIZE IS A CONTRACT: a FIXED-height scroll box (AGENTS.md — "a growing list lives in a
// fixed-height scroll box"), so a long session can never push the rest of the tab below the
// fold. It also renders NOTHING at all until something has been conned, so a player who never
// uses /con pays no vertical space for it.
//
// WHAT A CON IS FOR, HERE (owner decision, 2026-08-03). The con's DIFFICULTY verdict — "suicide",
// "might win", "safe" — is ephemeral: it is a statement about the gap between your level and the
// mob's ON THE DAY YOU CONNED IT, and it is wrong the moment you ding. The DURABLE facts the con
// line carried are the mob's NAME and its LEVEL; the difficulty clause is just the conduit that
// delivered them. So the row shows name + level + when you conned it, and the classification is
// no longer rendered at all (the module still captures it — this is a display decision, not a
// data-model one). The app's faction palette went with it: coloring a name by faction made the
// strip read as a threat meter, which is exactly the ephemeral claim we stopped making.
//
// TYPOGRAPHY: these rows sit directly under the zone roster, so they use the SAME hierarchy as
// MobResultRow — semibold body2 name, caption metadata, theme text colors only.

import type { JSX } from 'react'
import { Box, Chip, Paper, Stack, Tooltip, Typography } from '@mui/material'
import type { ConsiderDelta, ConsiderRow, ConsiderSnap, KillMap } from '@shared/types'
import { CONSIDER_FACTION_LABEL } from '@shared/logEvents'
import { KnownItemTooltip } from '../../lib/KnownItemTooltip'
import { formatAge, formatDateTime } from '../../lib/formatDate'
import type { MobTarget } from './mobTarget'

/** How many rows fit before the strip scrolls, and how many drops one row names. */
const CONSIDER_STRIP_HEIGHT = 148
const CONSIDER_DROPS_SHOWN = 3

/** Merge a consider delta: upsert by row id, then re-order newest-first. */
export function applyConsiderDelta(state: ConsiderSnap, delta: ConsiderDelta): ConsiderSnap {
  const byId = new Map(state.map((r) => [r.id, r]))
  for (const row of delta.upserted) byId.set(row.id, row)
  return [...byId.values()].sort((a, b) => a.ts - b.ts)
}

/** The MobTarget a considered row opens — everything the log line and the enrichment knew. */
export function considerTarget(r: ConsiderRow, kills: KillMap): MobTarget {
  return {
    mob: r.mob,
    seed: r.knowledge,
    con: {
      faction: r.faction,
      level: r.level,
      rare: r.rare,
      difficulty: r.difficulty,
      cons: r.cons,
      zone: r.zone
    },
    // The KillMap is keyed by the canonical lowercase name (KillInfo.display) — the same fold
    // `mobKey` applies — so a considered mob finds its kills without a second index.
    kill: kills[r.mob.trim().toLowerCase()]
  }
}

/** The drop names to show, plus the per-item counts YOUR history corroborates them with. */
interface RowDrops {
  /** every drop name, wiki-first */
  all: string[]
  /** lowercased item name -> your own sighting (count) */
  seenByKey: Map<string, { item: string; count: number }>
}

/**
 * WIKI DROPS LEAD — the page's drop table is the definitive statement of what this can drop.
 * Your own history is corroboration: it annotates a listed drop with a count, and only
 * contributes NAMES of its own for items the page doesn't list.
 */
function rowDrops(k: ConsiderRow['knowledge']): RowDrops {
  const seen = k?.dropsSeen ?? []
  const seenByKey = new Map(seen.map((d) => [d.item.toLowerCase(), d]))
  const wiki = (k?.dropsWiki ?? []).map((d) => d.item)
  const wikiKeys = new Set(wiki.map((i) => i.toLowerCase()))
  const all = [...wiki, ...seen.filter((d) => !wikiKeys.has(d.item.toLowerCase())).map((d) => d.item)]
  return { all, seenByKey }
}

/** The `drops: a, b, c +N` tail of a row. Renders nothing when nothing is known (law 1). */
function DropsLine({ drops }: { drops: RowDrops }): JSX.Element | null {
  const shown = drops.all.slice(0, CONSIDER_DROPS_SHOWN)
  if (shown.length === 0) return null
  return (
    <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
      drops:{' '}
      {shown.map((item, i) => {
        const mine = drops.seenByKey.get(item.toLowerCase())
        return (
          <Box component="span" key={item}>
            {i > 0 && ', '}
            {/* The SAME item card the loot table and the posky tooltip use — hover explains. */}
            <KnownItemTooltip name={item}>
              <Box component="span" sx={{ color: 'text.primary', cursor: 'help' }}>
                {item}
              </Box>
            </KnownItemTooltip>
            {/* Corroboration rides ON the definitive row, never in place of it. */}
            {mine && (
              <Box component="span" sx={{ color: 'success.main' }}>
                {' '}
                ×{mine.count}
              </Box>
            )}
          </Box>
        )
      })}
      {drops.all.length > shown.length && ` +${drops.all.length - shown.length}`}
    </Typography>
  )
}

/**
 * One considered mob: name, LEVEL, and when you conned it. Everything shown came off the log
 * line (name, level, rare) except the drops, which arrive asynchronously from mobLookup — so a
 * row is complete and useful the instant it appears and only gets richer. Nothing renders for a
 * source that said nothing (law 1): no drops known ⇒ no drops line, not "no drops".
 *
 * The faction rung survives only as hover text, where it is honest about being a hint rather
 * than the row's headline; the difficulty verdict is not shown at all (see the file header).
 */
function ConsiderRowView({ r, onOpen }: { r: ConsiderRow; onOpen: (r: ConsiderRow) => void }): JSX.Element {
  const k = r.knowledge
  const drops = rowDrops(k)
  const quests = k?.quests ?? []

  return (
    <Stack direction="row" spacing={1} alignItems="baseline" sx={{ py: 0.25, minWidth: 0 }}>
      <Tooltip title={`${CONSIDER_FACTION_LABEL[r.faction]} — click to open its page`}>
        <Typography
          variant="body2"
          role="button"
          tabIndex={0}
          onClick={() => onOpen(r)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onOpen(r)
          }}
          sx={{
            fontWeight: 600,
            flexShrink: 0,
            cursor: 'pointer',
            '&:hover': { textDecoration: 'underline' }
          }}
        >
          {r.mob}
        </Typography>
      </Tooltip>
      {r.level != null && (
        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
          Lvl {r.level}
        </Typography>
      )}
      {r.rare && (
        <Chip size="small" label="rare" sx={{ height: 16, fontSize: 10, '& .MuiChip-label': { px: 0.5 } }} />
      )}
      {quests.length > 0 && (
        <Tooltip title={quests.map((q) => q.quest).join(' · ')}>
          <Chip
            size="small"
            color="success"
            variant="outlined"
            label={quests.length === 1 ? 'quest' : `${quests.length} quests`}
            sx={{ height: 16, fontSize: 10, '& .MuiChip-label': { px: 0.5 } }}
          />
        </Tooltip>
      )}
      <DropsLine drops={drops} />
      <Box sx={{ flexGrow: 1 }} />
      {/* WHEN, coarsely — "conned 12m ago" answers "was that this camp or this morning?" far
          better than a wall clock does. The exact local time is one hover away. */}
      <Tooltip title={formatDateTime(r.ts)}>
        <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0 }}>
          {r.cons > 1 && `×${r.cons} · `}
          conned {formatAge(r.ts)}
        </Typography>
      </Tooltip>
    </Stack>
  )
}

export function RecentlyConsidered({
  rows,
  kills,
  onOpen
}: {
  /** the consider ring, oldest-first (the module's own order) — subscribed by the view */
  rows: ConsiderSnap
  kills: KillMap
  onOpen: (t: MobTarget) => void
}): JSX.Element | null {
  if (rows.length === 0) return null
  const newestFirst = rows.slice().reverse()
  return (
    <Paper variant="outlined" sx={{ p: 1, flexShrink: 0 }}>
      <Typography variant="subtitle2" sx={{ color: 'primary.main', mb: 0.5 }}>
        Recently considered{' '}
        <Typography component="span" variant="caption" color="text.secondary">
          ({newestFirst.length})
        </Typography>
      </Typography>
      <Box sx={{ maxHeight: CONSIDER_STRIP_HEIGHT, overflow: 'auto' }}>
        {newestFirst.map((r) => (
          <ConsiderRowView key={r.id} r={r} onOpen={(row) => onOpen(considerTarget(row, kills))} />
        ))}
      </Box>
    </Paper>
  )
}

// MOST CONSIDERED is DELETED (owner decision, 2026-08-03). It was the same ring asked "what do
// you keep coming back to" and rendered as a chip cloud above the fold — a question nobody was
// asking, occupying the space the zone roster now uses. The ring itself is unchanged; only this
// second view of it is gone. See MobsView's header for the browse surface it made room for.
