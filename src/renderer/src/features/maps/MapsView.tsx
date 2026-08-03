// The Maps tab (docs/plans/map-viewer.md §10, §11 wave 3) — the view that owns the positioned
// host box, resolves WHICH zone to show, and wires the search's jump-to.
//
// AUTO-OPEN, AND THE ONE THING IT MUST NEVER DO. The log states the zone you are in and nothing
// else positional, so the feature's whole "it just knows" is one fold: `CharacterSnap.zone` (the
// raw long name, off the `You have entered X.` line) → `zoneShortName()` → the map-file stem.
// That table is HAND-AUTHORED because there is no algorithm — measured, naive normalization
// resolves 7 of the 51 zone names the real log has printed ("The Plane of Sky" → `airplane`).
// When it returns null the viewer opens the PICKER and says so. It never guesses a stem: a
// confidently wrong map is worse than an honest question (world-model law 1). The EQL Tutorial
// is the known unmapped zone and is exactly what that state exists for.
//
// WHAT THIS VIEW CANNOT DO, STATED ON SCREEN: there is no "you are here" marker, and there
// cannot be — `Your Location` appears ZERO times in 86.6 MB of log. A user hunting for a dot
// that does not exist is a worse outcome than one quiet line saying so (§10).
//
// COMPOSITION is the recipe from `useMapViewport.ts`'s header, verbatim: this view owns the
// relative-positioned host, hands the viewport to the canvas and the label layer, and puts the
// search's flash marker at `labelPosition(vp, point)` — the SAME arithmetic the labels use, so
// the marker and its label can never disagree.

import { useCallback, useEffect, useState, useRef, type JSX, type RefObject } from 'react'
import { Box, Chip, Paper, Stack, Typography } from '@mui/material'
import MapIcon from '@mui/icons-material/Map'
import type { CharacterDelta, CharacterSnap } from '@shared/types'
import type { MapBounds, MapData, MapPackPrefs, MapSearchHit, ZoneShort } from '@shared/maps'
import { zoneShortName } from '@shared/zones'
import { useModule } from '../../lib/useModule'
import { MapCanvas } from './MapCanvas'
import { MapPointsLayer, labelPosition } from './MapPointsLayer'
import { DEFAULT_LAYERS, type LayerMask } from './mapGeometry'
import { useMapViewport, type MapViewport } from './useMapViewport'
import MapSearch from './MapSearch'
import MapToolbar, { ZonePicker, zoneLabel } from './MapToolbar'
import { loadLastZone, loadPackPrefs, savePackPrefs, saveLastZone, useMapData, useMapPacks } from './useMapData'

/** How long the jump-to marker stays on screen. Long enough to find, short enough to forget. */
const MARKER_MS = 2600
/** Scale bump when jumping from a fitted view — a fitted zone puts a POI at a couple of pixels. */
const JUMP_ZOOM = 6

/** A stand-in extent for the frames where no map is loaded. Never drawn; keeps the hook honest. */
const EMPTY_BOUNDS: MapBounds = { minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: 0, maxZ: 0 }

/** Layer → what that file conventionally holds (§2.3). Used for the per-layer source chips. */
const LAYER_NAME: Record<number, string> = { 0: 'Geometry', 1: 'Labels', 2: 'Legend', 3: 'Extra' }

/** The character module's delta is a partial merge (see main/modules/character.ts). */
function applyCharacterDelta(state: CharacterSnap, delta: CharacterDelta): CharacterSnap {
  return { ...state, ...delta }
}

/**
 * What to call the map on screen.
 *
 * The log's OWN spelling wins when it resolved to this map — displayed raw, tier suffix and all
 * (law 2: canonicalize at boundaries, display raw). A manually picked zone falls back to the
 * table's long name, and a stem the table does not carry is shown as the stem.
 */
function headerTitle(zone: ZoneShort | null, raw: string | undefined): string {
  if (zone == null) return 'Maps'
  if (raw != null && zoneShortName(raw) === zone) return raw
  return zoneLabel(zone)
}

/** The transient "here it is" pip a search hit leaves behind. */
interface Marker {
  x: number
  y: number
  at: number
}

/**
 * WHICH ZONE IS OPEN.
 *
 * The log wins whenever it says something new: zoning re-points the viewer, overriding a manual
 * pick, because "show me where I am" is the feature. A manual pick holds until the next zone
 * line, and the last zone is remembered across launches.
 *
 * AN UNMAPPED ZONE CLEARS THE MAP RATHER THAN LEAVING THE OLD ONE UP. Leaving the previous zone
 * drawn while you stand somewhere else is the same lie as guessing a stem — the user reads the
 * pane, not the header. So a stated-but-unresolvable zone (the EQL Tutorial is the known case)
 * shows the picker and says which name it could not place (law 1).
 */
