import { type JSX, useEffect, useRef, useState } from 'react'
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
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import type { CountSource } from '@shared/types'
import { useWindowedRows } from '../../lib/useWindowedRows'
import { itemCountKey } from '../../lib/itemName'
import { formatDateTime, formatTime } from '../../lib/formatDate'
import { useFavorites } from '../favorites/useFavorites'
import { useProgress } from '../posky/useProgress'
import { ItemDetailDialog } from './ItemDetailDialog'
import { itemStats, questItemNames } from './lootItemData'
import { ROW_HEIGHT } from './lootRows'
import { LootTable } from './LootTables'
import { NotablePickupsStrip, useNotableStrip } from './NotablePickupsStrip'
import { useLootRows } from './useLootRows'

// The filter bar: search, the two view switches, the opt-in inventory-only chip, and the
// count-source select that decides what "In inventory" is even counting.
function LootToolbar({
  query,
  setQuery,
  groupByItem,
  setGroupByItem,
  questOnly,
  setQuestOnly,
  invOnlyCount,
  showInventoryOnly,
  onToggleInventoryOnly,
  countSource,
  setCountSource,
  onReload
}: {
  query: string
  setQuery: (v: string) => void
  groupByItem: boolean
  setGroupByItem: (v: boolean) => void
  questOnly: boolean
  setQuestOnly: (v: boolean) => void
  invOnlyCount: number
  showInventoryOnly: boolean
  onToggleInventoryOnly: () => void
  countSource: CountSource
  setCountSource: (s: CountSource) => void
  onReload: () => void
}): JSX.Element {
  return (
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
      {groupByItem && invOnlyCount > 0 && (
        <Tooltip title="Items your inventory export holds that you haven't looted this epoch — appended below the looted rows.">
          <Chip
            size="small"
            variant={showInventoryOnly ? 'filled' : 'outlined'}
            color={showInventoryOnly ? 'primary' : 'default'}
            label={`+${invOnlyCount.toLocaleString()} in inventory only`}
            onClick={onToggleInventoryOnly}
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
  )
}

// The one-line ledger caption. `autoUpdatedAt` is set when main's chokidar watch re-read the
// *-Inventory.txt underneath us — surfaced quietly, in success-green, rather than as a toast.
function LootSummary({
  eventCount,
  uniqueCount,
  inventoryInfo,
  autoUpdatedAt
}: {
  eventCount: number
  uniqueCount: number
  inventoryInfo?: { path: string; loadedAt: string }
  autoUpdatedAt: number | null
}): JSX.Element {
  return (
    <Typography variant="body2" color="text.secondary">
      {eventCount.toLocaleString()} loot events · {uniqueCount.toLocaleString()} unique items · click a
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
  )
}

// Nothing parsed yet is a STATE, not an error: say where the rows will come from.
function NoLootYet(): JSX.Element {
  return (
    <Alert severity="info">
      No loot parsed yet. Loot something in-game (or check your log path) — every{' '}
      <code>--You have looted …--</code> line shows up here in real time, and the full history is read
      from your log on launch.
    </Alert>
  )
}

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
  const { knowledgeByKey, strip } = useNotableStrip(history)
  const { events, grouped, groupRows, invOnlySource, invByKey } = useLootRows({
    history,
    inventoryRows,
    query,
    questOnly,
    showInventoryOnly,
    isFavorite
  })

  useEffect(() => {
    const off = window.eq.onInventoryReload(() => setAutoUpdatedAt(Date.now()))
    return off
  }, [])

  const onReload = async (): Promise<void> => setToast(await reloadInventory())

  const scrollRef = useRef<HTMLDivElement>(null)
  // Window whichever list is active — only the rows intersecting the viewport are
  // mounted, so a filter keystroke never mounts hundreds of MUI rows synchronously.
  const rowCount = groupByItem ? groupRows.length : events.length
  const win = useWindowedRows({ count: rowCount, rowHeight: ROW_HEIGHT, scrollRef })

  return (
    <Stack spacing={2} sx={{ height: '100%' }}>
      <LootToolbar
        query={query}
        setQuery={setQuery}
        groupByItem={groupByItem}
        setGroupByItem={setGroupByItem}
        questOnly={questOnly}
        setQuestOnly={setQuestOnly}
        invOnlyCount={invOnlySource.length}
        showInventoryOnly={showInventoryOnly}
        onToggleInventoryOnly={() => setShowInventoryOnly((v) => !v)}
        countSource={countSource}
        setCountSource={setCountSource}
        onReload={() => void onReload()}
      />

      <LootSummary
        eventCount={history.length}
        uniqueCount={grouped.length}
        inventoryInfo={inventoryInfo}
        autoUpdatedAt={autoUpdatedAt}
      />

      <NotablePickupsStrip {...strip} onSelect={setSelected} />

      {history.length === 0 && <NoLootYet />}

      {/* The scroll container owns the ref the windowing hook reads. Spacer rows
          (top/bottom) reserve the full scroll height so only the visible slice of
          MUI rows is mounted — see useWindowedRows. */}
      <Box ref={scrollRef} sx={{ flexGrow: 1, overflow: 'auto' }}>
        <LootTable
          groupByItem={groupByItem}
          rows={groupRows}
          events={events}
          ctx={{ win, isFavorite, knowledgeByKey, invByKey, onToggleFavorite: toggleFavorite, onSelect: setSelected }}
        />
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
