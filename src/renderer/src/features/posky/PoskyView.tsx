import { type JSX, useCallback, useState } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  MenuItem,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import StarIcon from '@mui/icons-material/Star'
import StarBorderIcon from '@mui/icons-material/StarBorder'
import type { CountSource } from '@shared/types'
import { useProgress, type QuestProgress, type UseProgress } from './useProgress'
import { formatDateTime } from '../../lib/formatDate'
import type { SharedItemsMap } from './sharedItems'
import { QuestIgnoreButton } from '../favorites/QuestFlagButtons'
import { QuestAccordion } from './QuestAccordion'
import { useQuestList, type QuestListState, type SortKey, type TabKey } from './useQuestList'
import type { MobTarget } from '../mobs/mobTarget'
import Confetti from '../../lib/Confetti'

// The Ignored tab: every quest the user hid, in one flat compact list (no accordions —
// there is nothing to work on here), each row carrying the same button that put it here,
// now reading "Stop ignoring". Un-ignoring drops the row instantly and the quest
// reappears under Quests with its favorite state untouched.
function IgnoredList({
  quests,
  onUnignore
}: {
  quests: QuestProgress[]
  onUnignore: (questKey: string) => void
}): JSX.Element {
  if (quests.length === 0) {
    return (
      <Typography color="text.secondary">
        No ignored quests — hide one with the eye icon on its row and it lands here.
      </Typography>
    )
  }
  return (
    <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {quests.length} quest{quests.length === 1 ? '' : 's'} hidden from the list, filters and counts.
      </Typography>
      <Stack spacing={0.5}>
        {quests.map((q) => (
          <Stack
            key={q.key}
            direction="row"
            spacing={2}
            alignItems="center"
            sx={{ px: 1, py: 0.5, borderRadius: 1, '&:hover': { bgcolor: 'action.hover' } }}
          >
            <QuestIgnoreButton ignored onToggle={() => onUnignore(q.key)} />
            <Chip label={q.className} size="small" color="secondary" variant="outlined" sx={{ minWidth: 92 }} />
            <Typography variant="subtitle2" sx={{ minWidth: 220 }}>
              {q.name}
            </Typography>
            {q.reward && (
              <Typography variant="caption" color="primary.main">
                → {q.reward}
              </Typography>
            )}
            <Box sx={{ flexGrow: 1 }} />
            {q.completed && <Chip size="small" color="success" variant="outlined" label="Turned in" />}
          </Stack>
        ))}
      </Stack>
    </Box>
  )
}

// Class filter, search, sort, the three hide-toggles, and the inventory controls that decide
// which items the whole tab counts you as holding.
function FilterBar({
  list,
  classes,
  countSource,
  onCountSource,
  onReload
}: {
  list: QuestListState
  classes: string[]
  countSource: CountSource
  onCountSource: (s: CountSource) => void
  onReload: () => Promise<void>
}): JSX.Element {
  return (
    <Stack direction="row" spacing={2} flexWrap="wrap" alignItems="center" useFlexGap>
      <Autocomplete
        multiple
        size="small"
        options={classes}
        value={list.selectedClasses}
        onChange={(_e, v) => list.setSelectedClasses(v)}
        sx={{ minWidth: 280 }}
        renderInput={(params) => <TextField {...params} label="Filter by class" placeholder="All classes" />}
      />
      <TextField
        size="small"
        label="Search item / quest / reward"
        value={list.query}
        onChange={(e) => list.setQuery(e.target.value)}
        sx={{ minWidth: 240 }}
      />
      <TextField
        select
        size="small"
        label="Sort"
        value={list.sort}
        onChange={(e) => list.setSort(e.target.value as SortKey)}
        sx={{ minWidth: 180 }}
      >
        <MenuItem value="closest">Closest to done</MenuItem>
        <MenuItem value="least-missing">Fewest missing</MenuItem>
        <MenuItem value="class">By class</MenuItem>
      </TextField>
      <FormControlLabel
        control={<Checkbox checked={list.hideCompleted} onChange={(e) => list.setHideCompleted(e.target.checked)} />}
        label="Hide completed"
      />
      <FormControlLabel
        control={<Checkbox checked={list.hideNoItems} onChange={(e) => list.setHideNoItems(e.target.checked)} />}
        label="Only quests with turn-ins"
      />
      <FormControlLabel
        control={
          <Checkbox
            checked={list.favoritesOnly}
            onChange={(e) => list.setFavoritesOnly(e.target.checked)}
            icon={<StarBorderIcon />}
            checkedIcon={<StarIcon />}
            sx={{ color: 'warning.main', '&.Mui-checked': { color: 'warning.main' } }}
          />
        }
        label="Favorites only"
      />
      <Box sx={{ flexGrow: 1 }} />
      <Tooltip title="How the app decides which items you have. Log = everything you've ever looted (survives an un-exported bank). Inventory = your last /outputfile dump. Both = the higher of the two.">
        <TextField
          select
          size="small"
          label="Count items from"
          value={countSource}
          onChange={(e) => onCountSource(e.target.value as CountSource)}
          sx={{ minWidth: 170 }}
        >
          <MenuItem value="log">Log (looted)</MenuItem>
          <MenuItem value="inventory">Inventory export</MenuItem>
          <MenuItem value="both">Both (max)</MenuItem>
        </TextField>
      </Tooltip>
      <Tooltip title="Run /outputfile inventory in-game, then reload">
        <span>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={() => void onReload()}
            disabled={countSource === 'log'}
          >
            Reload inventory
          </Button>
        </span>
      </Tooltip>
    </Stack>
  )
}

