// DpsCard — "how hard am I hitting, right now", and the way down to the Combat tab.
//
// It shows DELIBERATELY LESS than the Combat tab: one label, one headline rate, one supporting
// line, a handful of rows. No scope toggle, no fight selector, no timeline, no Outgoing/Incoming
// switch, no combat log. If you want any of those, that is what the link is for
// (docs/plans/overview-tab.md §3.1).
//
// It does now have ONE interaction of its own: the rows open on YOUR damage breakdown (the same
// default the Combat tab drills to), with the pet nested as one line item that drills into the
// pet's own skills, and a back chevron that steps out to the plain source list. That state is
// CARD-LOCAL and deliberately unpersisted: it must never move the Combat tab's drill, and coming
// back to Overview always shows the glance, not wherever you had wandered.
//
// THE LABEL IS NOT RE-DERIVED. `fightScopeOptions(...).head.label` is the ONE place the honest
// live/last wording is decided ("Current fight (live)" while a pull is open, "Last fight — <name>"
// between pulls), and the Combat tab's head row reads the same function. A second copy of that
// sentence here is exactly the drift `scopeOptions()` exists to prevent — so this card renders it
// VERBATIM, and the two surfaces can never disagree about whether you are in a fight.
//
// Likewise the SUBJECT: the snapshot is pulled with no `selectedId`, so the engine resolves the
// default (open fight, else the most recent finalized one) — by construction the same fight the
// head row names. That identity is what makes "Open in Combat" land on the fight you were
// looking at, and why the button always sends the LIVE_SELECTION sentinel rather than a pinned
// id: the sentinel re-resolves every tick, so it follows you out of this pull and into the next.
//
// And the NUMBERS: the headline is `seg.outDps` / `seg.outTotal` — you AND your pets, the same
// aggregate the Combat tab's panel header shows. Nesting the pet changes how the rows are laid
// out, never what they sum to.

import { useEffect, useState, type JSX } from 'react'
import { Box, Button, IconButton, Stack, Typography } from '@mui/material'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import type { CombatSnapshot, SegmentView, SourceView } from '@shared/combat'
import { Bar, CAT_COLOR, DashCard, KIND_COLOR, QuietNote, fmtDur } from '../combat/combatShared'
import { LIVE_SELECTION, fightScopeOptions } from '../combat/dashboardData'
import { PetBar } from '../combat/PetBar'
import { nestedRows, ownBreakdown, type OwnRow } from '../combat/petRows'
import { useCombinePetRow } from '../combat/useCombatPrefs'
import type { CombatFocus } from '../combat/combatFocus'
import { formatNum, formatRate } from '../../lib/formatRate'

/** How many rows a GLANCE shows, at any level. The full list is one click away. */
const TOP_ROWS = 5

/**
 * The card's own drill. `sources` is the plain source list (the un-drilled view, and what this
 * card showed before the default changed); `self` is your breakdown; `pet` is one pet's own.
 */
type CardDrill = { kind: 'sources' } | { kind: 'self' } | { kind: 'pet'; id: string }

export interface DpsCardProps {
  snap: CombatSnapshot | null
  onOpenCombat: (f: CombatFocus) => void
}

/** total · duration · active-time DPS — the secondary stat, never the headline (law 7). */
function supportingLine(seg: SegmentView): string {
  return `${formatNum(seg.outTotal)} total · ${fmtDur(seg.durationSec)} · ${formatRate(seg.activeDps)} active`
}

function OpenInCombat({ onOpenCombat }: { onOpenCombat: (f: CombatFocus) => void }): JSX.Element {
  return (
    <Button
      size="small"
      data-testid="overview-open-combat"
      endIcon={<OpenInNewIcon sx={{ fontSize: 14 }} />}
      onClick={() => onOpenCombat({ scope: 'fight', selection: LIVE_SELECTION })}
      sx={{ minWidth: 0, py: 0, px: 0.75 }}
    >
      Open in Combat
    </Button>
  )
}

/** The one-line "you are one level down" strip: a compact chevron back plus what you're in. */
function DrillStrip({ label, onBack }: { label: string; onBack: () => void }): JSX.Element {
  return (
    <Stack direction="row" alignItems="center" spacing={0.25} sx={{ mb: 0.25, minWidth: 0 }}>
      <IconButton size="small" data-testid="overview-dps-back" onClick={onBack} sx={{ p: 0.25 }}>
        <ChevronLeftIcon sx={{ fontSize: 16 }} />
      </IconButton>
      <Typography variant="caption" color="text.secondary" noWrap>
        {label}
      </Typography>
    </Stack>
  )
}

/** The honest tail when the card's cap is truncating — and the way to the full list. */
function MoreRows({ n, onOpenCombat }: { n: number; onOpenCombat: () => void }): JSX.Element {
  return (
    <Typography
      variant="caption"
      color="text.disabled"
      onClick={onOpenCombat}
      sx={{ cursor: 'pointer', '&:hover': { color: 'text.secondary' } }}
    >
      +{n} more
    </Typography>
  )
}

/** One row of a breakdown list: your skill lane, or the nested pet (which drills). */
function BreakdownRow({ row, onDrill }: { row: OwnRow; onDrill: (id: string) => void }): JSX.Element {
  if (row.kind === 'pet') {
    return (
      <Box data-testid="overview-dps-drill">
        <PetBar pet={row.pet} pct={row.pct} onDrill={() => onDrill(row.pet.id)} />
      </Box>
    )
  }
  return (
    <Bar
      color={CAT_COLOR[row.skill.category]}
      accent={CAT_COLOR[row.skill.category]}
      pct={row.pct}
      name={row.skill.name}
      right={formatNum(row.skill.total)}
    />
  )
}

