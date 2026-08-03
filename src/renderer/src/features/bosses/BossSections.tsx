// BossSections — the roster's CARDS and the two ways of sectioning them. Split out of BossView
// so that view is the toolbar + the filtering it owns, and so a second grouping could be added
// without the file growing past the factoring ceiling.
//
// TWO GROUPINGS, ONE GRID. `CategorySection` is EQ raid progression order (Open World → Fear →
// Hate → Sky) and stays the default: it is what the roster is FOR. `LoadoutSections` answers the
// other question this app can now ask — "which classes was I running when I killed these?" — by
// TIME-JOINING each target's latest kill against the class-combo intervals (shared/comboIndex).
//
// THE JOIN IS A DISPLAY GROUPING AND NOTHING ELSE. bossStatus.ts stays combo-unaware, no kill
// record is stamped with an interval id (ids are recompute-unstable by design — see
// shared/comboIndex.ts), and no signal changes: the same kills, the same confetti, the same
// bossDefeat sound. Only the headers above them are new.
//
// A target killed repeatedly lands under the loadout of its MOST RECENT kill, which is the only
// rule a per-target roster can state honestly — `TargetStatus` carries first/last and a count,
// never a per-kill list. The section header says so.

import { type JSX, useMemo, useState } from 'react'
import { Box, Chip, Paper, Stack, Tooltip, Typography } from '@mui/material'
import CheckIcon from '@mui/icons-material/Check'
import type { RaidTarget } from '@shared/types'
import type { ComboInterval } from '@shared/classCombo'
import { groupByCombo } from '@shared/comboIndex'
import type { TargetStatus } from './bossStatus'
import type { MobTarget } from '../mobs/mobTarget'
import { tierStyle, type TierStyle } from '../../lib/tierChip'
import { formatDate, formatDateTime } from '../../lib/formatDate'
import { cachedImageUrl } from '../../lib/imageUrl'
import { useComboIntervals } from '../profiles/ClassComboData'
import { ProvenanceChip, SlotChips } from '../profiles/ClassComboChips'
import { spanText } from '../profiles/ClassComboLabels'

