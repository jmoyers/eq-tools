import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Chip,
  FormControlLabel,
  IconButton,
  MenuItem,
  Snackbar,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import AutoStoriesIcon from '@mui/icons-material/AutoStories'
import RefreshIcon from '@mui/icons-material/Refresh'
import type { CountSource, ItemKnowledge, LootDisposition, LootEvent } from '@shared/types'
import { recipeUseLabel } from '@shared/itemKnowledge'
import { useWindowedRows } from '../../lib/useWindowedRows'
import { normalizeQuery } from '../../lib/search'
import { itemCountKey } from '../../lib/itemName'
import { formatDateTime, formatTime } from '../../lib/formatDate'
import { getPoskyData } from '../../data'
import { useFavorites } from '../favorites/useFavorites'
import { FavoriteStar } from '../favorites/FavoriteStar'
import { useProgress } from '../posky/useProgress'
import type { InventoryRow } from '../inventory/reconcile'
import { ItemDetailDialog } from './ItemDetailDialog'
import { useNotablePickups, type NotablePickup } from './useNotablePickups'

const posky = getPoskyData()

// Names of every item required by a Plane of Sky quest (for highlighting). Keyed by the
// normalized counting key (Task #42) so an upgraded `Sphinx Claw +1` row is still flagged
// as a Sky quest item — the row keeps showing its `+N`; only the RECOGNITION is normalized.
const questItemNames = new Set<string>(posky.quests.flatMap((q) => q.items.map((i) => itemCountKey(i.name))))

// EQ stat block per item name (quest items + rewards), for the drill-down.
const itemStats: Record<string, string> = {}
for (const qz of posky.quests) {
  // Keyed by the normalized counting key so a `+N` variant drill-down resolves the base
  // item's stat block (Task #42).
  for (const it of qz.items) if (it.stats) itemStats[itemCountKey(it.name)] = it.stats
  if (qz.reward && qz.rewardStats) itemStats[itemCountKey(qz.reward)] = qz.rewardStats
}

// Fixed dense-row height (px) for the windowed tables (MUI Table size="small").
const ROW_HEIGHT = 37

// A loot event with two precomputed keys — computed ONCE per history change so the
// per-keystroke filter is a plain substring test (never re-lowercasing thousands of rows
// on every character typed).
//   itemKey  — raw lowercase; the GROUPING identity, so `Sphinx Claw +1` keeps its own row.
//   countKey — `+N`-stripped counting key (Task #42); the join key onto quest items and
//              onto the reconciled inventory rows, which are keyed the same way.
type KeyedLoot = LootEvent & { itemKey: string; countKey: string }