/**
 * The plain source list — the un-drilled level (one row per source, pets included). This is what
 * the card showed before the default became "drilled"; `hasSelf` offers the way back down.
 */
function SourceLevel({
  entities,
  hasSelf,
  onDrill
}: {
  entities: SourceView[]
  hasSelf: boolean
  onDrill: () => void
}): JSX.Element {
  if (entities.length === 0) return <QuietNote>Nothing has landed in this fight yet.</QuietNote>
  return (
    <>
      {entities.slice(0, TOP_ROWS).map((e, i) => (
        <Bar key={e.id} color={KIND_COLOR[e.kind] ?? '#888'} pct={e.pct} rank={i + 1} name={e.name} right={formatRate(e.dps)} />
      ))}
      {hasSelf && (
        <Typography
          variant="caption"
          color="text.disabled"
          data-testid="overview-dps-drill"
          onClick={onDrill}
          sx={{ cursor: 'pointer', '&:hover': { color: 'text.secondary' } }}
        >
          your breakdown ›
        </Typography>
      )}
    </>
  )
}

/** The rows for whatever level the card is on, plus the strip/tail that frame them. */
function DpsRows({
  seg,
  drill,
  setDrill,
  combinePetRow,
  onOpenCombat
}: {
  seg: SegmentView
  drill: CardDrill
  setDrill: (d: CardDrill) => void
  combinePetRow: boolean
  onOpenCombat: () => void
}): JSX.Element {
  const own = ownBreakdown(seg.entities, combinePetRow)
  // A drilled pet that is no longer in this fight falls back to your breakdown rather than to a
  // blank list — the same "stale drill degrades to its parent" rule the Combat tab uses.
  const pet = drill.kind === 'pet' ? seg.entities.find((e) => e.id === drill.id) ?? null : null
  if (drill.kind === 'sources') {
    return (
      <Stack sx={{ minWidth: 0 }}>
        <SourceLevel entities={seg.entities} hasSelf={!!own.self} onDrill={() => setDrill({ kind: 'self' })} />
      </Stack>
    )
  }
  const rows = pet ? nestedRows(pet, []) : own.rows
  const shown = rows.slice(0, TOP_ROWS)

  return (
    <Stack sx={{ minWidth: 0 }}>
      <DrillStrip
        label={pet ? pet.name : 'your damage'}
        onBack={() => setDrill(pet ? { kind: 'self' } : { kind: 'sources' })}
      />
      {shown.length === 0 ? (
        <QuietNote>Nothing has landed in this fight yet.</QuietNote>
      ) : (
        shown.map((r) => (
          <BreakdownRow
            key={r.kind === 'pet' ? r.pet.id : `${r.skill.category}|${r.skill.name}`}
            row={r}
            onDrill={(id) => setDrill({ kind: 'pet', id })}
          />
        ))
      )}
      {rows.length > shown.length && <MoreRows n={rows.length - shown.length} onOpenCombat={onOpenCombat} />}
    </Stack>
  )
}

export function DpsCard({ snap, onOpenCombat }: DpsCardProps): JSX.Element {
  const head = fightScopeOptions(snap?.segments ?? []).head
  const seg = snap?.selected ?? null
  const [combinePetRow] = useCombinePetRow()
  // Card-local, unpersisted: the Combat tab owns the drill that sticks (`eq.combat.drill`).
  // The level the card OPENS on follows the preference — combined, your breakdown is the
  // interesting list; uncombined, the pet is a source of its own and hiding it behind a drill
  // would make the glance card show strictly less than it used to.
  const [drill, setDrill] = useState<CardDrill>(() => (combinePetRow ? { kind: 'self' } : { kind: 'sources' }))
  useEffect(() => setDrill(combinePetRow ? { kind: 'self' } : { kind: 'sources' }), [combinePetRow])

  return (
    // The link down is offered even with nothing to show: "there are no fights" is a thing the
    // Combat tab says better than a glance card can, and a disappearing button would make the
    // one affordance this card exists for the least reliable thing on it.
    <DashCard title="Damage" testId="overview-dps" right={<OpenInCombat onOpenCombat={onOpenCombat} />}>
      {/* No fights at all ⇒ the same honest quiet state the Combat tab shows. It never borrows
          the zone aggregate to look busy — Overall is a click away and says so there. */}
      {!head || !seg ? (
        <QuietNote>No fights yet — engage something and it’ll appear here.</QuietNote>
      ) : (
        <>
          <Typography variant="caption" color="text.secondary" data-testid="overview-dps-label" noWrap>
            {head.label}
          </Typography>
          <Typography variant="h4" sx={{ color: 'primary.main', lineHeight: 1.15 }} data-testid="overview-dps-value">
            {formatRate(seg.outDps)}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mb: 0.75 }}>
            {supportingLine(seg)}
          </Typography>
          <DpsRows
            seg={seg}
            drill={drill}
            setDrill={setDrill}
            combinePetRow={combinePetRow}
            onOpenCombat={() => onOpenCombat({ scope: 'fight', selection: LIVE_SELECTION })}
          />
        </>
      )}
    </DashCard>
  )
}