function useZoneSelection(raw: string | undefined): {
  zone: ZoneShort | null
  auto: ZoneShort | null
  pick: (zone: ZoneShort) => void
} {
  const auto = zoneShortName(raw)
  const [zone, setZone] = useState<ZoneShort | null>(loadLastZone)
  useEffect(() => {
    // Nothing stated yet (a fresh log, or the replay hasn't reached a zone line): keep whatever
    // was remembered, which is the last place this install actually was.
    if (raw == null || raw === '') return
    setZone(auto)
    if (auto != null) saveLastZone(auto)
  }, [raw, auto])
  const pick = useCallback((next: ZoneShort) => {
    setZone(next)
    saveLastZone(next)
  }, [])
  return { zone, auto, pick }
}

/** The head: what zone this is, where each layer came from, and the one honest "cannot". */
function MapsHeader({
  title,
  zone,
  data
}: {
  title: string
  zone: ZoneShort | null
  data: MapData | null
}): JSX.Element {
  return (
    <Stack spacing={0.5} data-testid="maps-header" sx={{ flexShrink: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <MapIcon sx={{ fontSize: 18, color: 'text.disabled' }} />
        <Typography variant="h6" sx={{ mr: 0.5 }}>
          {title}
        </Typography>
        {zone != null && <Chip size="small" variant="outlined" label={zone} />}
        {/* Which pack each layer actually came from. Geometry and labels routinely come from
            DIFFERENT packs (§6.3), and silently merging two while naming one would be exactly
            the unlabelled inference the world-model laws forbid. */}
        {data?.sources.map((s) => (
          <Chip
            key={`${String(s.layer)}#${s.packId}`}
            size="small"
            data-testid="maps-source"
            label={`${LAYER_NAME[s.layer] ?? String(s.layer)}: ${s.packId}`}
          />
        ))}
        {data != null && data.points.length > 0 && (
          <Chip size="small" variant="outlined" label={`${String(data.points.length)} labels`} />
        )}
        {data != null && data.skipped > 0 && (
          <Chip size="small" color="warning" variant="outlined" label={`${String(data.skipped)} unparsed lines`} />
        )}
      </Stack>
      <Typography variant="caption" color="text.disabled">
        No “you are here” marker: the log states the zone you entered and nothing else positional.
      </Typography>
    </Stack>
  )
}

/** Everything that is NOT a drawn map: no packs, no mapping for this zone, or nothing picked. */
function MapsEmpty({
  raw,
  auto,
  zones,
  zone,
  error,
  onPick
}: {
  raw: string | undefined
  auto: ZoneShort | null
  zones: ZoneShort[]
  zone: ZoneShort | null
  error: string | null
  onPick: (zone: ZoneShort) => void
}): JSX.Element {
  const unmapped = raw != null && raw !== '' && auto == null
  return (
    <Paper
      variant="outlined"
      data-testid="maps-empty"
      sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto', p: 2 }}
    >
      <Stack spacing={1.5} alignItems="flex-start">
        <Typography variant="body2" color="text.secondary">
          {zones.length === 0
            ? 'No map files were found in your EverQuest folder. The game ships them under maps\\ — set your install folder in Preferences if this looks wrong.'
            : unmapped
              ? `We don’t have a map name for “${raw}” yet — pick one.`
              : 'Pick a zone to open its map.'}
        </Typography>
        {zone != null && error != null && (
          <Typography variant="body2" color="text.secondary" data-testid="maps-error">
            {error}
          </Typography>
        )}
        {zones.length > 0 && <ZonePicker zones={zones} zone={zone} onPick={onPick} autoFocus />}
      </Stack>
    </Paper>
  )
}

/**
 * THE JUMP-TO-A-HIT half of search, including the cross-zone case.
 *
 * A hit in the zone on screen is one `centerOn`. A hit in ANOTHER zone cannot be: the map has to
 * be fetched and the pane re-measured first, so the hit is PARKED and the jump fires from an
 * effect once `data.zone` matches and the host has a real size. Jumping into a zero-size pane
 * would clamp against a fit scale of 1 and land nowhere near the point.
 */
function useSearchJump(args: {
  vp: MapViewport
  /** The zone actually ON SCREEN (`data.zone`), never the one being fetched. */
  zone: ZoneShort | undefined
  pick: (zone: ZoneShort) => void
}): { marker: Marker | null; onJump: (hit: MapSearchHit) => void } {
  const { vp, zone, pick } = args
  const { centerOn, zoomedIn, view, size } = vp
  const [marker, setMarker] = useState<Marker | null>(null)
  const [pending, setPending] = useState<MapSearchHit | null>(null)

  const jump = useCallback(
    (x: number, y: number) => {
      // Fitted ⇒ a POI is a couple of pixels wide, so the jump also zooms in; already zoomed ⇒
      // keep the scale the user chose and only re-centre.
      centerOn(x, y, zoomedIn ? undefined : view.scale * JUMP_ZOOM)
      setMarker({ x, y, at: Date.now() })
    },
    [centerOn, zoomedIn, view.scale]
  )

  const onJump = useCallback(
    (hit: MapSearchHit) => {
      if (hit.zone === zone) jump(hit.point.x, hit.point.y)
      else {
        pick(hit.zone)
        setPending(hit)
      }
    },
    [zone, jump, pick]
  )

  useEffect(() => {
    if (pending == null || zone !== pending.zone || size.w <= 0) return
    jump(pending.point.x, pending.point.y)
    setPending(null)
  }, [pending, zone, size.w, jump])

  // Transient by design: a marker that never fades becomes a second, permanent map symbol.
  useEffect(() => {
    if (marker == null) return
    const t = setTimeout(() => {
      setMarker(null)
    }, MARKER_MS)
    return () => {
      clearTimeout(t)
    }
  }, [marker])

  return { marker, onJump }
}

/**
 * The drawn map: the positioned host the viewport measures, the canvas, the label layer, and the
 * search marker — positioned through `labelPosition`, the SAME arithmetic the labels use.
 */
function MapSurface({
  data,
  vp,
  hostRef,
  layers,
  marker
}: {
  data: MapData
  vp: MapViewport
  hostRef: RefObject<HTMLDivElement | null>
  layers: LayerMask
  marker: Marker | null
}): JSX.Element {
  const at = marker == null ? null : labelPosition(vp, marker)
  return (
    <Box
      ref={hostRef}
      data-testid="maps-surface"
      onPointerDown={vp.onPointerDown}
      onPointerMove={vp.onPointerMove}
      onPointerUp={vp.onPointerUp}
      sx={{
        position: 'relative',
        flexGrow: 1,
        minHeight: 0,
        overflow: 'hidden',
        borderRadius: 1,
        bgcolor: 'background.paper',
        touchAction: 'none',
        cursor: vp.dragging ? 'grabbing' : 'grab'
      }}
    >
      <MapCanvas lines={data.lines} vp={vp} layers={layers} />
      <MapPointsLayer points={data.points} vp={vp} layers={layers} />
      {at != null && (
        <Box
          data-testid="maps-marker"
          sx={{
            position: 'absolute',
            left: at.px,
            top: at.py,
            width: 22,
            height: 22,
            transform: 'translate(-50%, -50%)',
            borderRadius: '50%',
            border: '2px solid',
            borderColor: 'warning.main',
            pointerEvents: 'none'
          }}
        />
      )}
    </Box>
  )
}

export default function MapsView(): JSX.Element {
  // WHERE YOU ARE. The character module owns the raw display zone off the `zone` log event; it
  // is undefined until the log prints one, and that absence is a state this view renders.
  const raw = useModule<CharacterSnap, CharacterDelta>('character', applyCharacterDelta)?.zone
  const { zone, auto, pick } = useZoneSelection(raw)
  const [prefs, setPrefs] = useState<MapPackPrefs>(loadPackPrefs)
  const [layers, setLayers] = useState<LayerMask>(DEFAULT_LAYERS)

  const { packs, zones, ready } = useMapPacks()
  const { data, error, loading } = useMapData(zone, prefs)

  const hostRef = useRef<HTMLDivElement>(null)
  const vp = useMapViewport({ bounds: data?.bounds ?? EMPTY_BOUNDS, id: data?.zone ?? '', hostRef })
  const { marker, onJump } = useSearchJump({ vp, zone: data?.zone, pick })

  return (
    <Stack spacing={1.5} sx={{ height: '100%' }}>
      <MapsHeader title={headerTitle(zone, raw)} zone={zone} data={data} />
      {data != null && (
        <MapToolbar
          layers={layers}
          onLayers={setLayers}
          packs={packs}
          prefs={prefs}
          onPrefs={(p) => {
            setPrefs(p)
            savePackPrefs(p)
          }}
          zoomedIn={vp.zoomedIn}
          onZoom={vp.zoomBy}
          onFit={vp.fit}
        />
      )}
      <MapSearch zone={zone} onJump={onJump} />

      {data != null ? (
        <MapSurface data={data} vp={vp} hostRef={hostRef} layers={layers} marker={marker} />
      ) : (
        // Nothing is claimed before the pack listing and the first fetch have answered — a
        // picker that flashes up and vanishes reads as a bug, not as a load.
        ready &&
        !loading && (
          <MapsEmpty raw={raw} auto={auto} zones={zones} zone={zone} error={error} onPick={pick} />
        )
      )}
    </Stack>
  )
}
