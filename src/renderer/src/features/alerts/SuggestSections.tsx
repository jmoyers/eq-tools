// SuggestSections — the slim sticky section header and the row list under it.
//
// docs/plans/suggest-dialog-redesign.md §2/§3: sections are HEADERS, not cards. A card per
// group costs a border, two paddings and a shadow per group, which is most of the vertical
// budget the redesign is trying to give back to rows. So a section is one slim sticky bar
// (title · count · an optional inline action) over a plain row list.
//
// STICKY, because the list scrolls inside the dialog's fixed-height paper (the perf fix's
// geometry): with four spell sections in one scroll box, the header that names what you are
// looking at has to stay on screen while you scroll through it.

import type { JSX, ReactNode } from 'react'
import { Box, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import CloseIcon from '@mui/icons-material/Close'
import type { AlertDef, SpellCatalogEntry } from '@shared/types'
import type { PoisonSlowOffer } from '@shared/spellLines'
import { poisonSlowAlertDefs } from '@shared/alertGroups'
import SpellRow, {
  ROW_CHIP_SX,
  SUGGEST_ROW_SX,
  TemplateChip,
  type RowContext
} from './SpellSuggestionRow'
import { SUGGEST_TEMPLATES, type Suggestion } from './suggestions'

/**
 * One collapsible section. `count` is the TRUE match count, so a collapsed or truncated
 * section still says how much is behind it.
 *
 * `open` is not the same thing as "the user expanded it": a live search forces every matching
 * section open (§2), because a hit hidden behind a collapsed header reads as no hit at all.
 */
export function SectionShell({
  title,
  count,
  open,
  onToggle,
  action,
  children
}: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
  /** an inline control that belongs to the section itself (the shared illusion alert). */
  action?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <Box>
      <Stack
        direction="row"
        spacing={0.75}
        alignItems="center"
        onClick={onToggle}
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 2,
          bgcolor: 'background.paper',
          borderBottom: 1,
          borderColor: 'divider',
          px: 0.5,
          py: 0.25,
          cursor: 'pointer',
          userSelect: 'none',
          '&:hover': { bgcolor: 'action.hover' }
        }}
      >
        {open ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
        <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: 0.4 }}>
          {title.toUpperCase()}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {count}
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        {/* The action is the section's own control — clicking it must not fold the section. */}
        {action && <Box onClick={(e) => e.stopPropagation()}>{action}</Box>}
      </Stack>
      {open && <Box sx={{ pt: 0.25 }}>{children}</Box>}
    </Box>
  )
}

/**
 * The rows of one section, plus the honest tail when the shared row budget cut it short
 * (resultSections.ts): saying "+N more" is the difference between a bounded list and a list
 * that quietly lies about what matched.
 */
export function SpellRows({
  rows,
  total,
  existingIds,
  onCreate,
  ctx,
  showType
}: {
  rows: SpellCatalogEntry[]
  total: number
  existingIds: Set<string>
  onCreate: (s: Suggestion) => void
  ctx: RowContext
  showType?: boolean
}): JSX.Element {
  return (
    <>
      {rows.map((e) => (
        <SpellRow
          key={e.key}
          entry={e}
          existingIds={existingIds}
          onCreate={onCreate}
          ctx={ctx}
          showType={showType}
        />
      ))}
      {total > rows.length && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1, py: 0.5 }}>
          +{total - rows.length} more — keep typing to narrow it down.
        </Typography>
      )}
    </>
  )
}

/** "3 slows landed" — the observation, plural-correct, with no rate and no percentage. */
function observedSlows(n: number): string {
  return n === 1 ? '1 slow landed' : `${n} slows landed`
}

/**
 * THE ROGUE-SLOW OFFER, AS A NORMAL ROW (owner, looking at the old bordered card: "get rid of
 * this — just a normal row").
 *
 * It used to be a primary-bordered card with an icon, a bold headline and a contained ADD ALERT
 * button, sitting above the spell rows it belongs with. That styling said "I am exceptional",
 * which is the opposite of what §2 of docs/plans/suggest-dialog-redesign.md moved it here to say:
 * the app volunteers alerts in ONE list, ordered by what it has seen, and this is one of them.
 *
 * So it is literally the same box as its neighbours — `SUGGEST_ROW_SX`, the same primary/muted
 * type pair, the same `TemplateChip` create affordance, the same 18px chips — plus one small
 * inline X, because unlike a spell row this one can be waved away for good.
 *
 * NOTHING BEHIND IT CHANGED: same detector (`detectPoisonSlowOffers`), same dismissal set, same
 * def written by the same `poisonSlowAlertDefs()` the "Rogue slow poisons" group card writes —
 * one id, two doors, so clicking either is idempotent.
 *
 * COPY RULE (unchanged): no slow PERCENTAGE appears here or anywhere else in the feature. The
 * wiki states both 35% and 15% for Weakening Strike and the contradiction is unresolved; the
 * observed count and the mob it last landed on are the facts we actually have.
 */
export function PoisonSlowRow({
  offer,
  existingIds,
  onPersist,
  onDismiss
}: {
  offer: PoisonSlowOffer
  existingIds: Set<string>
  /** persist one alert (the same upsert the groups panel and the upgrade strip use). */
  onPersist: (def: AlertDef) => void
  /** hide this offer for good. */
  onDismiss: (id: string) => void
}): JSX.Element {
  const defs = poisonSlowAlertDefs()
  const created = defs.length > 0 && defs.every((d) => existingIds.has(d.id))
  return (
    <Box sx={SUGGEST_ROW_SX}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0, flexGrow: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 500, minWidth: 0 }} noWrap>
          Rogue slow landed
        </Typography>
        {/* The neighbouring rows in this section carry a buff/debuff chip (`showType`); a slow
            landing on a mob is a debuff, and saying so keeps the column reading as one list. */}
        <Chip size="small" label="debuff" color="error" variant="outlined" sx={ROW_CHIP_SX} />
        <Typography variant="caption" color="text.secondary" noWrap>
          {observedSlows(offer.count)} · last on {offer.lastTarget}
        </Typography>
      </Box>
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexShrink: 0 }}>
        <Tooltip title="Weakening Strike, the rogue utility-poison slow — 3:30, rate-limited to about one nudge per pull">
          {/* The SAME wording the per-spell `lands` template uses, from the same constant: this
              row creates the same kind of alert, so it must not invent a second phrasing. */}
          <span>
            <TemplateChip
              label={SUGGEST_TEMPLATES.lands.chip}
              created={created}
              onClick={() => {
                for (const def of defs) onPersist(def)
              }}
            />
          </span>
        </Tooltip>
        <Tooltip title="Dismiss — don’t offer this again">
          <IconButton size="small" sx={{ p: 0.25 }} onClick={() => onDismiss(offer.id)}>
            <CloseIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      </Stack>
    </Box>
  )
}

/** The shared illusion alert, offered as the Illusions section's own inline action. */
export function IllusionAction({
  created,
  onCreate
}: {
  created: boolean
  onCreate: () => void
}): JSX.Element {
  return (
    <Chip
      size="small"
      variant={created ? 'filled' : 'outlined'}
      color={created ? 'success' : 'default'}
      clickable={!created}
      disabled={created}
      onClick={onCreate}
      label="When your illusion fades"
      sx={{ height: 20, '& .MuiChip-label': { px: 0.75, fontSize: '0.7rem' } }}
    />
  )
}
