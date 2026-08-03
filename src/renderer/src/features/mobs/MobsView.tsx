// MobsView (Task #64) — the MODULE HOME for creature knowledge.
//
// WHY A TAB OF ITS OWN. Three surfaces already knew things about mobs and none of them was a
// place you could go: the events overlay's con rows (a glance, over the game), the Raid Targets
// tab's "recently considered" strip (lodging with raid progression because it needed a roof),
// and a modal that opened over whichever list you happened to be in. "What is this thing and
// what does it drop" is a question you ask deliberately, about any of 7,866 mobs — most of
// which you have never conned and none of which are raid targets. That is a tab.
//
// THE HIERARCHY, as shipped:
//   Mobs (this view)                    the creature knowledge home
//     ├── search                        the whole committed catalog, fuzzy, offline
//     ├── In <zone>                     what lives WHERE YOU ARE  ← the default surface
//     ├── Recently considered           what you've been sizing up  ← moved off Raid Targets
//     └── MobPage                       THE detail surface, app-wide
//   Raid Targets                        raid progression only — a roster + your kills; its
//                                       cards now route HERE instead of opening their own modal.
//
// THE BROWSE SURFACE IS AN OVERVIEW OF WHERE YOU ARE. It used to open on "Recently considered"
// + "Most considered" — two views of the same con ring, one of which ("what you keep coming back
// to") answered a question nobody was asking while a "Most considered" chip cloud pushed
// everything else down the page. What you actually want when you open this tab mid-session is
// the bestiary of the room you are standing in, and then what you were just sizing up. So the
// zone roster leads, in a fixed-height scroll box (AGENTS.md — a growing list never grows the
// page), the con strip sits below it with its own bounded height, and "Most considered" is gone.
//
// TWO STATES, one view: the BROWSE surface (search box + zone roster + con strip) and the DRILL
// page, with a breadcrumb back — the same shape the combat tab uses for a fight drill-down,
// rather than a second modal.
//
// SEARCH is client-side and instant (AGENTS.md "Search"): the input echoes immediately, the
// filter runs on a deferred value, and the catalog is an ES-imported JSON already bundled for
// main's mob lookup. No IPC, no network, works offline.

import { type JSX, useDeferredValue, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import PetsIcon from '@mui/icons-material/Pets'
import type {
  CharacterDelta,
  CharacterSnap,
  ConsiderDelta,
  ConsiderSnap,
  KillMap,
  KillsDelta,
  MobEntry
} from '@shared/types'
import { useModule } from '../../lib/useModule'
import { MobPage } from './MobPage'
import { RecentlyConsidered, applyConsiderDelta } from './RecentlyConsidered'
import { MOB_CATALOG, searchMobs } from './mobSearch'
import { mobsInZone } from './mobZone'
import type { MobTarget } from './mobTarget'

function applyKillsDelta(state: KillMap, delta: KillsDelta): KillMap {
  return { ...state, ...delta.changed }
}

/** The character module's delta is a partial merge (see main/modules/character.ts). */
function applyCharacterDelta(state: CharacterSnap, delta: CharacterDelta): CharacterSnap {
  return { ...state, ...delta }
}

/** ONE search result. The catalog row IS the row — level, zones and drop count, all local. */
function MobResultRow({
  entry,
  kills,
  onOpen
}: {
  entry: MobEntry
  kills: KillMap
  onOpen: (t: MobTarget) => void
}): JSX.Element {
  const drops = entry.drops?.length ?? 0
  const kill = kills[entry.name.trim().toLowerCase()]
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="baseline"
      role="button"
      tabIndex={0}
      onClick={() => onOpen({ mob: entry.name, entry, kill })}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen({ mob: entry.name, entry, kill })
      }}
      sx={{
        py: 0.4,
        px: 0.75,
        borderRadius: 1,
        cursor: 'pointer',
        minWidth: 0,
        '&:hover': { bgcolor: 'action.hover' }
      }}
    >
      <Typography variant="body2" sx={{ fontWeight: 600, flexShrink: 0 }}>
        {entry.name}
      </Typography>
      {entry.level && (
        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
          Lvl {entry.level}
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
        {entry.zones?.join(', ')}
      </Typography>
      <Box sx={{ flexGrow: 1 }} />
      {kill && kill.count > 0 && (
        <Typography variant="caption" sx={{ color: 'success.main', flexShrink: 0 }}>
          {kill.count} killed
        </Typography>
      )}
      {/* Drop COUNT, not the drops: the page lists them out. Absent when the page had no loot
          section at all — an honest 0 is a different claim and this row can't make it. */}
      {drops > 0 && (
        <Chip
          size="small"
          variant="outlined"
          label={`${drops} drop${drops === 1 ? '' : 's'}`}
          sx={{ height: 18, fontSize: 10, flexShrink: 0, '& .MuiChip-label': { px: 0.6 } }}
        />
      )}
    </Stack>
  )
}