function fmtTime(ts: number): string {
  return formatDateTime(ts, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// A subtle disposition chip (Tasks #40/#47): where a looted-and-routed item went.
// Dense, low-emphasis — no chip for ordinary kept loot. Kept storage (currency/hoard/
// depot) reads info-blue; 'sold' (gone) is dimmed; 'combined' (merged into an upgrade)
// reads success-green.
function DispositionChip({ disposition }: { disposition?: LootDisposition }): JSX.Element | null {
  if (!disposition) return null
  const sx = { height: 18, fontSize: 11 } as const
  if (disposition === 'sold') {
    return <Chip size="small" variant="outlined" color="default" label="sold" sx={{ ...sx, opacity: 0.7 }} />
  }
  if (disposition === 'combined') {
    return <Chip size="small" variant="outlined" color="success" label="combined" sx={sx} />
  }
  return <Chip size="small" variant="outlined" color="info" label={disposition} sx={sx} />
}

function isQuestItem(name: string): boolean {
  return questItemNames.has(itemCountKey(name))
}

// A subtle indicator for an item the wiki knows is LORE or quest-relevant (Task #53),
// EXTENDING the local PoSky flag to any wiki-known quest item. Shown only when the async
// knowledge probe has resolved AND flags it; ordinary items render nothing (no noise).
// The PoSky chip already covers Sky items, so suppress a redundant "quest" badge there.
//
// Task #61: an item whose stats block says QUEST ITEM but which no quest anywhere uses is a
// TRADESKILL component (Gnome Meat → Gnome Kabobs). Those get a `tradeskill` chip naming
// the recipes instead of a "quest" chip that leads nowhere.
function KnowledgeBadge({ knowledge, isPosky }: { knowledge?: ItemKnowledge; isPosky: boolean }): JSX.Element | null {
  if (!knowledge) return null
  const recipes = knowledge.recipes ?? []
  const hasQuests = knowledge.questUses.length > 0
  const tradeskillOnly = recipes.length > 0 && !hasQuests
  const showQuest = (knowledge.quest || hasQuests) && !isPosky && !tradeskillOnly
  const showTradeskill = tradeskillOnly && !isPosky
  if (!knowledge.lore && !showQuest && !showTradeskill) return null
  const title = hasQuests
    ? `Used in: ${knowledge.questUses.map((u) => u.quest).join(', ')}`
    : showTradeskill
      ? `Used in: ${recipes.map(recipeUseLabel).join(', ')}`
      : knowledge.lore
        ? 'Lore item'
        : 'Quest item'
  return (
    <Tooltip title={title}>
      <Stack direction="row" spacing={0.5} alignItems="center" component="span">
        {knowledge.lore && (
          <Chip size="small" color="warning" variant="outlined" label="LORE" sx={{ height: 18, fontSize: 10 }} />
        )}
        {showQuest && (
          <Chip size="small" color="secondary" variant="outlined" label="quest" sx={{ height: 18, fontSize: 10 }} />
        )}
        {showTradeskill && (
          <Chip size="small" color="info" variant="outlined" label="tradeskill" sx={{ height: 18, fontSize: 10 }} />
        )}
      </Stack>
    </Tooltip>
  )
}

/**
 * The "In inventory" cell — an ESTIMATE, never a fact (world-model law 1). The number is
 * the reconciled net held count (inventory/reconcile.ts): the active count source (looted
 * log and/or the last `/outputfile inventory` export) minus everything consumed by a
 * turned-in quest. The log cannot see bank deposits, destroys, trades or vendor sales that
 * happen off-camera, so it renders as a `~` chip like every other inferred value, with the
 * inputs spelled out in the tooltip. `+N` upgrade variants pool onto the base counting key,
 * so a `Sphinx Claw` row and a `Sphinx Claw +1` row show the same pooled estimate.
 */
const InventoryEstimate = memo(function InventoryEstimate({ inv }: { inv?: InventoryRow }): JSX.Element {
  if (!inv || inv.net <= 0) return <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>
  const parts: string[] = [`${inv.log} looted`]
  if (inv.inv > 0) parts.push(`${inv.inv} in the inventory export`)
  if (inv.consumed > 0) parts.push(`${inv.consumed} turned in (${inv.consumedBy.join(', ')})`)
  return (
    <Tooltip title={`Estimate — ${parts.join(' · ')}`}>
      <Chip
        size="small"
        variant="outlined"
        label={`~${inv.net}`}
        sx={{ height: 18, fontSize: 11, cursor: 'help', color: 'text.secondary' }}
      />
    </Tooltip>
  )
})

interface GroupRow {
  /** Stable React key — the raw lowercase item name, or `inv:<countKey>` for an
   *  inventory-only row (which has no loot history to group). */
  key: string
  /** Normalized counting key — the join onto the reconciled inventory rows. */
  countKey: string
  item: string
  count: number
  last: number
  topSource?: string
  zoneCount: number
  disposition?: LootDisposition
  /** Held per the inventory export but never looted this epoch — no loot columns. */
  invOnly?: boolean
}

// "Notable pickups" strip (Task #53): the last few looted items that are lore- or
// quest-relevant. Dense, dismissable, no narration — a quiet "hey, that coin you grabbed
// is for the Tashania spell quest". Clicking a chip opens that item's detail dialog.
function NotablePickupsStrip({
  notable,
  onSelect,
  onDismiss
}: {
  notable: NotablePickup[]
  onSelect: (item: string) => void
  onDismiss: (key: string) => void
}): JSX.Element | null {
  if (notable.length === 0) return null
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
        {notable.slice(0, 8).map((n) => {
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
            <Chip
              key={key}
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
          )
        })}
      </Stack>
    </Box>
  )
}

