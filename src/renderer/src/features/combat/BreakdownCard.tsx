// The dashboard's SECOND CELL (Task #64): one card, two views of the same selection behind a
// tab pair — the composition breakdown it has always shown, and the rogue-poison PROCS ledger
// (ProcsPanel.tsx).
//
// A tab rather than a fifth grid cell: the 2x2 grid is already at the density the 900px
// minimum window allows, and procs are a LENS on the selected fight — the same subject the
// breakdown describes — not a fifth independent subject.

import { useMemo, useState } from 'react'
import { Box, Stack, Tooltip, Typography } from '@mui/material'
import type { SegmentView, SlowRollup, SourceView } from '@shared/combat'
import { CATEGORY_LABEL } from '@shared/combat'
import { formatNum as fmt, formatRate } from '../../lib/formatRate'
import { CAT_COLOR, CopyButton, DashCard, PROC_COLOR, QuietNote, SkillName } from './combatShared'
import { formatProcsText } from './copyText'
import { CardTabs, ProcsBody } from './ProcsPanel'
import { PROC_STRIP_HINT, procSummary } from './procRows'
import { composition, flattenSkills } from './dashboardData'

/** How many skill rows the preview lists before deferring to the full drill. */
const PREVIEW_SKILLS = 6

/**
 * The composition preview: a 100%-stacked category bar plus the source's top skills, built
 * from the engine's AUTHORITATIVE category rollups (not events), so it stays exact for
 * ring-less zone sessions. Clicking anywhere opens the full level-2 flat drill — this is a
 * preview, so it carries no legend of its own.
 */
function CompositionBody({ source, onOpen }: { source: SourceView; onOpen: () => void }): React.JSX.Element {
  const slices = useMemo(() => composition(source), [source])
  // Same grouped flat list the drill shows (slay merged into one row), so the preview and the
  // level-2 list can never disagree about how many rows exist.
  const all = useMemo(() => flattenSkills(source), [source])
  const top = all.slice(0, PREVIEW_SKILLS)
  const more = Math.max(0, all.length - top.length)
  if (slices.length === 0) return <QuietNote>No damage from this source yet.</QuietNote>
  return (
    <Box onClick={onOpen} sx={{ cursor: 'pointer', minWidth: 0 }}>
      <Stack direction="row" sx={{ height: 14, borderRadius: 0.5, overflow: 'hidden', mb: 0.75 }}>
        {slices.map((s) => (
          <Tooltip key={s.category} title={`${CATEGORY_LABEL[s.category]} · ${fmt(s.total)} · ${Math.round(s.pct)}%`}>
            <Box sx={{ width: `${s.pct}%`, bgcolor: CAT_COLOR[s.category], opacity: 0.75, minWidth: 2 }} />
          </Tooltip>
        ))}
      </Stack>
      {top.map((s) => (
        <Box key={`${s.category}|${s.name}`} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: '1px' }}>
          <Box sx={{ width: 6, height: 6, borderRadius: '2px', bgcolor: CAT_COLOR[s.category], flexShrink: 0 }} />
          <Typography variant="caption" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
            <SkillName name={s.name} category={s.category} />
          </Typography>
          <Box
            sx={{
              width: 54,
              height: 5,
              borderRadius: 1,
              bgcolor: 'rgba(255,255,255,0.06)',
              flexShrink: 0,
              overflow: 'hidden'
            }}
          >
            <Box sx={{ width: `${Math.max(3, s.pct)}%`, height: '100%', bgcolor: CAT_COLOR[s.category], opacity: 0.7 }} />
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ width: 52, textAlign: 'right' }}>
            {fmt(s.total)}
          </Typography>
        </Box>
      ))}
      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.25 }}>
        {more > 0 ? `+${more} more — click for the full breakdown` : 'click for the full breakdown'}
      </Typography>
    </Box>
  )
}

/**
 * THE SUMMARY STRIP (docs/plans/proc-visibility.md §1) — one line inside the composition body
 * saying that the proc ledger exists and what it currently holds, and taking you there.
 *
 * It renders only when the selection HAS proc activity, which is the opposite discipline from
 * the tab pair beside it: the tabs are always drawn (an unfindable feature is not a feature),
 * but a fight with no procs must not grow a row saying so. One Typography line, no card, no
 * fifth grid cell — the 2x2 grid is already at the density a 900px window allows.
 */
function ProcStrip({ text, onOpen }: { text: string; onOpen: () => void }): React.JSX.Element {
  return (
    <Tooltip title={PROC_STRIP_HINT}>
      <Typography
        variant="caption"
        noWrap
        onClick={onOpen}
        data-testid="proc-strip"
        sx={{
          display: 'block',
          cursor: 'pointer',
          userSelect: 'none',
          mb: 0.5,
          color: PROC_COLOR,
          '&:hover': { textDecoration: 'underline' }
        }}
      >
        {text}
      </Typography>
    </Tooltip>
  )
}

/**
 * The card. Tab state is local and deliberately NOT persisted: it is a glance, and a user who
 * left it on Procs a week ago should not find their breakdown missing.
 */
export function BreakdownPreviewCard({
  source,
  seg,
  slow,
  onOpen
}: {
  source: SourceView | null
  /** The selected segment — the Procs tab's subject, and what its copy-out names. */
  seg: SegmentView
  /** Rolling time-to-slow across recent pulls (engine-wide, not this segment). */
  slow: SlowRollup | undefined
  onOpen: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<'breakdown' | 'procs'>('breakdown')
  const procs = seg.procs
  const onProcs = tab === 'procs'
  // ONE rollup for the tab badge, the strip and the header count — read off the same ProcsView
  // `ProcsBody` renders below. Three readouts, one number, by construction.
  const summary = procSummary(procs)
  const nProcs = summary.count
  // A LIVE segment's open state spans are still running, so `now` is their honest end; a
  // finalized one has no knowable end here and its open spans decline to state a length.
  const endTs = seg.active ? Date.now() : 0

  return (
    <DashCard
      title={onProcs ? 'Procs' : source ? `Breakdown · ${source.name}` : 'Breakdown'}
      right={
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
          {onProcs ? (
            <>
              <Typography variant="caption" color="text.secondary" noWrap>
                {nProcs} proc{nProcs === 1 ? '' : 's'}
              </Typography>
              <CopyButton getText={() => formatProcsText(seg, slow)} title="Copy this proc breakdown as text" />
            </>
          ) : source ? (
            <Typography variant="caption" color="text.secondary" noWrap>
              {fmt(source.total)} · {formatRate(source.dps)}
            </Typography>
          ) : null}
          {/* ALWAYS rendered (owner report: "I can't find it in the UI"). The old auto-hide made
              discoverability depend on whether the CURRENT selection happened to have procs —
              so a user who had never fought something proccy never learned the tab existed.
              An empty selection now shows a quiet, honest line instead. */}
          <CardTabs value={tab} procs={summary.tab} onChange={setTab} />
        </Stack>
      }
      fill
      testId="dash-panel"
    >
      {onProcs ? (
        <ProcsBody
          procs={procs}
          slow={slow}
          isFight={seg.kind === 'fight'}
          activeSec={seg.activeSec}
          endTs={endTs}
        />
      ) : (
        <>
          {nProcs > 0 && <ProcStrip text={summary.strip} onOpen={() => setTab('procs')} />}
          {source ? <CompositionBody source={source} onOpen={onOpen} /> : <QuietNote>No damage from this source yet.</QuietNote>}
        </>
      )}
    </DashCard>
  )
}
