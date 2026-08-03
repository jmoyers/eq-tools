import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  LinearProgress,
  Link,
  MenuItem,
  Snackbar,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import RefreshIcon from '@mui/icons-material/Refresh'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import StarIcon from '@mui/icons-material/Star'
import StarBorderIcon from '@mui/icons-material/StarBorder'
import LinkIcon from '@mui/icons-material/Link'
import type { CountSource } from '@shared/types'
import { skyQuestPage, wikiPageUrl } from '@shared/wiki'
import { useProgress, type QuestProgress } from './useProgress'
import { ItemTooltip } from './ItemTooltip'
import { formatDateTime } from '../../lib/formatDate'
import { sharingQuestLabel, type SharedItem } from './sharedItems'
import { useFavorites } from '../favorites/useFavorites'
import { FavoriteStar } from '../favorites/FavoriteStar'
import { useQuestFavorites, useQuestIgnored } from '../favorites/useQuestFlags'
import { QuestIgnoreButton, QuestStarButton } from '../favorites/QuestFlagButtons'
import Confetti from '../../lib/Confetti'

type SortKey = 'closest' | 'least-missing' | 'class'

type TabKey = 'quests' | 'ignored'

// How many Accordions to render before the "show more" cap kicks in.
const PAGE = 40

const SELECTED_CLASSES_KEY = 'eq.selectedClasses'

function loadSelectedClasses(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SELECTED_CLASSES_KEY) ?? '[]')
    return Array.isArray(v) ? (v as string[]) : []
  } catch {
    return []
  }
}

// Wiki URLs are built in ONE place (src/shared/wiki.ts) — the verified root-path convention.
function wikiClassPage(className: string): string | undefined {
  return wikiPageUrl(skyQuestPage(className))
}

function ProgressBar({ q }: { q: QuestProgress }): JSX.Element {
  const pct = Math.round(q.ratio * 100)
  const color = q.completed ? 'success' : pct === 0 ? 'inherit' : pct >= 100 ? 'success' : 'primary'
  return (
    <Box sx={{ minWidth: 160 }}>
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">
          {q.completed ? 'Turned in' : `${q.haveCount}/${q.needCount} items`}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {pct}%
        </Typography>
      </Stack>
      <LinearProgress variant="determinate" value={Math.min(100, pct)} color={color as 'primary'} />
    </Box>
  )
}

// "Shared items with" (Task #44): a compact, dense section listing each of this
// quest's required items that ANOTHER Plane of Sky quest also needs — so before
// turning in you can see who else is contending for a drop. Currency (Wind Runes) is
// excluded upstream in the derivation.
function SharedItemsSection({
  shared,
  ambiguousNames,
  onSelectQuest
}: {
  shared: SharedItem[]
  ambiguousNames: Set<string>
  onSelectQuest: (name: string) => void
}): JSX.Element {
  return (
    <Box sx={{ mb: 1 }}>
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }}>
        <LinkIcon sx={{ fontSize: 15, color: 'text.secondary' }} />
        <Typography variant="caption" color="text.secondary">
          Shared items — other Sky quests contending for these drops
        </Typography>
      </Stack>
      <Stack spacing={0.5}>
        {shared.map((si) => (
          <Stack key={si.key} direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="caption" sx={{ fontWeight: 600, minWidth: 150 }}>
              {si.name}
            </Typography>
            {si.quests.map((sq) => (
              <Chip
                key={sq.key}
                size="small"
                variant="outlined"
                color="info"
                label={sharingQuestLabel(sq, ambiguousNames)}
                onClick={() => onSelectQuest(sq.name)}
                sx={{ height: 20, fontSize: 11 }}
              />
            ))}
          </Stack>
        ))}
      </Stack>
    </Box>
  )
}

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