// Memoized rows (React.memo + stable props) so a re-render that doesn't touch a
// given row's data skips it entirely (precedent: #17's combat work).
const GroupedRow = memo(function GroupedRow({
  g,
  favorited,
  knowledge,
  inv,
  onToggleFavorite,
  onSelect
}: {
  g: GroupRow
  favorited: boolean
  knowledge?: ItemKnowledge
  inv?: InventoryRow
  onToggleFavorite: (name: string) => void
  onSelect: (item: string) => void
}): JSX.Element {
  const posky = isQuestItem(g.item)
  return (
    <TableRow
      hover
      sx={{ cursor: 'pointer', height: ROW_HEIGHT, '& td': { py: 0 }, opacity: g.invOnly ? 0.7 : 1 }}
      onClick={() => onSelect(g.item)}
    >
      <TableCell padding="checkbox">
        <FavoriteStar name={g.item} favorited={favorited} onToggle={onToggleFavorite} />
      </TableCell>
      <TableCell>
        <Stack direction="row" spacing={1} alignItems="center">
          <span>{g.item}</span>
          {posky && <Chip size="small" color="primary" variant="outlined" label="PoSky" />}
          <KnowledgeBadge knowledge={knowledge} isPosky={posky} />
          <DispositionChip disposition={g.disposition} />
        </Stack>
      </TableCell>
      <TableCell align="right" sx={g.invOnly ? { color: 'text.disabled' } : undefined}>
        {g.invOnly ? '—' : g.count}
      </TableCell>
      <TableCell align="right">
        <InventoryEstimate inv={inv} />
      </TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{g.topSource ?? '—'}</TableCell>
      <TableCell align="right" sx={{ color: 'text.secondary' }}>
        {g.zoneCount || '—'}
      </TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{g.invOnly ? '—' : fmtTime(g.last)}</TableCell>
    </TableRow>
  )
})

const FlatRow = memo(function FlatRow({
  e,
  favorited,
  knowledge,
  onToggleFavorite,
  onSelect
}: {
  e: LootEvent
  favorited: boolean
  knowledge?: ItemKnowledge
  onToggleFavorite: (name: string) => void
  onSelect: (item: string) => void
}): JSX.Element {
  const posky = isQuestItem(e.item)
  return (
    <TableRow
      hover
      sx={{ cursor: 'pointer', height: ROW_HEIGHT, '& td': { py: 0 } }}
      onClick={() => onSelect(e.item)}
    >
      <TableCell padding="checkbox">
        <FavoriteStar name={e.item} favorited={favorited} onToggle={onToggleFavorite} />
      </TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{fmtTime(e.ts)}</TableCell>
      <TableCell>
        <Stack direction="row" spacing={1} alignItems="center">
          <span>{e.count && e.count > 1 ? `${e.count} × ${e.item}` : e.item}</span>
          {posky && <Chip size="small" color="primary" variant="outlined" label="PoSky" />}
          <KnowledgeBadge knowledge={knowledge} isPosky={posky} />
          <DispositionChip disposition={e.disposition} />
          {e.disposition === 'combined' && e.created && (
            <Typography variant="caption" color="text.secondary">
              → {e.created}
            </Typography>
          )}
        </Stack>
      </TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{e.source ?? '—'}</TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{e.zone ?? '—'}</TableCell>
    </TableRow>
  )
})