/**
 * IN <ZONE> — the roster of the place you are standing in, lowest level first.
 *
 * The zone name is displayed RAW, exactly as the game printed it ("The Ruins of Old Paineel -
 * Solo 4 (Refined)"), because that is what your client's zone line says and matching it is how
 * you know the app is talking about where you are. The folding that turns it into catalog rows
 * is mobZone's business, not the heading's.
 *
 * SIZE IS A CONTRACT, AND IT IS CONDITIONAL. With rows, this is the panel that must survive, so
 * it takes `flexGrow:1` + `minHeight:0` and owns its own `overflow:auto` (AGENTS.md — "a growing
 * list lives in a FIXED-height scroll box"). Kael Drakkel is 343 rows; the page itself still
 * never scrolls.
 *
 * With ZERO rows there is nothing to grow: a `flexGrow:1` panel containing one sentence ate the
 * whole viewport and pushed "Recently considered" to the bottom edge, so an empty answer was the
 * loudest thing on the tab. Empty ⇒ `flexShrink:0` and auto height (header + the quiet line), and
 * the freed space goes to the strip below (see the browse branch).
 */
function ZoneRoster({
  zone,
  rows,
  kills,
  onOpen
}: {
  zone: string
  rows: MobEntry[]
  kills: KillMap
  onOpen: (t: MobTarget) => void
}): JSX.Element {
  const empty = rows.length === 0
  return (
    <Paper
      variant="outlined"
      data-testid="mobs-zone-roster"
      sx={
        empty
          ? { p: 1, flexShrink: 0 }
          : { p: 1, flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }
      }
    >
      <Typography variant="subtitle2" sx={{ color: 'primary.main', flexShrink: 0 }}>
        In {zone}{' '}
        {rows.length > 0 && (
          <Typography component="span" variant="caption" color="text.secondary">
            — {rows.length} in the catalog
          </Typography>
        )}
      </Typography>
      {rows.length > 0 ? (
        <Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }}>
          {rows.map((e) => (
            <MobResultRow key={e.page} entry={e} kills={kills} onOpen={onOpen} />
          ))}
        </Box>
      ) : (
        // The catalog and the game don't always spell a place the same way (mobZone documents
        // which ones). Say so plainly rather than showing an empty box or a guessed roster.
        <Typography
          data-testid="mobs-zone-empty"
          variant="body2"
          color="text.disabled"
          sx={{ p: 1 }}
        >
          The catalog lists no mobs for {zone}.
        </Typography>
      )}
    </Paper>
  )
}

/**
 * NO ZONE YET — the log hasn't printed a zone line this session, so there is nothing to be an
 * overview OF. Rather than head a section with a blank, the roster is skipped entirely and this
 * says what the tab will fill itself with once you play.
 */
function NoZoneYet({ hasConsidered }: { hasConsidered: boolean }): JSX.Element {
  return (
    <Box
      sx={{
        flexGrow: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        color: 'text.secondary',
        textAlign: 'center'
      }}
    >
      {!hasConsidered && <PetsIcon sx={{ fontSize: 44, opacity: 0.5 }} />}
      <Typography variant="body2" sx={{ maxWidth: 460 }}>
        {hasConsidered
          ? 'Zone into somewhere and this becomes an overview of what lives there. Until then, search the catalog by name or zone.'
          : `Your zone, cons and kills show up here as you play — a roster of whatever you're standing in. Meanwhile, search ${MOB_CATALOG.length.toLocaleString()} creatures by name or zone: levels, zones and full drop tables, all offline.`}
      </Typography>
      <Typography variant="caption" color="text.disabled">
        Anything you <code>/con</code> in game shows up here too.
      </Typography>
    </Box>
  )
}

