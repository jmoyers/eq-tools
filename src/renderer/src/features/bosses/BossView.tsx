import { useCallback, useMemo, useState } from 'react'
import {
  Box,
  Chip,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material'
import CheckIcon from '@mui/icons-material/Check'
import type {
  ConsiderDelta,
  ConsiderRow,
  ConsiderSnap,
  KillInfo,
  KillMap,
  MobKnowledge,
  RaidTarget
} from '@shared/types'
import { CONSIDER_FACTION_COLOR, CONSIDER_FACTION_LABEL, considerDifficultyShort } from '@shared/logEvents'
import { getBossData } from '../../data'
import { useBossKills } from './useBossKills'
import type { TargetStatus } from './bossStatus'
import { MobDetailDialog, type MobConsiderContext } from './MobDetailDialog'
import Confetti from '../../lib/Confetti'
import { KnownItemTooltip } from '../../lib/KnownItemTooltip'
import { useModule } from '../../lib/useModule'
import { tierStyle } from '../../lib/tierChip'
import { formatDate, formatDateTime, formatTime } from '../../lib/formatDate'
import { cachedImageUrl } from '../../lib/imageUrl'

// EQL raid progression order.
const CATEGORY_ORDER = ['Open World', 'Plane of Fear', 'Plane of Hate', 'Plane of Sky']

const DENSITY_KEY = 'eq.bossDensity'
type Density = 'compact' | 'comfortable'

const bosses = getBossData()

function BossImage({
  target,
  height,
  dim
}: {
  target: RaidTarget
  height: number
  dim?: boolean
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (target.image && !failed) {
    return (
      <Box
        component="img"
        // NEVER the raw `target.image`. `bosses.json` carries real wiki.project1999.com URLs
        // (scraped data stays honest), but a portrait must be downloaded at most ONCE ever —
        // so it is served from the app's permanent cache instead. A URL the main process
        // refuses, or a portrait that 404s, falls through to the initials tile below via
        // onError, exactly as before.
        src={cachedImageUrl(target.image)}
        alt={target.name}
        onError={() => setFailed(true)}
        sx={{
          width: '100%',
          height,
          objectFit: 'cover',
          objectPosition: 'top',
          display: 'block',
          filter: dim ? 'grayscale(1) brightness(0.5)' : 'none'
        }}
      />
    )
  }
  const initials = target.name
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
  return (
    <Box
      sx={{
        width: '100%',
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'action.hover',
        color: 'text.disabled',
        fontSize: height > 90 ? 26 : 18,
        fontWeight: 700
      }}
    >
      {initials}
    </Box>
  )
}

// ---- Recently considered (Task #63) ------------------------------------------------------
//
// The mobs domain's OTHER half. This tab already answers "which named things have I killed";
// the consider ring answers "what have I been sizing up, and is it worth killing" — the two
// belong on one screen, so this sits above the raid roster rather than inventing a tab.
//
// SIZE IS A CONTRACT: it is a FIXED-height scroll box (AGENTS.md — "a growing list lives in a
// fixed-height scroll box"), so a long session can never push the roster below the fold. It
// also renders NOTHING at all until something has been conned, so a player who never uses /con
// pays no vertical space for it.

/** How many rows fit before the strip scrolls, and how many drops one row names. */
const CONSIDER_STRIP_HEIGHT = 116
const CONSIDER_DROPS_SHOWN = 3

/** Merge a consider delta: upsert by row id, then re-order newest-first. */
function applyConsiderDelta(state: ConsiderSnap, delta: ConsiderDelta): ConsiderSnap {
  const byId = new Map(state.map((r) => [r.id, r]))
  for (const row of delta.upserted) byId.set(row.id, row)
  return [...byId.values()].sort((a, b) => a.ts - b.ts)
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
      <Tooltip title={`${CONSIDER_FACTION_LABEL[r.faction]} · ${r.difficulty} — click for drops`}>
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

function RecentlyConsidered({
  kills,
  onOpen
}: {
  kills: KillMap
  onOpen: (m: MobSelection) => void
}): JSX.Element | null {
  const rows = useModule<ConsiderSnap, ConsiderDelta>('consider', applyConsiderDelta)
  if (!rows || rows.length === 0) return null
  const newestFirst = rows.slice().reverse()
  const open = (r: ConsiderRow): void =>
    onOpen({
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
      // The KillMap is keyed by the canonical lowercase name (KillInfo.display) — the same
      // fold `mobKey` applies — so a considered mob finds its kills without a second index.
      kill: kills[r.mob.trim().toLowerCase()]
    })
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
          <ConsiderRowView key={r.id} r={r} onOpen={open} />
        ))}
      </Box>
    </Paper>
  )
}