// The one-line status under the filters. It states which of three situations you are in —
// there is no Sky data at all, there is data but you ignored every quest, or here are the
// counts — and where the "have" numbers came from.
function CountsLine({
  questCount,
  totalQuests,
  filteredCount,
  countSource,
  inventoryInfo
}: {
  questCount: number
  totalQuests: number
  filteredCount: number
  countSource: CountSource
  inventoryInfo: UseProgress['inventoryInfo']
}): JSX.Element {
  if (questCount === 0) {
    return (
      <Alert severity="info">
        No Plane of Sky data available.
      </Alert>
    )
  }
  if (totalQuests === 0) {
    // Data exists, it is all ignored — say so, and point at the tab that undoes it.
    return (
      <Typography color="text.secondary">
        Every quest is ignored — the Ignored tab can bring them back.
      </Typography>
    )
  }
  return (
    <Typography variant="body2" color="text.secondary">
      {filteredCount} of {totalQuests} quests · counting from{' '}
      {countSource === 'log' ? 'looted log' : countSource === 'inventory' ? 'inventory export' : 'log + inventory'}
      {countSource !== 'log' &&
        (inventoryInfo
          ? ` · inventory loaded ${formatDateTime(new Date(inventoryInfo.loadedAt).getTime())}`
          : ' · no inventory loaded yet')}
    </Typography>
  )
}

// The scrolling body: one accordion per quest up to the page cap, then the "show more" button.
function QuestList({
  list,
  sharedItems,
  ambiguousNames,
  setQuestComplete,
  onOpenMob
}: {
  list: QuestListState
  sharedItems: SharedItemsMap
  ambiguousNames: Set<string>
  setQuestComplete: (key: string, complete: boolean) => Promise<void>
  onOpenMob: (t: MobTarget) => void
}): JSX.Element {
  return (
    <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
      {list.filtered.slice(0, list.visibleCount).map((q) => (
        <QuestAccordion
          key={q.key}
          q={q}
          shared={sharedItems.get(q.key) ?? []}
          ambiguousNames={ambiguousNames}
          favorited={list.questFavorites.has(q.key)}
          onToggleFavorite={() => list.questFavorites.toggle(q.key)}
          onToggleIgnore={() => list.questIgnored.toggle(q.key)}
          isFavorite={list.isFavorite}
          toggleFavorite={list.toggleFavorite}
          onSetComplete={(complete) => void setQuestComplete(q.key, complete)}
          onSelectQuest={(name) => list.setQuery(name)}
          onOpenMob={onOpenMob}
        />
      ))}
      {list.filtered.length > list.visibleCount && (
        <Box sx={{ textAlign: 'center', py: 1.5 }}>
          <Button variant="outlined" size="small" onClick={list.showMore}>
            Show more ({list.filtered.length - list.visibleCount} more)
          </Button>
        </Box>
      )}
    </Box>
  )
}

export default function PoskyView({ onOpenMob }: { onOpenMob: (t: MobTarget) => void }): JSX.Element {
  // A quest completing via a LIVE turn-in bursts confetti over this view (mirrors
  // BossView's onKill confetti, Task #46). useProgress gates out the historical
  // baseline, so this only fires for a real turn-in observed while the app is open.
  const [burst, setBurst] = useState<number | null>(null)
  const onQuestComplete = useCallback(() => {
    setBurst((n) => (n ?? 0) + 1)
  }, [])

  const {
    quests,
    classes,
    countSource,
    setCountSource,
    reloadInventory,
    setQuestComplete,
    inventoryInfo,
    sharedItems,
    ambiguousQuestNames
  } = useProgress({ onQuestComplete })
  const list = useQuestList(quests)
  const [toast, setToast] = useState<string | null>(null)

  const onReload = async (): Promise<void> => setToast(await reloadInventory())

  // Counts describe the list you are looking at, so ignored quests are not in them.
  const totalQuests = list.visible.length

  return (
    <Stack spacing={2} sx={{ height: '100%', position: 'relative' }}>
      {burst != null && <Confetti key={burst} onDone={() => setBurst(null)} />}
      <Tabs
        value={list.tab}
        onChange={(_e, v: TabKey) => list.setTab(v)}
        sx={{ minHeight: 36, mb: -1, '& .MuiTab-root': { minHeight: 36, py: 0 } }}
      >
        <Tab value="quests" label="Quests" />
        <Tab value="ignored" label={list.ignored.length ? `Ignored (${list.ignored.length})` : 'Ignored'} />
      </Tabs>
      {list.tab === 'ignored' ? (
        <IgnoredList quests={list.ignored} onUnignore={list.questIgnored.toggle} />
      ) : (
        <>
          <FilterBar
            list={list}
            classes={classes}
            countSource={countSource}
            onCountSource={setCountSource}
            onReload={onReload}
          />
          <CountsLine
            questCount={quests.length}
            totalQuests={totalQuests}
            filteredCount={list.filtered.length}
            countSource={countSource}
            inventoryInfo={inventoryInfo}
          />
          <QuestList
            list={list}
            sharedItems={sharedItems}
            ambiguousNames={ambiguousQuestNames}
            setQuestComplete={setQuestComplete}
            onOpenMob={onOpenMob}
          />
        </>
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
