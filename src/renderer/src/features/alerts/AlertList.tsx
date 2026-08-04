// AlertList — the scrolling list of alert rows plus the "Add from suggestion…"
// button that closes it. Extracted from AlertsView.tsx (Wave D factoring); the
// row markup, grid template and hover behavior are unchanged.

import { type JSX, useCallback, useState } from 'react'
import {
  Box,
  Button,
  Collapse,
  Divider,
  IconButton,
  Paper,
  Slider,
  Stack,
  Switch,
  Tooltip,
  Typography
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import EditIcon from '@mui/icons-material/Edit'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import HistoryIcon from '@mui/icons-material/History'
import IosShareIcon from '@mui/icons-material/IosShare'
import type { AlertDef, AlertFireRecord, SoundPack } from '@shared/types'
import { formatTime } from '../../lib/formatDate'
import AudioPicker from './AudioPicker'
import { triggerBadge } from './conditionDraft'

/** The expandable "recent fires" panel for one alert. */
function RecentFires({ fires }: { fires: AlertFireRecord[] }): JSX.Element {
  if (fires.length === 0) {
    return (
      <Typography variant="caption" color="text.disabled" sx={{ pl: 1 }}>
        No fires recorded yet.
      </Typography>
    )
  }
  // Newest first for reading.
  const rows = [...fires].reverse()
  return (
    <Box sx={{ pl: 1, py: 0.5 }}>
      {rows.map((f, i) => (
        <Box
          key={`${f.ts}-${i}`}
          sx={{
            display: 'flex',
            gap: 1,
            fontFamily: 'monospace',
            fontSize: 11,
            lineHeight: 1.5,
            color: 'text.secondary'
          }}
        >
          <Box component="span" sx={{ color: 'text.disabled', whiteSpace: 'nowrap' }}>
            {formatTime(f.ts, { hour12: true })}
          </Box>
          <Box component="span" sx={{ wordBreak: 'break-all' }}>
            {f.matchedText || '(no matched text)'}
          </Box>
        </Box>
      ))}
    </Box>
  )
}

// ── The alert-row layout: ONE shared grid template ────────────────────────────
//
// Every row used to be a `flexWrap` row of content-sized children, so each row's
// controls landed wherever the row's own text pushed them: a long trigger badge
// (`event:buffExpired {spell=Reckless Strength}`) widened the identity block and shoved
// the pickers right, the two pack/sound Selects sized to whichever names were selected,
// and the 5-icon action cluster wrapped onto an orphan second line at a DIFFERENT icon
// count per row. Ten alerts read as ten different layouts.
//
// Symmetry has to come from a template, not from luck: every row is the same CSS grid,
// so a column edge is the same x in row 1 and row 10 regardless of what's in them.
// Nothing wraps — text ellipsizes (full value in a Tooltip) and the tracks absorb the
// slack. Tracks are `minmax(0, …)`: the max is the *preferred* width and the 0 min lets
// a cramped row shrink gracefully instead of overflowing.
//
// Two deliberate shapes, chosen by a CONTAINER query on the Paper (the row's real width
// — a viewport breakpoint would be wrong here, the 220px nav drawer offsets it):
//   wide  → one line:  [toggle] [identity] [voice] [line] [volume] [actions]
//   tight → two lines: [toggle] [identity ......... ] [actions]
//                      [.     ] [voice] [line] [volume]
// The second line indents under identity and reuses the same column edges, so the
// collapse still reads as a grid rather than as a wrap accident.
const ALERT_ROW_TIGHT_COLUMNS = 'auto minmax(0, 1fr) minmax(0, 1fr) auto'
const ALERT_ROW_WIDE_COLUMNS =
  'auto minmax(0, 1.5fr) minmax(0, 175px) minmax(0, 1.4fr) minmax(0, 130px) auto'

const ALERT_ROW_GRID_SX = {
  display: 'grid',
  alignItems: 'center',
  columnGap: 1.5,
  rowGap: 1,
  gridTemplateColumns: ALERT_ROW_TIGHT_COLUMNS,
  gridTemplateAreas: `"toggle identity identity actions" ". voice line volume"`,
  '@container (min-width: 860px)': {
    gridTemplateColumns: ALERT_ROW_WIDE_COLUMNS,
    gridTemplateAreas: `"toggle identity voice line volume actions"`
  }
} as const

// The action cluster is constant: same five icons, same order, same right edge, never
// wrapping. Across a long list that's a lot of chrome, so it rests dimmed and comes up
// to full strength on hover / keyboard focus within the row.
const ALERT_ROW_ACTIONS_SX = {
  gridArea: 'actions',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  flexWrap: 'nowrap'
} as const

const ALERT_ROW_PAPER_SX = {
  px: 1.25,
  py: 1,
  // Establishes the container the row's grid queries above (see ALERT_ROW_GRID_SX).
  containerType: 'inline-size',
  '& .alertRowActions': { opacity: 0.62, transition: 'opacity 120ms ease' },
  '&:hover .alertRowActions, &:focus-within .alertRowActions': { opacity: 1 }
} as const

/**
 * Identity. Both lines are single-line + ellipsis: a long trigger badge
 * (`event:buffExpired {spell=Reckless Strength}`) must never widen this
 * column and shove the rest of the row sideways. Nothing is lost — the
 * full text is one hover away.
 */
function AlertRowIdentity({ def, badge }: { def: AlertDef; badge: string }): JSX.Element {
  return (
    <Box sx={{ gridArea: 'identity', minWidth: 0, opacity: def.enabled ? 1 : 0.55 }}>
      <Tooltip title={def.name} enterDelay={600}>
        <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
          {def.name}
        </Typography>
      </Tooltip>
      <Tooltip title={badge} enterDelay={300}>
        <Typography
          component="div"
          variant="caption"
          color="text.secondary"
          noWrap
          sx={{ fontFamily: 'monospace' }}
        >
          {badge}
        </Typography>
      </Tooltip>
    </Box>
  )
}

/** The per-alert volume slider (drags locally, persists on commit). */
function AlertRowVolume({
  volume,
  onDrag,
  onCommit
}: {
  volume: number
  onDrag: (v: number) => void
  onCommit: (v: number) => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ gridArea: 'volume', minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">
        vol
      </Typography>
      <Slider
        size="small"
        min={0}
        max={1}
        step={0.05}
        value={volume}
        onChange={(_e, v) => onDrag(v as number)}
        onChangeCommitted={(_e, v) => onCommit(v as number)}
        sx={{ flex: 1, minWidth: 0 }}
      />
    </Stack>
  )
}

/** The constant five-icon action cluster (see ALERT_ROW_ACTIONS_SX). */
function AlertRowActions({
  fireCount,
  isOpen,
  onToggle,
  onTest,
  onCopyShare,
  onEdit,
  onDelete
}: {
  fireCount: number
  isOpen: boolean
  onToggle: () => void
  onTest: () => void
  onCopyShare: () => void
  onEdit: () => void
  onDelete: () => void
}): JSX.Element {
  return (
    <Box className="alertRowActions" sx={ALERT_ROW_ACTIONS_SX}>
      <Tooltip title={`Recent fires (${fireCount})`}>
        <IconButton size="small" color={isOpen ? 'primary' : 'default'} onClick={onToggle}>
          <HistoryIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="Test (play now)">
        <IconButton size="small" data-testid="alert-test" onClick={onTest}>
          <PlayArrowIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="Copy share string for this alert">
        <IconButton size="small" onClick={onCopyShare}>
          <IosShareIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="Edit">
        <IconButton size="small" data-testid="alert-edit" onClick={onEdit}>
          <EditIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="Delete">
        <IconButton size="small" color="error" onClick={onDelete}>
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  )
}

/** Callbacks the list forwards to every row (all fire-and-forget from the view). */
interface AlertRowHandlers {
  onPersist: (def: AlertDef) => void
  onVolumeDrag: (id: string, volume: number) => void
  onTest: (def: AlertDef) => void
  onCopyShare: (ids?: string[]) => void
  onEdit: (def: AlertDef) => void
  onRemove: (id: string) => void
}

function AlertRow({
  def,
  fires,
  isOpen,
  packs,
  onToggle,
  handlers
}: {
  def: AlertDef
  fires: AlertFireRecord[]
  isOpen: boolean
  packs: SoundPack[]
  onToggle: (id: string) => void
  handlers: AlertRowHandlers
}): JSX.Element {
  const badge = triggerBadge(def.trigger)
  return (
    <Paper variant="outlined" sx={ALERT_ROW_PAPER_SX} data-testid="alert-row">
      <Box sx={ALERT_ROW_GRID_SX}>
        <Switch
          size="small"
          checked={def.enabled}
          onChange={(e) => handlers.onPersist({ ...def, enabled: e.target.checked })}
          sx={{ gridArea: 'toggle' }}
        />

        <AlertRowIdentity def={def} badge={badge} />

        {/* The two audio Selects — output (pack | voice | both) and, contextually, the sound or
            the speak-what mode. `display: contents` puts them in the 'voice' / 'line' columns
            above; the column NAMES predate the picker and now describe it exactly. */}
        <AudioPicker packs={packs} def={def} onChange={handlers.onPersist} />

        <AlertRowVolume
          volume={def.volume ?? 1}
          onDrag={(v) => handlers.onVolumeDrag(def.id, v)}
          onCommit={(v) => handlers.onPersist({ ...def, volume: v })}
        />

        <AlertRowActions
          fireCount={fires.length}
          isOpen={isOpen}
          onToggle={() => onToggle(def.id)}
          onTest={() => handlers.onTest(def)}
          onCopyShare={() => handlers.onCopyShare([def.id])}
          onEdit={() => handlers.onEdit(def)}
          onDelete={() => handlers.onRemove(def.id)}
        />
      </Box>

      <Collapse in={isOpen} unmountOnExit>
        <Divider sx={{ my: 0.75 }} />
        <Typography variant="caption" color="text.secondary" sx={{ pl: 1, fontWeight: 600 }}>
          Recent fires
        </Typography>
        <RecentFires fires={fires} />
      </Collapse>
    </Paper>
  )
}

export default function AlertList({
  alerts,
  history,
  packs,
  onAddSuggestion,
  handlers
}: {
  alerts: AlertDef[]
  history: Record<string, AlertFireRecord[]>
  packs: SoundPack[]
  onAddSuggestion: () => void
  handlers: AlertRowHandlers
}): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
      <Stack spacing={1}>
        {alerts.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No alerts yet. Add one to play a sound when something happens in your log.
          </Typography>
        )}
        {alerts.map((def) => (
          <AlertRow
            key={def.id}
            def={def}
            fires={history[def.id] ?? []}
            isOpen={expanded.has(def.id)}
            packs={packs}
            onToggle={toggleExpanded}
            handlers={handlers}
          />
        ))}

        {/* Single add flow (Task #54): 'Add from suggestion' sits BELOW the last alert and opens
            the suggestion picker, which itself carries a 'create manually' escape hatch. */}
        <Button
          startIcon={<AddIcon />}
          variant="outlined"
          onClick={onAddSuggestion}
          sx={{ alignSelf: 'flex-start', mt: 0.5 }}
        >
          Add from suggestion…
        </Button>
      </Stack>
    </Box>
  )
}