/**
 * @param target             a mob to open on arrival (a deep link from the events overlay, or a
 *                           raid target card). Re-applied whenever `targetNonce` changes, so
 *                           asking for the SAME mob twice opens it twice instead of looking
 *                           broken.
 * @param onTargetConsumed   told the moment the target has been opened, so the router drops it.
 *                           Load-bearing: this view unmounts when you switch tabs, and a target
 *                           still parked in the router would silently re-open a page you'd
 *                           already backed out of the next time you came here.
 */
export default function MobsView({
  target,
  targetNonce,
  onTargetConsumed
}: {
  target?: MobTarget | null
  targetNonce?: number
  onTargetConsumed?: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  const [drill, setDrill] = useState<MobTarget | null>(target ?? null)

  const kills = useModule<KillMap, KillsDelta>('kills', applyKillsDelta) ?? {}
  const considered = useModule<ConsiderSnap, ConsiderDelta>('consider', applyConsiderDelta) ?? []
  // WHERE YOU ARE. The character module carries the RAW display zone off the `zone` log event;
  // it is undefined until the log prints one (a fresh log, or before the replay reaches a zone
  // line), and that absence is a state this view renders — never a blank heading.
  const zone = useModule<CharacterSnap, CharacterDelta>('character', applyCharacterDelta)?.zone

  // An inbound target (deep link / raid card) opens the page, then is consumed. Keyed on the
  // NONCE, not the target's identity: the same mob asked for twice must open twice.
  useEffect(() => {
    if (!target) return
    setDrill(target)
    onTargetConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetNonce])

  const hits = useMemo(() => searchMobs(deferred), [deferred])
  const searching = deferred.trim().length > 0
  // A filter over 7,866 rows — cheap (render-bound, AGENTS.md "Search"), but it only changes
  // when you zone, so memoize on the zone string.
  const zoneRows = useMemo(() => (zone ? mobsInZone(zone, MOB_CATALOG) : []), [zone])

  if (drill) {
    return (
      <Stack spacing={1} sx={{ height: '100%' }}>
        <Box>
          <Button size="small" startIcon={<ArrowBackIcon />} onClick={() => setDrill(null)}>
            Mobs
          </Button>
        </Box>
        <Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }}>
          <MobPage key={`${drill.mob}#${drill.entry?.page ?? ''}`} target={drill} />
        </Box>
      </Stack>
    )
  }

  return (
    <Stack spacing={1.5} sx={{ height: '100%' }}>
      <TextField
        size="small"
        placeholder="Search mobs…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        sx={{ maxWidth: 420 }}
      />

      {searching ? (
        <Paper variant="outlined" sx={{ p: 1, flexGrow: 1, minHeight: 0, overflow: 'auto' }}>
          {hits.length > 0 ? (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ px: 0.75 }}>
                {hits.length} of {MOB_CATALOG.length} mobs
              </Typography>
              {hits.map((h) => (
                <MobResultRow key={h.entry.page} entry={h.entry} kills={kills} onOpen={setDrill} />
              ))}
            </>
          ) : (
            <Typography variant="body2" color="text.disabled" sx={{ p: 1 }}>
              No mob in the catalog matches “{deferred.trim()}”.
            </Typography>
          )}
        </Paper>
      ) : (
        // BROWSE = where you are, then what you were just sizing up. The roster leads and takes
        // the leftover height; the con strip keeps its own bounded height below it. With no zone
        // known there is nothing to lead WITH, so the strip (which renders nothing when empty)
        // moves to the top and the invitation takes the space the roster would have had.
        //
        // EMPTY ROSTER is the third case: the roster goes compact (see ZoneRoster) and the
        // leftover height is handed DOWNWARD instead, so the con strip sits directly under the
        // one-line answer rather than being pinned to the bottom of an otherwise blank panel.
        // The strip keeps its own fixed-height scroll box either way — that is its law, not a
        // reaction to this state; the wrapper only decides where the slack lives.
        <>
          {zone ? (
            <>
              <ZoneRoster zone={zone} rows={zoneRows} kills={kills} onOpen={setDrill} />
              {zoneRows.length === 0 ? (
                <Box sx={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <RecentlyConsidered rows={considered} kills={kills} onOpen={setDrill} />
                </Box>
              ) : (
                <RecentlyConsidered rows={considered} kills={kills} onOpen={setDrill} />
              )}
            </>
          ) : (
            <>
              <RecentlyConsidered rows={considered} kills={kills} onOpen={setDrill} />
              <NoZoneYet hasConsidered={considered.length > 0} />
            </>
          )}
        </>
      )}
    </Stack>
  )
}
