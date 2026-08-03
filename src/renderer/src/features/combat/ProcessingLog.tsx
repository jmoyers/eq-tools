// The Combat tab's classification-ring readout — the append-only "Combat log" card at the
// bottom of the view. Split out of CombatView.tsx.

import { memo, useEffect, useRef } from 'react'
import { Box, FormControlLabel, Switch, Typography } from '@mui/material'
import { DashCard, QuietNote } from './combatShared'
import { formatTime } from '../../lib/formatDate'
import type { ClassifiedLine } from '@shared/combat'

const ROLE_COLOR: Record<string, string> = {
  you: '#d9b25f',
  pet: '#6fb3d2',
  enemy: '#cf6679',
  info: '#9aa0aa',
  dropped: '#e0554f'
}

// One classification-ring line. Memoized by value so that on each tick only the
// newly-appended lines mount — the ~150 stable prior lines skip re-render.
const LogLine = memo(
  function LogLine({ l }: { l: ClassifiedLine }): React.JSX.Element {
    return (
      <Box sx={{ display: 'flex', gap: 1, color: ROLE_COLOR[l.role] ?? 'text.primary', lineHeight: 1.5 }}>
        <span style={{ color: 'var(--mui-palette-text-disabled)', opacity: 0.7 }}>{formatTime(l.ts)}</span>
        <span style={{ minWidth: 62, opacity: 0.8 }}>{l.cat}</span>
        <span style={{ whiteSpace: 'pre-wrap' }}>{l.text}</span>
      </Box>
    )
  },
  (p, n) => p.l.ts === n.l.ts && p.l.cat === n.l.cat && p.l.role === n.l.role && p.l.text === n.l.text
)

export function ProcessingLog({
  lines,
  showUnparsed,
  setShowUnparsed
}: {
  lines: ClassifiedLine[]
  showUnparsed: boolean
  setShowUnparsed: (v: boolean) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])
  // FIXED height, not minHeight (Task #56): this card's body is an append-only ring that grows
  // to 150 lines. As `flex: 0 0 auto` it sized to that CONTENT and — being unshrinkable —
  // squeezed the entire dashboard down to its `minHeight: 0`, so a few seconds after the live
  // tail started the Combat tab was JUST a scrolling log. The ring scrolls inside a fixed box.
  return (
    <DashCard
      title="Combat log"
      right={
        <FormControlLabel
          control={<Switch size="small" checked={showUnparsed} onChange={(e) => setShowUnparsed(e.target.checked)} />}
          label={<Typography variant="caption">show unparsed</Typography>}
          sx={{ m: 0 }}
        />
      }
      height={220}
    >
      <Box
        ref={ref}
        data-testid="combat-log"
        sx={{ overflow: 'auto', flexGrow: 1, minHeight: 0, fontFamily: '"Consolas","Courier New",monospace', fontSize: 11 }}
      >
        {lines.length === 0 && <QuietNote>Waiting for combat…</QuietNote>}
        {lines.map((l, i) => (
          <LogLine key={`${l.ts}|${l.cat}|${i}`} l={l} />
        ))}
      </Box>
    </DashCard>
  )
}