function BossImage({
  target,
  height,
  dim
}: {
  target: RaidTarget
  height: number
  dim?: boolean
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (target.image && !failed) {
    return (
      <Box
        component="img"
        // NEVER the raw `target.image`. `bosses.json` carries real wiki.project1999.com URLs
        // (scraped data stays honest), but a portrait must be downloaded at most ONCE ever —
        // so it is served from the app's permanent cache instead. A URL the main process
        // refuses, or a portrait that 404s, falls through to the initials tile below via
        // onError, exactly as before.
        src={cachedImageUrl(target.image)}
        alt={target.name}
        onError={() => setFailed(true)}
        sx={{
          width: '100%',
          height,
          objectFit: 'cover',
          objectPosition: 'top',
          display: 'block',
          filter: dim ? 'grayscale(1) brightness(0.5)' : 'none'
        }}
      />
    )
  }
  const initials = target.name
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
  return (
    <Box
      sx={{
        width: '100%',
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'action.hover',
        color: 'text.disabled',
        fontSize: height > 90 ? 26 : 18,
        fontWeight: 700
      }}
    >
      {initials}
    </Box>
  )
}

// The little tier-coloured tick in the card's top-left corner: "you have this one".
function TargetKilledBadge({ tier }: { tier: TierStyle }): JSX.Element {
  return (
    <Box
      sx={{
        position: 'absolute',
        top: 4,
        left: 4,
        zIndex: 1,
        width: 20,
        height: 20,
        borderRadius: '50%',
        bgcolor: tier.bg,
        color: tier.fg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: 1
      }}
    >
      <CheckIcon sx={{ fontSize: 14 }} />
    </Box>
  )
}

// Portrait + the tier chip that overlays its top-right corner. An undefeated target is
// greyed out and its chip reads "not defeated" on a neutral scrim instead of a tier colour.
function TargetCardMedia({
  s,
  tier,
  height
}: {
  s: TargetStatus
  tier: TierStyle
  height: number
}): JSX.Element {
  return (
    <Box sx={{ position: 'relative' }}>
      <BossImage target={s.target} height={height} dim={!s.killed} />
      <Tooltip title={s.killed ? tier.long : 'Not defeated'}>
        <Chip
          size="small"
          label={s.killed ? tier.label : 'not defeated'}
          sx={{
            position: 'absolute',
            top: 4,
            right: 4,
            height: 20,
            bgcolor: s.killed ? tier.bg : 'rgba(0,0,0,0.65)',
            color: s.killed ? tier.fg : '#fff',
            fontWeight: 700,
            fontSize: 11,
            '& .MuiChip-label': { px: 0.75 }
          }}
        />
      </Tooltip>
    </Box>
  )
}

// The date line under a DEFEATED target's name. A single kill states one date; repeats
// spell out first and last in the tooltip. The comfortable density also shows the count.
function TargetKillDate({ s, compact }: { s: TargetStatus; compact: boolean }): JSX.Element {
  return (
    <Tooltip
      title={
        s.firstTs && s.firstTs !== s.lastTs
          ? `First ${formatDateTime(s.firstTs)} · Last ${formatDateTime(s.lastTs)}`
          : `Defeated ${formatDateTime(s.lastTs || s.firstTs)}`
      }
    >
      <Typography variant="caption" color="text.secondary" noWrap display="block">
        {formatDate(s.lastTs || s.firstTs)}
        {!compact && ` · ${s.count} kill${s.count === 1 ? '' : 's'}`}
      </Typography>
    </Tooltip>
  )
}

// Everything below the portrait: name, zone (comfortable only) and the kill/no-kill line.
function TargetCardCaption({ s, compact }: { s: TargetStatus; compact: boolean }): JSX.Element {
  return (
    <Box sx={{ p: compact ? 0.75 : 1 }}>
      <Typography
        variant={compact ? 'caption' : 'body2'}
        noWrap
        title={s.target.name}
        sx={{ fontWeight: 600, color: s.killed ? 'text.primary' : 'text.secondary' }}
      >
        {s.target.name}
      </Typography>
      {!compact && (
        <Typography variant="caption" color="text.secondary" noWrap display="block">
          {s.target.zone ?? ''}
        </Typography>
      )}
      {s.killed ? (
        <TargetKillDate s={s} compact={compact} />
      ) : (
        !compact && (
          <Typography variant="caption" color="text.disabled" display="block">
            not defeated
          </Typography>
        )
      )}
    </Box>
  )
}

/**
 * What a roster card hands the app-wide mob page. A roster card carries no consider (you may
 * never have conned it), so the page simply renders without the con block — never with an
 * invented one. The kill facts come from the status the roster already computed, which is
 * article-insensitive matching the log's `match` names (bossStatus.ts).
 */
function mobTargetForStatus(t: TargetStatus): MobTarget {
  return {
    mob: t.target.name,
    kill:
      t.count > 0
        ? { count: t.count, bestTier: t.bestTier, firstTs: t.firstTs, lastTs: t.lastTs }
        : undefined
  }
}

function TargetCard({
  s,
  compact,
  flash,
  onOpen
}: {
  s: TargetStatus
  compact: boolean
  flash?: boolean
  onOpen: (s: TargetStatus) => void
}): JSX.Element {
  const imgH = compact ? 70 : 120
  const tier = tierStyle(s.bestTier)
  const tierColor = tier.bg
  return (
    <Paper
      variant="outlined"
      // A raid target IS a mob, so it opens the same mob PAGE everything else does (Task #64).
      onClick={() => onOpen(s)}
      title={`${s.target.name} — drops, quests, your kills`}
      sx={{
        overflow: 'hidden',
        position: 'relative',
        cursor: 'pointer',
        borderWidth: 2,
        borderColor: flash ? tierColor : s.killed ? tierColor : 'divider',
        boxShadow: flash
          ? `0 0 22px ${tierColor}, 0 0 8px ${tierColor}`
          : s.killed
            ? `0 0 10px ${tierColor}55`
            : 'none',
        transform: flash ? 'scale(1.04)' : 'none',
        transition: 'transform 200ms, box-shadow 200ms, border-color 200ms',
        '&:hover': { transform: flash ? 'scale(1.04)' : 'translateY(-2px)' }
      }}
    >
      {s.killed && <TargetKilledBadge tier={tier} />}
      <TargetCardMedia s={s} tier={tier} height={imgH} />
      <TargetCardCaption s={s} compact={compact} />
    </Paper>
  )
}

/** Everything a section needs to draw its grid — identical for both groupings. */
export interface SectionProps {
  list: TargetStatus[]
  compact: boolean
  minCol: number
  flashing: Set<string>
  onOpenMob: (t: MobTarget) => void
}

/** A header plus the grid under it. The ONE grid in this feature; both groupings use it. */
function Section({ header, list, compact, minCol, flashing, onOpenMob }: SectionProps & { header: JSX.Element }): JSX.Element {
  return (
    <Box sx={{ mb: compact ? 1.5 : 2.5 }}>
      {header}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fill, minmax(${minCol}px, 1fr))`,
          gap: compact ? 1 : 1.5
        }}
      >
        {list.map((s) => (
          <TargetCard
            key={s.target.name}
            s={s}
            compact={compact}
            flash={flashing.has(s.target.name)}
            onOpen={(t) => onOpenMob(mobTargetForStatus(t))}
          />
        ))}
      </Box>
    </Box>
  )
}

/** One progression category (Open World, Fear, Hate, Sky) and its grid of target cards. */
export function CategorySection({ category, ...rest }: SectionProps & { category: string }): JSX.Element {
  return (
    <Section
      {...rest}
      header={
        <Typography variant="subtitle2" sx={{ mb: 0.75, color: 'primary.main' }}>
          {category}{' '}
          <Typography component="span" variant="caption" color="text.secondary">
            ({rest.list.filter((s) => s.killed).length}/{rest.list.length})
          </Typography>
        </Typography>
      }
    />
  )
}

const GROUP_RULE = 'Grouped by the loadout you were running at your most recent kill of each target.'

/** One loadout section: the interval (null = no interval covers those kills) and its targets. */
interface LoadoutGroup {
  key: string
  interval: ComboInterval | null
  list: TargetStatus[]
}

/** The loadout header: the slots as chips, its provenance, and the span they cover. */
function LoadoutHeader({ group }: { group: LoadoutGroup }): JSX.Element {
  const interval = group.interval
  return (
    <Tooltip title={GROUP_RULE}>
      <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
        {interval ? (
          <>
            <SlotChips slots={interval.slots} />
            <ProvenanceChip interval={interval} />
            <Typography variant="caption" color="text.secondary">
              {spanText(interval)}
            </Typography>
          </>
        ) : (
          <Typography variant="subtitle2" color="text.secondary">
            Loadout not known
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary">
          ({group.list.length})
        </Typography>
      </Stack>
    </Tooltip>
  )
}

/** Defeated targets, time-joined to the combo intervals; undefeated ones are not grouped. */
function useLoadoutGroups(list: TargetStatus[]): LoadoutGroup[] {
  const intervals = useComboIntervals()
  return useMemo(() => {
    const rows = list.filter((s) => s.killed && s.lastTs > 0).map((s) => ({ ts: s.lastTs, status: s }))
    return groupByCombo(intervals, rows).map((g) => ({
      key: g.interval?.id ?? 'unknown',
      interval: g.interval,
      list: g.rows.map((r) => r.status)
    }))
  }, [intervals, list])
}

/**
 * The roster sectioned by class loadout. Undefeated targets carry no timestamp to join on, so
 * they keep their own trailing section instead of being silently dropped or attributed.
 */
export function LoadoutSections({ list, ...rest }: SectionProps): JSX.Element {
  const groups = useLoadoutGroups(list)
  const undefeated = list.filter((s) => !s.killed || s.lastTs === 0)
  return (
    <>
      {groups.map((group) => (
        <Section key={group.key} {...rest} list={group.list} header={<LoadoutHeader group={group} />} />
      ))}
      {undefeated.length > 0 && (
        <Section
          {...rest}
          list={undefeated}
          header={
            <Typography variant="subtitle2" sx={{ mb: 0.75 }} color="text.secondary">
              Not defeated{' '}
              <Typography component="span" variant="caption" color="text.secondary">
                ({undefeated.length})
              </Typography>
            </Typography>
          }
        />
      )}
    </>
  )
}