export default function LootView(): JSX.Element {
  const { isFavorite, toggle: toggleFavorite } = useFavorites()
  // ONE subscription to the loot module: useProgress already owns it (and needs it for the
  // reconcile), so the merged view reads its history from there rather than holding a
  // second copy of the full loot snapshot.
  const {
    lootHistory: history,
    inventoryRows,
    countSource,
    setCountSource,
    reloadInventory,
    inventoryInfo
  } = useProgress()
  const [query, setQuery] = useState('')
  const [groupByItem, setGroupByItem] = useState(true)
  const [questOnly, setQuestOnly] = useState(false)
  const [showInventoryOnly, setShowInventoryOnly] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // When main auto-reloads the *-Inventory.txt (chokidar watch), surface it quietly.
  const [autoUpdatedAt, setAutoUpdatedAt] = useState<number | null>(null)
  // "Notable pickups" (Task #53): probe the most-recent distinct looted items for
  // lore/quest knowledge (main: local-posky-first + cached wiki). Dismissed keys hide
  // from the strip. `byKey` also feeds the per-row LORE/quest indicator.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const { byKey: knowledgeByKey, notable } = useNotablePickups(history, dismissed)

  useEffect(() => {
    const off = window.eq.onInventoryReload(() => setAutoUpdatedAt(Date.now()))
    return off
  }, [])

  const onReload = async (): Promise<void> => setToast(await reloadInventory())

  // Typing echoes IMMEDIATELY (local `query` state); the filter consumes a DEFERRED
  // copy so a keystroke never blocks on the filter + re-render (Task #41).
  const deferredQuery = useDeferredValue(query)
  const q = normalizeQuery(deferredQuery)

  // Precompute the lowercase + counting keys ONCE per history change (not per keystroke).
  const keyed = useMemo<KeyedLoot[]>(
    () => history.map((e) => ({ ...e, itemKey: e.item.toLowerCase(), countKey: itemCountKey(e.item) })),
    [history]
  )

  // countKey → reconciled inventory row, rebuilt ONCE per inventory change so the estimate
  // lookup stays O(1) per rendered row (the table is windowed; never scan per row).
  const invByKey = useMemo(() => {
    const m = new Map<string, InventoryRow>()
    for (const r of inventoryRows) m.set(r.key, r)
    return m
  }, [inventoryRows])

  // Every counting key that appears in loot history, so "inventory-only" means exactly
  // "held per the export but never looted this epoch".
  const lootCountKeys = useMemo(() => new Set(keyed.map((e) => e.countKey)), [keyed])

  const invOnlySource = useMemo(
    () => inventoryRows.filter((r) => r.net > 0 && !lootCountKeys.has(r.key)),
    [inventoryRows, lootCountKeys]
  )

  const events = useMemo(() => {
    let list: KeyedLoot[] = keyed
    if (questOnly) list = list.filter((e) => questItemNames.has(e.countKey))
    if (q) list = list.filter((e) => e.itemKey.includes(q))
    return [...list].reverse() // most recent first
  }, [keyed, q, questOnly])

  const grouped = useMemo(() => {
    interface Group {
      item: string
      countKey: string
      count: number
      last: number
      sources: Map<string, number>
      zones: Set<string>
      /** Distinct dispositions seen across the group's rows (undefined = kept). */
      dispositions: Set<LootDisposition | undefined>
    }
    const map = new Map<string, Group>()
    for (const e of events) {
      const key = e.itemKey
      let cur = map.get(key)
      if (!cur) {
        cur = {
          item: e.item,
          countKey: e.countKey,
          count: 0,
          last: 0,
          sources: new Map(),
          zones: new Set(),
          dispositions: new Set()
        }
        map.set(key, cur)
      }
      // Stacked loots count their stack size (Task #47): "2 Bone Chips" is two items.
      cur.count += e.count ?? 1
      cur.last = Math.max(cur.last, e.ts)
      if (e.source) cur.sources.set(e.source, (cur.sources.get(e.source) ?? 0) + 1)
      if (e.zone) cur.zones.add(e.zone)
      cur.dispositions.add(e.disposition)
    }
    const list: GroupRow[] = [...map.entries()].map(([key, g]) => {
      const topSource = [...g.sources.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      // The group's dominant disposition — shown only when ALL of its rows share one, so a
      // mixed item (some kept, some sold) stays unlabeled rather than mislabeled.
      const disposition = g.dispositions.size === 1 ? [...g.dispositions][0] : undefined
      return {
        key,
        countKey: g.countKey,
        item: g.item,
        count: g.count,
        last: g.last,
        topSource,
        zoneCount: g.zones.size,
        disposition
      }
    })
    list.sort((a, b) => b.count - a.count || b.last - a.last)
    // Pin favorites to the top (stable).
    return list.sort((a, b) => Number(isFavorite(b.item)) - Number(isFavorite(a.item)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, isFavorite])

  // Opt-in tail of items the inventory export knows about but that were never looted this
  // epoch (bank stock, pre-epoch gear). Kept OUT of the default view so the Loot table
  // stays a loot table; the chip says how many are hiding. Already net-desc from reconcile.
  const invOnlyRows = useMemo<GroupRow[]>(() => {
    if (!showInventoryOnly) return []
    let list = invOnlySource
    if (questOnly) list = list.filter((r) => questItemNames.has(r.key))
    if (q) list = list.filter((r) => r.name.toLowerCase().includes(q))
    const rows: GroupRow[] = list.map((r) => ({
      key: `inv:${r.key}`,
      countKey: r.key,
      item: r.name,
      count: 0,
      last: 0,
      zoneCount: 0,
      invOnly: true
    }))
    return rows.sort((a, b) => Number(isFavorite(b.item)) - Number(isFavorite(a.item)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showInventoryOnly, invOnlySource, questOnly, q, isFavorite])

  const groupRows = useMemo(
    () => (invOnlyRows.length === 0 ? grouped : [...grouped, ...invOnlyRows]),
    [grouped, invOnlyRows]
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  // Window whichever list is active — only the rows intersecting the viewport are
  // mounted, so a filter keystroke never mounts hundreds of MUI rows synchronously.
  const rowCount = groupByItem ? groupRows.length : events.length
  const win = useWindowedRows({ count: rowCount, rowHeight: ROW_HEIGHT, scrollRef })

  return (
    <Stack spacing={2} sx={{ height: '100%' }}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <TextField
          size="small"
          label="Search looted item"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ minWidth: 260 }}
        />
        <FormControlLabel
          control={<Switch checked={groupByItem} onChange={(e) => setGroupByItem(e.target.checked)} />}
          label="Group by item"
        />
        <FormControlLabel
          control={<Switch checked={questOnly} onChange={(e) => setQuestOnly(e.target.checked)} />}
          label="Only Plane of Sky items"
        />
        {groupByItem && invOnlySource.length > 0 && (
          <Tooltip title="Items your inventory export holds that you haven't looted this epoch — appended below the looted rows.">
            <Chip
              size="small"
              variant={showInventoryOnly ? 'filled' : 'outlined'}
              color={showInventoryOnly ? 'primary' : 'default'}
              label={`+${invOnlySource.length.toLocaleString()} in inventory only`}
              onClick={() => setShowInventoryOnly((v) => !v)}
            />
          </Tooltip>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title="Which source feeds the 'In inventory' estimate (and Plane of Sky progress). Log = everything you've looted; Inventory = your last /outputfile dump; Both = the higher.">
          <TextField
            select
            size="small"
            label="Count from"
            value={countSource}
            onChange={(e) => setCountSource(e.target.value as CountSource)}
            sx={{ minWidth: 150 }}
          >
            <MenuItem value="log">Log (looted)</MenuItem>
            <MenuItem value="inventory">Inventory export</MenuItem>
            <MenuItem value="both">Both (max)</MenuItem>
          </TextField>
        </Tooltip>
        <Tooltip title="Run /outputfile inventory in-game, then reload">
          <IconButton size="small" onClick={onReload}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      <Typography variant="body2" color="text.secondary">
        {history.length.toLocaleString()} loot events · {grouped.length.toLocaleString()} unique items · click a
        row for mob/zone/drop-rate breakdown ·{' '}
        {inventoryInfo
          ? `inventory export ${formatDateTime(new Date(inventoryInfo.loadedAt).getTime())}`
          : 'no inventory export loaded'}
        {autoUpdatedAt && (
          <Typography component="span" variant="body2" sx={{ color: 'success.main' }}>
            {' '}· auto-updated {formatTime(autoUpdatedAt)}
          </Typography>
        )}
      </Typography>

      <NotablePickupsStrip
        notable={notable}
        onSelect={setSelected}
        onDismiss={(key) => setDismissed((prev) => new Set(prev).add(key))}
      />

      {history.length === 0 && (
        <Alert severity="info">
          No loot parsed yet. Loot something in-game (or check your log path) — every{' '}
          <code>--You have looted …--</code> line shows up here in real time, and the full history is read
          from your log on launch.
        </Alert>
      )}

      {/* The scroll container owns the ref the windowing hook reads. Spacer rows
          (top/bottom) reserve the full scroll height so only the visible slice of
          MUI rows is mounted — see useWindowedRows. */}
      <Box ref={scrollRef} sx={{ flexGrow: 1, overflow: 'auto' }}>
        {groupByItem ? (
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell>Item</TableCell>
                <TableCell align="right">Times looted</TableCell>
                <Tooltip title="Estimated count still on you: the active count source minus anything consumed by a turned-in quest. Inferred, not observed — the log never sees bank deposits, trades or destroys.">
                  <TableCell align="right">In inventory</TableCell>
                </Tooltip>
                <TableCell>Top source</TableCell>
                <TableCell align="right">Zones</TableCell>
                <TableCell>Last looted</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {win.topPad > 0 && (
                <TableRow style={{ height: win.topPad }}>
                  <TableCell colSpan={7} sx={{ p: 0, border: 0 }} />
                </TableRow>
              )}
              {groupRows.slice(win.start, win.end).map((g) => (
                <GroupedRow
                  key={g.key}
                  g={g}
                  favorited={isFavorite(g.item)}
                  knowledge={knowledgeByKey.get(g.countKey)}
                  inv={invByKey.get(g.countKey)}
                  onToggleFavorite={toggleFavorite}
                  onSelect={setSelected}
                />
              ))}
              {win.bottomPad > 0 && (
                <TableRow style={{ height: win.bottomPad }}>
                  <TableCell colSpan={7} sx={{ p: 0, border: 0 }} />
                </TableRow>
              )}
            </TableBody>
          </Table>
        ) : (
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell sx={{ width: 150 }}>Time</TableCell>
                <TableCell>Item</TableCell>
                <TableCell>From</TableCell>
                <TableCell>Zone</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {win.topPad > 0 && (
                <TableRow style={{ height: win.topPad }}>
                  <TableCell colSpan={5} sx={{ p: 0, border: 0 }} />
                </TableRow>
              )}
              {events.slice(win.start, win.end).map((e, i) => (
                <FlatRow
                  key={`${e.ts}-${e.item}-${win.start + i}`}
                  e={e}
                  favorited={isFavorite(e.item)}
                  knowledge={knowledgeByKey.get(e.countKey)}
                  onToggleFavorite={toggleFavorite}
                  onSelect={setSelected}
                />
              ))}
              {win.bottomPad > 0 && (
                <TableRow style={{ height: win.bottomPad }}>
                  <TableCell colSpan={5} sx={{ p: 0, border: 0 }} />
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </Box>

      {selected && (
        <ItemDetailDialog
          open
          onClose={() => setSelected(null)}
          item={selected}
          events={history.filter((e) => e.item.toLowerCase() === selected.toLowerCase())}
          stats={itemStats[itemCountKey(selected)]}
          isQuestItem={questItemNames.has(itemCountKey(selected))}
        />
      )}

      <Snackbar
        open={!!toast}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        message={toast ?? ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Stack>
  )
}
