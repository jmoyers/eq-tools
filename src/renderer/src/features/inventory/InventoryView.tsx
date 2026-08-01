import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
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
import RefreshIcon from '@mui/icons-material/Refresh'
import type { CountSource, LootEvent } from '@shared/types'
import { useProgress } from '../posky/useProgress'

const MAX_ROWS = 600

export default function InventoryView({ lastLoot }: { lastLoot: LootEvent | null }): JSX.Element {
  const { inventoryRows, countSource, setCountSource, reloadInventory, inventoryInfo } = useProgress(lastLoot)
  const [query, setQuery] = useState('')
  const [onlyReconciled, setOnlyReconciled] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = inventoryRows
    if (onlyReconciled) list = list.filter((r) => r.log > 0 && r.inv > 0)
    if (q) list = list.filter((r) => r.name.toLowerCase().includes(q))
    return list
  }, [inventoryRows, query, onlyReconciled])

  const onReload = async (): Promise<void> => setToast(await reloadInventory())

  const totals = useMemo(() => {
    let net = 0
    let consumed = 0
    for (const r of inventoryRows) {
      net += r.net
      consumed += r.consumed
    }
    return { net, consumed, items: inventoryRows.length }
  }, [inventoryRows])

  return (
    <Stack spacing={2} sx={{ height: '100%' }}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <TextField
          size="small"
          label="Search item"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ minWidth: 240 }}
        />
        <Tooltip title="Which source feeds the 'Held' column. Log = looted from your log; Inventory = last export; Both = the higher.">
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
        <Chip
          size="small"
          variant="outlined"
          label={onlyReconciled ? 'Showing log∩export' : 'Showing all held'}
          onClick={() => setOnlyReconciled((v) => !v)}
        />
        <Box sx={{ flexGrow: 1 }} />
        <Button variant="outlined" startIcon={<RefreshIcon />} onClick={onReload}>
          Reload inventory export
        </Button>
      </Stack>

      <Typography variant="body2" color="text.secondary">
        {totals.items.toLocaleString()} distinct items · {totals.net.toLocaleString()} net held ·{' '}
        {totals.consumed.toLocaleString()} consumed by turn-ins
        {inventoryInfo ? ` · export loaded ${new Date(inventoryInfo.loadedAt).toLocaleString()}` : ' · no export loaded'}
      </Typography>

      <Alert severity="info" sx={{ py: 0 }}>
        <strong>Net available</strong> = your <strong>Held</strong> count (from the source above) minus anything
        <strong> Turned in</strong> for a completed quest — so a drop handed in for one quest stops counting toward
        another that needs it.
      </Alert>

      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>Item</TableCell>
              <Tooltip title="Times looted (from the log)">
                <TableCell align="right">Looted</TableCell>
              </Tooltip>
              <Tooltip title="Count in the inventory export">
                <TableCell align="right">Export</TableCell>
              </Tooltip>
              <TableCell align="right">Held</TableCell>
              <TableCell align="right">Turned in</TableCell>
              <TableCell align="right">Net</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.slice(0, MAX_ROWS).map((r) => (
              <TableRow key={r.key} hover sx={{ opacity: r.net === 0 ? 0.55 : 1 }}>
                <TableCell>{r.name}</TableCell>
                <TableCell align="right" sx={{ color: r.log ? 'secondary.main' : 'text.disabled' }}>
                  {r.log || '—'}
                </TableCell>
                <TableCell align="right" sx={{ color: r.inv ? 'secondary.main' : 'text.disabled' }}>
                  {r.inv || '—'}
                </TableCell>
                <TableCell align="right">{r.base}</TableCell>
                <TableCell align="right">
                  {r.consumed > 0 ? (
                    <Tooltip title={`Turned in for: ${r.consumedBy.join(', ')}`}>
                      <span style={{ color: 'var(--mui-palette-warning-main)', cursor: 'help' }}>-{r.consumed}</span>
                    </Tooltip>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell align="right" sx={{ fontWeight: 700, color: r.net > 0 ? 'success.main' : 'text.disabled' }}>
                  {r.net}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {rows.length > MAX_ROWS && (
          <Typography variant="caption" color="text.secondary" sx={{ p: 1, display: 'block' }}>
            Showing first {MAX_ROWS} of {rows.length.toLocaleString()} — refine with search.
          </Typography>
        )}
        {inventoryRows.length === 0 && (
          <Typography color="text.secondary" sx={{ p: 2 }}>
            Nothing held yet. Loot items in-game (log counting) or run <code>/outputfile inventory</code> and reload.
          </Typography>
        )}
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
