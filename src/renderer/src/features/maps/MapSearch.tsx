// The map's SEARCH BOX and its hit list (docs/plans/map-viewer.md §7).
//
// TWO SCOPES, ONE DOOR. `This zone` filters the zone on screen; `All zones` answers the question
// the corpus makes possible — "which zone is Ambassador D`Vinn in?" Both go through the SAME
// `maps:search` channel that wave 2A built, and that is a deliberate departure from §7.2's
// sketch of a renderer-side filter:
//
//   * main already holds the parsed zone in its LRU (the very object this view is rendering) and
//     already ranks it with `scoreQuery(tokenize(q), hay)` from `shared/fuzzy.ts`. A renderer
//     index would be a SECOND matcher over data main is already matching — exactly the "do not
//     write a second matcher" the plan states one paragraph later.
//   * the two scopes then rank identically by construction, so a label that is findable in the
//     corpus is findable in its own zone, with the same ordering. Two implementations could not
//     promise that.
//
// The corpus is 35,720 records and one zone is at most 316, so this is render-bound either way
// (AGENTS.md "Search": no workers, no databases). The input echoes INSTANTLY — it is plain
// controlled state — and only the query that reaches the IPC is deferred.
//
// THE HIT LIST IS A BOUNDED SCROLL BOX. A growing list that sizes to its content is Task #56's
// bug (it squeezed the combat dashboard to 0px), so the list has an explicit cap and owns its
// own scrollbar. The e2e measures exactly that.

import { useDeferredValue, useEffect, useState, type JSX } from 'react'
import {
  Box,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import type { MapSearchHit, ZoneShort } from '@shared/maps'

/** `zone` = the map on screen; `all` = the whole installed corpus. */
export type MapSearchScope = 'zone' | 'all'

/** The cap the fixed-height law imposes on the hit list, in CSS pixels. */
export const HIT_LIST_MAX_H = 240

/** Hits fetched per query. Main clamps this again; a taller list is scrolled, not fetched. */
const LIMIT = 60

export interface MapSearchProps {
  /** The zone on screen. `null` ⇒ the in-zone scope has nothing to search and says so. */
  zone: ZoneShort | null
  /** A hit was clicked: centre the view on it (and change zone first, when it is elsewhere). */
  onJump: (hit: MapSearchHit) => void
}

/** The POI colour carries its category (§2.4) — shown as a swatch, never applied to the text. */
function Swatch({ hit }: { hit: MapSearchHit }): JSX.Element {
  const { r, g, b } = hit.point
  return (
    <Box
      sx={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: `rgb(${String(r)},${String(g)},${String(b)})`
      }}
    />
  )
}

function HitRow({
  hit,
  showZone,
  onJump
}: {
  hit: MapSearchHit
  showZone: boolean
  onJump: (hit: MapSearchHit) => void
}): JSX.Element {
  return (
    <ListItemButton
      dense
      data-testid="maps-hit-row"
      onClick={() => {
        onJump(hit)
      }}
      sx={{ gap: 1 }}
    >
      <Swatch hit={hit} />
      <ListItemText
        primary={hit.point.display}
        secondary={showZone ? hit.zone : null}
        slotProps={{ primary: { variant: 'body2', noWrap: true }, secondary: { variant: 'caption' } }}
      />
    </ListItemButton>
  )
}

export default function MapSearch({ zone, onJump }: MapSearchProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<MapSearchScope>('zone')
  const [hits, setHits] = useState<MapSearchHit[]>([])
  // The box echoes every keystroke; only what reaches the IPC waits for the paint to settle.
  const q = useDeferredValue(query).trim()
  const inZone = scope === 'zone' && zone != null

  useEffect(() => {
    if (q.length === 0 || (scope === 'zone' && zone == null)) {
      setHits([])
      return
    }
    let cancelled = false
    void window.eq
      .searchMapPoints(q, { ...(scope === 'zone' && zone != null ? { zone } : {}), limit: LIMIT })
      .then((res) => {
        if (!cancelled) setHits(res)
      })
      .catch(() => {
        if (!cancelled) setHits([])
      })
    return () => {
      cancelled = true
    }
  }, [q, scope, zone])

  return (
    <Stack spacing={1} sx={{ flexShrink: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <TextField
          size="small"
          placeholder="Search labels…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
          }}
          slotProps={{ htmlInput: { 'data-testid': 'maps-search-input' } }}
          sx={{ flexGrow: 1, maxWidth: 360 }}
        />
        <ToggleButtonGroup
          size="small"
          exclusive
          value={scope}
          data-testid="maps-search-scope"
          onChange={(_e, v: MapSearchScope | null) => {
            if (v) setScope(v)
          }}
        >
          <ToggleButton value="zone">This zone</ToggleButton>
          <ToggleButton value="all">All zones</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {q.length > 0 && (
        <Paper
          variant="outlined"
          data-testid="maps-hits"
          sx={{ maxHeight: HIT_LIST_MAX_H, overflow: 'auto' }}
        >
          {hits.length > 0 ? (
            <List dense disablePadding>
              {hits.map((hit) => (
                <HitRow
                  key={`${hit.zone}#${hit.point.label}#${String(hit.point.x)},${String(hit.point.y)}`}
                  hit={hit}
                  showZone={!inZone}
                  onJump={onJump}
                />
              ))}
            </List>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ p: 1.25 }}>
              {scope === 'zone' && zone == null
                ? 'No zone is open — switch to All zones to search the whole corpus.'
                : 'No labels match.'}
            </Typography>
          )}
        </Paper>
      )}
    </Stack>
  )
}