export default function PoskyView(): JSX.Element {
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
  const { favorites, isFavorite, toggle: toggleFavorite } = useFavorites()
  // Quest-level flags (renderer-local localStorage, keyed by the canonical `Class::Name`
  // quest key) — the star the user could not find, and a permanent ignore.
  const questFavorites = useQuestFavorites()
  const questIgnored = useQuestIgnored()
  const [tab, setTab] = useState<TabKey>('quests')
  const [selectedClasses, setSelectedClasses] = useState<string[]>(loadSelectedClasses)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('closest')
  const [hideCompleted, setHideCompleted] = useState(false)
  const [hideNoItems, setHideNoItems] = useState(true)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  // Accordions are variable-height so we cap+paginate rather than window them; a
  // keystroke never re-renders more than PAGE quests at once.
  const [visibleCount, setVisibleCount] = useState(PAGE)

  const questHasFavorite = (q: QuestProgress): boolean => q.items.some((it) => isFavorite(it.name))

  // Ignored quests are gone from the main list, its filters and its counts — they exist
  // only under the Ignored tab, where the same button un-ignores them.
  const ignoredKeys = questIgnored.keys
  const [visible, ignored] = useMemo(() => {
    const shown: QuestProgress[] = []
    const hidden: QuestProgress[] = []
    for (const q of quests) (ignoredKeys.has(q.key.toLowerCase()) ? hidden : shown).push(q)
    hidden.sort((a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name))
    return [shown, hidden]
  }, [quests, ignoredKeys])

  // Remember the class filter across restarts.
  useEffect(() => {
    localStorage.setItem(SELECTED_CLASSES_KEY, JSON.stringify(selectedClasses))
  }, [selectedClasses])

  // Typing echoes immediately; the (accordion-rebuilding) filter consumes a deferred
  // copy so a keystroke never blocks on re-rendering dozens of Accordions (Task #41).
  const deferredQuery = useDeferredValue(query)

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    let list = visible
    if (selectedClasses.length) list = list.filter((x) => selectedClasses.includes(x.className))
    if (hideCompleted) list = list.filter((x) => !x.completed)
    if (hideNoItems) list = list.filter((x) => x.needCount > 0)
    // "Favorites only" = the quest itself is starred OR it needs a starred item.
    if (favoritesOnly)
      list = list.filter((x) => questFavorites.has(x.key) || questHasFavorite(x))
    if (q) {
      list = list.filter(
        (x) =>
          x.name.toLowerCase().includes(q) ||
          x.reward?.toLowerCase().includes(q) ||
          x.items.some((i) => i.name.toLowerCase().includes(q))
      )
    }
    const sorted = [...list]
    if (sort === 'closest') {
      sorted.sort(
        (a, b) =>
          b.ratio - a.ratio ||
          a.missing.length - b.missing.length ||
          a.className.localeCompare(b.className)
      )
    } else if (sort === 'least-missing') {
      sorted.sort((a, b) => a.missing.length - b.missing.length || b.ratio - a.ratio)
    } else {
      sorted.sort((a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name))
    }
    // Pin to the top (stable sort, so ties keep the sort above). A quest the user
    // STARRED outright outranks one that merely contains a favorited item — the star is
    // an explicit "I'm working on this", so it pins even once turned in; the item-level
    // pin stays what it always was (only while the quest still needs something).
    const rank = (x: QuestProgress): number =>
      questFavorites.has(x.key) ? 2 : !x.completed && questHasFavorite(x) ? 1 : 0
    sorted.sort((a, b) => rank(b) - rank(a))
    return sorted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    visible,
    selectedClasses,
    deferredQuery,
    sort,
    hideCompleted,
    hideNoItems,
    favoritesOnly,
    favorites,
    questFavorites.keys
  ])

  // Reset the page cap whenever the filtered set changes (a new search shows from top).
  useEffect(() => {
    setVisibleCount(PAGE)
  }, [filtered])

  const onReload = async (): Promise<void> => setToast(await reloadInventory())

  // Counts describe the list you are looking at, so ignored quests are not in them.
  const totalQuests = visible.length

  return (
    <Stack spacing={2} sx={{ height: '100%', position: 'relative' }}>
      {burst != null && <Confetti key={burst} onDone={() => setBurst(null)} />}
      <Tabs
        value={tab}
        onChange={(_e, v: TabKey) => setTab(v)}
        sx={{ minHeight: 36, mb: -1, '& .MuiTab-root': { minHeight: 36, py: 0 } }}
      >
        <Tab value="quests" label="Quests" />
        <Tab value="ignored" label={ignored.length ? `Ignored (${ignored.length})` : 'Ignored'} />
      </Tabs>
      {tab === 'ignored' ? (
        <IgnoredList quests={ignored} onUnignore={questIgnored.toggle} />
      ) : (
        <>
      <Stack direction="row" spacing={2} flexWrap="wrap" alignItems="center" useFlexGap>
        <Autocomplete
          multiple
          size="small"
          options={classes}
          value={selectedClasses}
          onChange={(_e, v) => setSelectedClasses(v)}
          sx={{ minWidth: 280 }}
          renderInput={(params) => <TextField {...params} label="Filter by class" placeholder="All classes" />}
        />
        <TextField
          size="small"
          label="Search item / quest / reward"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ minWidth: 240 }}
        />
        <TextField
          select
          size="small"
          label="Sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="closest">Closest to done</MenuItem>
          <MenuItem value="least-missing">Fewest missing</MenuItem>
          <MenuItem value="class">By class</MenuItem>
        </TextField>
        <FormControlLabel
          control={<Checkbox checked={hideCompleted} onChange={(e) => setHideCompleted(e.target.checked)} />}
          label="Hide completed"
        />
        <FormControlLabel
          control={<Checkbox checked={hideNoItems} onChange={(e) => setHideNoItems(e.target.checked)} />}
          label="Only quests with turn-ins"
        />
        <FormControlLabel
          control={
            <Checkbox
              checked={favoritesOnly}
              onChange={(e) => setFavoritesOnly(e.target.checked)}
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
            onChange={(e) => setCountSource(e.target.value as CountSource)}
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
              onClick={onReload}
              disabled={countSource === 'log'}
            >
              Reload inventory
            </Button>
          </span>
        </Tooltip>
      </Stack>

      {quests.length === 0 ? (
        <Alert severity="info">
          No Plane of Sky data available.
        </Alert>
      ) : totalQuests === 0 ? (
        // Data exists, it is all ignored — say so, and point at the tab that undoes it.
        <Typography color="text.secondary">
          Every quest is ignored — the Ignored tab can bring them back.
        </Typography>
      ) : (
        <Typography variant="body2" color="text.secondary">
          {filtered.length} of {totalQuests} quests · counting from{' '}
          {countSource === 'log' ? 'looted log' : countSource === 'inventory' ? 'inventory export' : 'log + inventory'}
          {countSource !== 'log' &&
            (inventoryInfo
              ? ` · inventory loaded ${formatDateTime(new Date(inventoryInfo.loadedAt).getTime())}`
              : ' · no inventory loaded yet')}
        </Typography>
      )}

      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        {filtered.slice(0, visibleCount).map((q) => {
          const shared = sharedItems.get(q.key) ?? []
          const wikiHref = wikiClassPage(q.className)
          return (
          <Accordion key={q.key} disableGutters>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Stack spacing={0.75} sx={{ width: '100%', pr: 2 }}>
                <Stack direction="row" spacing={2} alignItems="center">
                  {/* Star + ignore lead every row, always visible — the quest-level
                      controls the user could not find when the only star lived on an
                      item row inside the expanded panel. */}
                  <Stack direction="row" alignItems="center" sx={{ minWidth: 48 }}>
                    <QuestStarButton
                      favorited={questFavorites.has(q.key)}
                      onToggle={() => questFavorites.toggle(q.key)}
                    />
                    <QuestIgnoreButton ignored={false} onToggle={() => questIgnored.toggle(q.key)} />
                  </Stack>
                  <Chip label={q.className} size="small" color="secondary" variant="outlined" sx={{ minWidth: 92 }} />
                  <Box sx={{ minWidth: 220 }}>
                    <Typography variant="subtitle2">{q.name}</Typography>
                    {q.reward && (
                      <ItemTooltip name={q.reward} stats={q.rewardStats}>
                        <Typography variant="caption" color="primary.main" sx={{ cursor: 'help' }}>
                          → {q.reward}
                        </Typography>
                      </ItemTooltip>
                    )}
                    {q.giver && (
                      <Typography variant="caption" color="text.secondary" display="block">
                        Turn in → {q.giver}
                      </Typography>
                    )}
                  </Box>
                  <Box sx={{ flexGrow: 1 }} />
                  {shared.length > 0 && (
                    <Tooltip
                      title={`Shares ${shared.length} item${shared.length === 1 ? '' : 's'} with other Sky quests — expand for details`}
                    >
                      <Chip
                        size="small"
                        variant="outlined"
                        color="info"
                        icon={<LinkIcon />}
                        label={shared.length}
                        sx={{ height: 20, fontSize: 11, '& .MuiChip-icon': { fontSize: 14 } }}
                      />
                    </Tooltip>
                  )}
                  {q.completed ? (
                    <Chip size="small" color="success" variant="outlined" label="Turned in" />
                  ) : (
                    <Chip
                      size="small"
                      variant="outlined"
                      color={q.missing.length === 0 ? 'success' : 'default'}
                      label={q.missing.length === 0 ? 'Ready to turn in' : `${q.missing.length} of ${q.items.length} missing`}
                    />
                  )}
                  <ProgressBar q={q} />
                </Stack>
                {/* Indent tracks the header's leading columns (buttons + class chip). */}
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ pl: '164px' }}>
                  {[...q.items]
                    .sort((a, b) => Number(isFavorite(b.name)) - Number(isFavorite(a.name)))
                    .map((it) => {
                      const done = it.have >= it.need || q.completed
                      const fav = isFavorite(it.name)
                      return (
                        <ItemTooltip key={it.name} name={it.name} stats={it.stats} who={it.who} where={it.where}>
                          <Chip
                            size="small"
                            variant={fav ? 'filled' : 'outlined'}
                            color={fav ? 'warning' : done ? 'success' : 'default'}
                            icon={
                              fav ? (
                                <StarIcon />
                              ) : done ? (
                                <CheckCircleIcon />
                              ) : (
                                <RadioButtonUncheckedIcon />
                              )
                            }
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleFavorite(it.name)
                            }}
                            label={it.need > 1 ? `${it.name} ${it.have}/${it.need}` : it.name}
                            sx={{ opacity: done && !fav ? 0.65 : 1 }}
                          />
                        </ItemTooltip>
                      )
                    })}
                </Stack>
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <Stack direction="row" spacing={2} sx={{ mb: 1 }} alignItems="center" flexWrap="wrap" useFlexGap>
                {q.rune && <Chip size="small" label={`Rune: ${q.rune}`} />}
                {q.giver && <Chip size="small" label={`Giver: ${q.giver}`} />}
                {wikiHref && (
                  <Link href={wikiHref} target="_blank" rel="noreferrer" variant="caption">
                    wiki: {q.className} Plane of Sky Tests
                  </Link>
                )}
                <Box sx={{ flexGrow: 1 }} />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={q.completed}
                      onChange={(e) => void setQuestComplete(q.key, e.target.checked)}
                    />
                  }
                  label="Turned in / complete"
                />
              </Stack>
              {q.rewardStats && (
                <Typography variant="caption" color="text.secondary" component="pre" sx={{ whiteSpace: 'pre-wrap', mb: 1 }}>
                  {q.rewardStats}
                </Typography>
              )}
              {shared.length > 0 && (
                <SharedItemsSection
                  shared={shared}
                  ambiguousNames={ambiguousQuestNames}
                  onSelectQuest={(name) => setQuery(name)}
                />
              )}
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox" />
                    <TableCell>Item</TableCell>
                    <TableCell>Have</TableCell>
                    <TableCell>Dropped by</TableCell>
                    <TableCell>Where</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {q.items.map((it) => {
                    const done = it.have >= it.need
                    return (
                      <TableRow key={it.name}>
                        <TableCell padding="checkbox">
                          <FavoriteStar name={it.name} favorited={isFavorite(it.name)} onToggle={toggleFavorite} />
                        </TableCell>
                        <TableCell sx={{ color: done ? 'success.main' : 'text.primary' }}>
                          <ItemTooltip name={it.name} stats={it.stats} who={it.who} where={it.where}>
                            <span style={{ cursor: 'help' }}>{it.name}</span>
                          </ItemTooltip>
                        </TableCell>
                        <TableCell>
                          {it.have}/{it.need}
                        </TableCell>
                        <TableCell sx={{ color: 'text.secondary' }}>{it.who.join(', ')}</TableCell>
                        <TableCell sx={{ color: 'text.secondary' }}>{it.where}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </AccordionDetails>
          </Accordion>
          )
        })}
        {filtered.length > visibleCount && (
          <Box sx={{ textAlign: 'center', py: 1.5 }}>
            <Button variant="outlined" size="small" onClick={() => setVisibleCount((n) => n + PAGE)}>
              Show more ({filtered.length - visibleCount} more)
            </Button>
          </Box>
        )}
      </Box>
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