/** What the mob dialog needs to open, from whichever surface asked for it. */
interface MobSelection {
  mob: string
  seed?: MobKnowledge
  con?: MobConsiderContext
  kill?: KillInfo
}

function TargetCard({
  s,
  compact,
  flash,
  onOpen
}: {
  s: TargetStatus
  compact: boolean
  flash?: boolean
  onOpen: (s: TargetStatus) => void
}): JSX.Element {
  const imgH = compact ? 70 : 120
  const tier = tierStyle(s.bestTier)
  const tierColor = tier.bg
  return (
    <Paper
      variant="outlined"
      // A raid target IS a mob, so it opens the same drop card a considered mob does. The card
      // had no click behaviour at all before, so this adds an affordance without taking one.
      onClick={() => onOpen(s)}
      title={`${s.target.name} — drops, quests, your kills`}
      sx={{
        overflow: 'hidden',
        position: 'relative',
        cursor: 'pointer',
        borderWidth: 2,
        borderColor: flash ? tierColor : s.killed ? tierColor : 'divider',
        boxShadow: flash
          ? `0 0 22px ${tierColor}, 0 0 8px ${tierColor}`
          : s.killed
            ? `0 0 10px ${tierColor}55`
            : 'none',
        transform: flash ? 'scale(1.04)' : 'none',
        transition: 'transform 200ms, box-shadow 200ms, border-color 200ms',
        '&:hover': { transform: flash ? 'scale(1.04)' : 'translateY(-2px)' }
      }}
    >
      {s.killed && (
        <Box
          sx={{
            position: 'absolute',
            top: 4,
            left: 4,
            zIndex: 1,
            width: 20,
            height: 20,
            borderRadius: '50%',
            bgcolor: tier.bg,
            color: tier.fg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: 1
          }}
        >
          <CheckIcon sx={{ fontSize: 14 }} />
        </Box>
      )}
      <Box sx={{ position: 'relative' }}>
        <BossImage target={s.target} height={imgH} dim={!s.killed} />
        <Tooltip title={s.killed ? tier.long : 'Not defeated'}>
          <Chip
            size="small"
            label={s.killed ? tier.label : 'not defeated'}
            sx={{
              position: 'absolute',
              top: 4,
              right: 4,
              height: 20,
              bgcolor: s.killed ? tier.bg : 'rgba(0,0,0,0.65)',
              color: s.killed ? tier.fg : '#fff',
              fontWeight: 700,
              fontSize: 11,
              '& .MuiChip-label': { px: 0.75 }
            }}
          />
        </Tooltip>
      </Box>
      <Box sx={{ p: compact ? 0.75 : 1 }}>
        <Typography
          variant={compact ? 'caption' : 'body2'}
          noWrap
          title={s.target.name}
          sx={{ fontWeight: 600, color: s.killed ? 'text.primary' : 'text.secondary' }}
        >
          {s.target.name}
        </Typography>
        {!compact && (
          <Typography variant="caption" color="text.secondary" noWrap display="block">
            {s.target.zone ?? ''}
          </Typography>
        )}
        {s.killed ? (
          <Tooltip
            title={
              s.firstTs && s.firstTs !== s.lastTs
                ? `First ${formatDateTime(s.firstTs)} · Last ${formatDateTime(s.lastTs)}`
                : `Defeated ${formatDateTime(s.lastTs || s.firstTs)}`
            }
          >
            <Typography variant="caption" color="text.secondary" noWrap display="block">
              {formatDate(s.lastTs || s.firstTs)}
              {!compact && ` · ${s.count} kill${s.count === 1 ? '' : 's'}`}
            </Typography>
          </Tooltip>
        ) : (
          !compact && (
            <Typography variant="caption" color="text.disabled" display="block">
              not defeated
            </Typography>
          )
        )}
      </Box>
    </Paper>
  )
}

