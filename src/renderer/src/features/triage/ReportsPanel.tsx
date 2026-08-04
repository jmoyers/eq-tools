// ============================================================================
// ReportsPanel — the backlog as a dense, filterable table, and the record under it.
// ============================================================================
//
// The SERVER-SIDE filters (status / type / channel / since) go into the query, because they go
// into the WHERE clause and the LIMIT then applies to the answer — the same improvement over
// the DynamoDB version the CLI's `list` gained. The search box is a CLIENT-side narrowing of
// what came back, and the row count says both numbers so the two are never confused.
//
// FIXED-HEIGHT SCROLL BOX, WINDOWED (AGENTS.md): a 500-row answer sized to its content would
// push the detail pane off the screen, and mounting 500 MUI rows would stall every keystroke.

import { type JSX, useCallback, useDeferredValue, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  CircularProgress,
  IconButton,
  MenuItem,
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
import RefreshIcon from '@mui/icons-material/Refresh'
import { FEEDBACK_TYPES, REPORT_STATUSES } from '@shared/feedback'
import {
  TRIAGE_DEFAULT_QUERY,
  TRIAGE_SINCE_CHOICES,
  type TriageDetail,
  type TriageListQuery,
  type TriageRow
} from '@shared/triage'
import { useWindowedRows } from '../../lib/useWindowedRows'
import { formatDateTime } from '../../lib/formatDate'
import { LogChip, SeverityChip, SpamChip, StatusChip } from './triageChips'
import ReportDetail from './ReportDetail'
import { useTriageCall } from './useTriage'

const ROW_HEIGHT = 34
const TABLE_HEIGHT = 320
const COLS = 7
const CHANNELS = ['all', 'prod', 'dev'] as const

/** One filter select. `''` is the UI's "any" and is DROPPED from the query rather than sent:
 *  the handler's validator rejects an unknown status, and "any" is not a status. */
function FilterSelect({
  label,
  value,
  options,
  width,
  includeAny,
  onChange
}: {
  label: string
  value: string
  options: readonly string[]
  width: number
  includeAny?: boolean
  onChange: (v: string) => void
}): JSX.Element {
  return (
    <TextField
      select
      size="small"
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      sx={{ minWidth: width }}
    >
      {includeAny === true && <MenuItem value="">any</MenuItem>}
      {options.map((o) => (
        <MenuItem key={o} value={o}>
          {o}
        </MenuItem>
      ))}
    </TextField>
  )
}

/** Set an optional filter, or remove the key entirely when the user picks "any". */
function withOptional(query: TriageListQuery, key: 'status' | 'type', value: string): TriageListQuery {
  const { [key]: _drop, ...rest } = query
  return value === '' ? rest : { ...rest, [key]: value }
}

function Toolbar({
  query,
  setQuery,
  search,
  setSearch,
  onRefresh,
  loading,
  shown,
  total
}: {
  query: TriageListQuery
  setQuery: (q: TriageListQuery) => void
  search: string
  setSearch: (s: string) => void
  onRefresh: () => void
  loading: boolean
  shown: number
  total: number
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap">
      <TextField
        size="small"
        label="Search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        sx={{ minWidth: 200 }}
        data-testid="triage-search"
      />
      <FilterSelect
        label="Status"
        value={query.status ?? ''}
        options={REPORT_STATUSES}
        width={120}
        includeAny
        onChange={(v) => setQuery(withOptional(query, 'status', v))}
      />
      <FilterSelect
        label="Type"
        value={query.type ?? ''}
        options={FEEDBACK_TYPES}
        width={110}
        includeAny
        onChange={(v) => setQuery(withOptional(query, 'type', v))}
      />
      <FilterSelect
        label="Channel"
        value={query.channel}
        options={CHANNELS}
        width={110}
        onChange={(v) => setQuery({ ...query, channel: v as TriageListQuery['channel'] })}
      />
      <FilterSelect
        label="Since"
        value={query.since}
        options={TRIAGE_SINCE_CHOICES}
        width={100}
        onChange={(v) => setQuery({ ...query, since: v })}
      />
      <Box sx={{ flexGrow: 1 }} />
      <Typography variant="caption" color="text.secondary">
        {shown === total
          ? `${total.toLocaleString()} reports`
          : `${shown.toLocaleString()} of ${total.toLocaleString()} reports`}
      </Typography>
      {loading ? (
        <CircularProgress size={18} />
      ) : (
        <Tooltip title="Re-run the query">
          <IconButton size="small" onClick={onRefresh} data-testid="triage-refresh">
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
    </Stack>
  )
}

function ReportRow({
  row,
  selected,
  onSelect
}: {
  row: TriageRow
  selected: boolean
  onSelect: (id: string) => void
}): JSX.Element {
  return (
    <TableRow
      hover
      selected={selected}
      onClick={() => onSelect(row.reportId)}
      sx={{ cursor: 'pointer', height: ROW_HEIGHT }}
      data-testid="triage-row"
    >
      <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDateTime(row.receivedAt)}</TableCell>
      <TableCell>{row.type}</TableCell>
      <TableCell>
        <StatusChip status={row.status} />
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap' }}>{row.appVersion}</TableCell>
      <TableCell>{row.channel}</TableCell>
      <TableCell>
        <Stack direction="row" spacing={0.5}>
          <SeverityChip severity={row.severity} />
          <LogChip state={row.log} />
          <SpamChip score={row.spamScore} />
        </Stack>
      </TableCell>
      <TableCell sx={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {row.description}
      </TableCell>
    </TableRow>
  )
}

/** Spacer rows reserve the full scroll height so only the visible slice is mounted. */
function PadRow({ height }: { height: number }): JSX.Element | null {
  if (height <= 0) return null
  return (
    <TableRow style={{ height }}>
      <TableCell colSpan={COLS} sx={{ p: 0, border: 0 }} />
    </TableRow>
  )
}

function ReportsTable({
  rows,
  selectedId,
  onSelect
}: {
  rows: TriageRow[]
  selectedId: string | null
  onSelect: (id: string) => void
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const win = useWindowedRows({ count: rows.length, rowHeight: ROW_HEIGHT, scrollRef })
  return (
    <Box
      ref={scrollRef}
      data-testid="triage-reports"
      sx={{ height: TABLE_HEIGHT, overflow: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}
    >
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            <TableCell>Received</TableCell>
            <TableCell>Type</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Version</TableCell>
            <TableCell>Channel</TableCell>
            <TableCell>Flags</TableCell>
            <TableCell>Report</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          <PadRow height={win.topPad} />
          {rows.slice(win.start, win.end).map((row) => (
            <ReportRow
              key={row.reportId}
              row={row}
              selected={row.reportId === selectedId}
              onSelect={onSelect}
            />
          ))}
          <PadRow height={win.bottomPad} />
        </TableBody>
      </Table>
    </Box>
  )
}

/** The selected record. Fetched separately from the list because the detail costs a HeadObject
 *  (the `present`/`missing` answer) that the list deliberately does not pay per row. */
function DetailPane({
  reportId,
  onChanged
}: {
  reportId: string
  onChanged: () => void
}): JSX.Element {
  const run = useCallback(() => window.eq.triageDetail(reportId), [reportId])
  const detail = useTriageCall<TriageDetail | null>(run)
  const changed = useCallback(() => {
    detail.reload()
    onChanged()
  }, [detail, onChanged])

  if (detail.loading) return <CircularProgress size={20} />
  if (detail.error) return <Alert severity="error">{detail.error}</Alert>
  if (!detail.data) return <Alert severity="info">That report is no longer in the backlog.</Alert>
  return <ReportDetail detail={detail.data} onChanged={changed} />
}

export default function ReportsPanel(): JSX.Element {
  const [query, setQuery] = useState<TriageListQuery>(TRIAGE_DEFAULT_QUERY)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const deferred = useDeferredValue(search)

  const run = useCallback(() => window.eq.triageList(query), [query])
  const list = useTriageCall<TriageRow[]>(run)
  const all = useMemo(() => list.data ?? [], [list.data])

  const rows = useMemo(() => {
    const needle = deferred.trim().toLowerCase()
    if (needle.length === 0) return all
    return all.filter((r) =>
      `${r.description} ${r.reportId} ${r.appVersion} ${r.cluster ?? ''}`
        .toLowerCase()
        .includes(needle)
    )
  }, [all, deferred])

  return (
    <Stack spacing={2} sx={{ height: '100%' }}>
      <Toolbar
        query={query}
        setQuery={setQuery}
        search={search}
        setSearch={setSearch}
        onRefresh={list.reload}
        loading={list.loading}
        shown={rows.length}
        total={all.length}
      />
      {list.error && <Alert severity="error">{list.error}</Alert>}
      <ReportsTable rows={rows} selectedId={selectedId} onSelect={setSelectedId} />
      <Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }}>
        {selectedId === null ? (
          <Typography variant="body2" color="text.secondary">
            Select a report to see the full record, its environment and its log slice.
          </Typography>
        ) : (
          <DetailPane reportId={selectedId} onChanged={list.reload} />
        )}
      </Box>
    </Stack>
  )
}
