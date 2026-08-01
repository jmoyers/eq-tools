import { useMemo, useState } from 'react'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import RefreshIcon from '@mui/icons-material/Refresh'
import type { LootEvent } from '@shared/types'
import { useProgress, type QuestProgress } from './useProgress'

type SortKey = 'closest' | 'least-missing' | 'class'

const WIKI_BASE = 'https://eqlwiki.com/'

function wikiClassPage(className: string): string {
  return `${WIKI_BASE}${encodeURIComponent(`${className} Plane of Sky Tests`.replace(/ /g, '_'))}`
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

export default function PoskyView({ lastLoot }: { lastLoot: LootEvent | null }): JSX.Element {
  const { quests, classes, reloadInventory, setQuestComplete, inventoryInfo } = useProgress(lastLoot)
  const [selectedClasses, setSelectedClasses] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('closest')
  const [hideCompleted, setHideCompleted] = useState(false)
  const [hideNoItems, setHideNoItems] = useState(true)
  const [toast, setToast] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = quests
    if (selectedClasses.length) list = list.filter((x) => selectedClasses.includes(x.className))
    if (hideCompleted) list = list.filter((x) => !x.completed)
    if (hideNoItems) list = list.filter((x) => x.needCount > 0)
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
    return sorted
  }, [quests, selectedClasses, query, sort, hideCompleted, hideNoItems])

  const onReload = async (): Promise<void> => setToast(await reloadInventory())

  const totalQuests = quests.length

  return (
    <Stack spacing={2} sx={{ height: '100%' }}>
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
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title="Run /outputfile inventory in-game, then reload">
          <Button variant="outlined" startIcon={<RefreshIcon />} onClick={onReload}>
            Reload inventory
          </Button>
        </Tooltip>
      </Stack>

      {totalQuests === 0 ? (
        <Alert severity="info">
          No Plane of Sky data yet. Run <code>npm run scrape:posky</code> to pull quest data from the
          wiki, then restart the app.
        </Alert>
      ) : (
        <Typography variant="body2" color="text.secondary">
          {filtered.length} of {totalQuests} quests
          {inventoryInfo ? ` · inventory loaded ${new Date(inventoryInfo.loadedAt).toLocaleString()}` : ' · no inventory loaded yet'}
        </Typography>
      )}

      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        {filtered.map((q) => (
          <Accordion key={q.key} disableGutters>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Stack direction="row" spacing={2} alignItems="center" sx={{ width: '100%', pr: 2 }}>
                <Chip label={q.className} size="small" color="secondary" variant="outlined" sx={{ minWidth: 92 }} />
                <Box sx={{ minWidth: 220 }}>
                  <Typography variant="subtitle2">{q.name}</Typography>
                  {q.reward && (
                    <Typography variant="caption" color="primary.main">
                      → {q.reward}
                    </Typography>
                  )}
                </Box>
                <Box sx={{ flexGrow: 1 }} />
                {q.missing.length > 0 && !q.completed && (
                  <Chip size="small" variant="outlined" label={`${q.missing.length} missing`} />
                )}
                <ProgressBar q={q} />
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <Stack direction="row" spacing={2} sx={{ mb: 1 }} alignItems="center" flexWrap="wrap" useFlexGap>
                {q.rune && <Chip size="small" label={`Rune: ${q.rune}`} />}
                {q.giver && <Chip size="small" label={`Giver: ${q.giver}`} />}
                <Link href={wikiClassPage(q.className)} target="_blank" rel="noreferrer" variant="caption">
                  wiki: {q.className} Plane of Sky Tests
                </Link>
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
              <Table size="small">
                <TableHead>
                  <TableRow>
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
                        <TableCell sx={{ color: done ? 'success.main' : 'text.primary' }}>{it.name}</TableCell>
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
        ))}
      </Box>

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
