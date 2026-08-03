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

import { Box, Chip, Paper, Stack, Tooltip, Typography } from '@mui/material'
import type { ConsiderDelta, ConsiderRow, ConsiderSnap, KillMap } from '@shared/types'
import { CONSIDER_FACTION_COLOR, CONSIDER_FACTION_LABEL, considerDifficultyShort } from '@shared/logEvents'
import { KnownItemTooltip } from '../../lib/KnownItemTooltip'
import { formatTime } from '../../lib/formatDate'
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

/**
 * One considered mob. Everything shown came off the log line (name, rung, level, difficulty,
 * rare) except the drops, which arrive asynchronously from mobLookup — so a row is complete and
 * useful the instant it appears and only gets richer. Nothing renders for a source that said
 * nothing (law 1): no drops known ⇒ no drops line, not "no drops".
 */
function ConsiderRowView({ r, onOpen }: { r: ConsiderRow; onOpen: (r: ConsiderRow) => void }): JSX.Element {
  const color = CONSIDER_FACTION_COLOR[r.faction]
  const k = r.knowledge
  // WIKI DROPS LEAD — the page's drop table is the definitive statement of what this can drop.
  // Your own history is corroboration: it annotates a listed drop with a count, and only
  // contributes NAMES of its own for items the page doesn't list.
  const seen = k?.dropsSeen ?? []
  const seenByKey = new Map(seen.map((d) => [d.item.toLowerCase(), d]))
  const wiki = (k?.dropsWiki ?? []).map((d) => d.item)
  const wikiKeys = new Set(wiki.map((i) => i.toLowerCase()))
  const drops = [...wiki, ...seen.filter((d) => !wikiKeys.has(d.item.toLowerCase())).map((d) => d.item)]
  const shown = drops.slice(0, CONSIDER_DROPS_SHOWN)
  const quests = k?.quests ?? []

  return (
    <Stack direction="row" spacing={0.75} alignItems="baseline" sx={{ py: 0.25, minWidth: 0 }}>
      <Tooltip title={`${CONSIDER_FACTION_LABEL[r.faction]} · ${r.difficulty} — click to open its page`}>
        <Typography
          variant="caption"
          role="button"
          tabIndex={0}
          onClick={() => onOpen(r)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onOpen(r)
          }}
          sx={{
            color,
            fontWeight: 700,
            flexShrink: 0,
            cursor: 'pointer',
            '&:hover': { textDecoration: 'underline' }
          }}
        >
          {r.mob}
        </Typography>
      </Tooltip>
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
        {r.level != null && `Lvl ${r.level} · `}
        {considerDifficultyShort(r.difficulty) ?? r.difficulty}
      </Typography>
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
      {shown.length > 0 && (
        <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
          drops:{' '}
          {shown.map((item, i) => {
            const mine = seenByKey.get(item.toLowerCase())
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
          {drops.length > shown.length && ` +${drops.length - shown.length}`}
        </Typography>
      )}
      <Box sx={{ flexGrow: 1 }} />
      <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0 }}>
        {r.cons > 1 && `×${r.cons} · `}
        {formatTime(r.ts)}
      </Typography>
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

/**
 * MOST CONSIDERED — the same ring, asked a different question. "Recently" answers what you were
 * just doing; this answers what you keep coming back to, which in practice is the camp you are
 * actually working. Rows conned ONCE are excluded: a single con is a glance, not a pattern, and
 * including them would just re-print the recent list in a different order.
 */
export function MostConsidered({
  rows,
  kills,
  onOpen
}: {
  rows: ConsiderSnap
  kills: KillMap
  onOpen: (t: MobTarget) => void
}): JSX.Element | null {
  const repeats = rows.filter((r) => r.cons > 1).sort((a, b) => b.cons - a.cons || b.ts - a.ts)
  if (repeats.length === 0) return null
  return (
    <Paper variant="outlined" sx={{ p: 1, flexShrink: 0 }}>
      <Typography variant="subtitle2" sx={{ color: 'primary.main', mb: 0.75 }}>
        Most considered
      </Typography>
      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
        {repeats.slice(0, 12).map((r) => (
          <Chip
            key={r.id}
            size="small"
            variant="outlined"
            clickable
            onClick={() => onOpen(considerTarget(r, kills))}
            label={`${r.mob} ×${r.cons}`}
            sx={{
              height: 22,
              color: CONSIDER_FACTION_COLOR[r.faction],
              borderColor: CONSIDER_FACTION_COLOR[r.faction]
            }}
          />
        ))}
      </Stack>
    </Paper>
  )
}