export default function BossView(): JSX.Element {
  const [query, setQuery] = useState('')
  const [defeatedOnly, setDefeatedOnly] = useState(false)
  const [density, setDensity] = useState<Density>(
    () => (localStorage.getItem(DENSITY_KEY) as Density) || 'compact'
  )
  // Names of bosses currently flashing, and the id of the active confetti burst.
  const [flashing, setFlashing] = useState<Set<string>>(new Set())
  const [burst, setBurst] = useState<number | null>(null)

  // ANY live roster-boss kill (incl. a repeat at the same/lower tier, Task #24):
  // fire confetti over the view and flash the boss card for ~3s. The kills module
  // (via useBossKills) already gates out the historical baseline, so this only
  // fires for kills that happen while the app is open. The bossDefeat *sound* is
  // handled separately in App (new-tier defeats only).
  const onKill = useCallback((s: TargetStatus) => {
    setBurst((n) => (n ?? 0) + 1)
    setFlashing((prev) => new Set(prev).add(s.target.name))
    window.setTimeout(() => {
      setFlashing((prev) => {
        const next = new Set(prev)
        next.delete(s.target.name)
        return next
      })
    }, 3000)
  }, [])

  const { kills, statuses } = useBossKills(bosses.targets, { onKill })
  // The mob currently drilled into (from either surface), or null. ONE dialog for both.
  const [selected, setSelected] = useState<MobSelection | null>(null)

  const setDensityPersist = (d: Density | null): void => {
    if (!d) return
    localStorage.setItem(DENSITY_KEY, d)
    setDensity(d)
  }
  const compact = density === 'compact'

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = statuses
    if (defeatedOnly) list = list.filter((s) => s.killed)
    if (q) list = list.filter((s) => s.target.name.toLowerCase().includes(q))
    return list
  }, [statuses, query, defeatedOnly])

  const byCategory = useMemo(() => {
    const map = new Map<string, TargetStatus[]>()
    for (const s of filtered) {
      const arr = map.get(s.target.category) ?? []
      arr.push(s)
      map.set(s.target.category, arr)
    }
    return [...map.entries()].sort(
      (a, b) => (CATEGORY_ORDER.indexOf(a[0]) + 1 || 99) - (CATEGORY_ORDER.indexOf(b[0]) + 1 || 99)
    )
  }, [filtered])

  const defeated = statuses.filter((s) => s.killed).length
  const minCol = compact ? 116 : 180

  return (
    <Stack spacing={1.5} sx={{ height: '100%', position: 'relative' }}>
      {burst != null && <Confetti key={burst} onDone={() => setBurst(null)} />}
      <RecentlyConsidered kills={kills ?? {}} onOpen={setSelected} />
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <TextField
          size="small"
          label="Search target"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ minWidth: 200 }}
        />
        <FormControlLabel
          control={<Switch checked={defeatedOnly} onChange={(e) => setDefeatedOnly(e.target.checked)} />}
          label="Defeated only"
        />
        <ToggleButtonGroup
          size="small"
          exclusive
          value={density}
          onChange={(_e, v) => setDensityPersist(v)}
        >
          <ToggleButton value="compact">Compact</ToggleButton>
          <ToggleButton value="comfortable">Comfortable</ToggleButton>
        </ToggleButtonGroup>
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="body2" color="text.secondary">
          {defeated} / {statuses.length} defeated · badge = highest instance tier
        </Typography>
      </Stack>

      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        {byCategory.map(([category, list]) => (
          <Box key={category} sx={{ mb: compact ? 1.5 : 2.5 }}>
            <Typography variant="subtitle2" sx={{ mb: 0.75, color: 'primary.main' }}>
              {category}{' '}
              <Typography component="span" variant="caption" color="text.secondary">
                ({list.filter((s) => s.killed).length}/{list.length})
              </Typography>
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: `repeat(auto-fill, minmax(${minCol}px, 1fr))`,
                gap: compact ? 1 : 1.5
              }}
            >
              {list.map((s) => (
                <TargetCard
                  key={s.target.name}
                  s={s}
                  compact={compact}
                  flash={flashing.has(s.target.name)}
                  onOpen={(t) =>
                    setSelected({
                      mob: t.target.name,
                      // A roster card carries no consider (you may never have conned it), so the
                      // dialog simply renders without the con block — never with an invented one.
                      // The kill facts come from the status the roster already computed, which
                      // is article-insensitive matching the log's `match` names (bossStatus.ts).
                      kill: t.count > 0 ? { count: t.count, bestTier: t.bestTier, firstTs: t.firstTs, lastTs: t.lastTs, display: t.target.name } : undefined
                    })
                  }
                />
              ))}
            </Box>
          </Box>
        ))}
      </Box>

      {selected && (
        <MobDetailDialog
          open
          onClose={() => setSelected(null)}
          mob={selected.mob}
          seed={selected.seed}
          con={selected.con}
          kill={selected.kill}
        />
      )}
    </Stack>
  )
}
