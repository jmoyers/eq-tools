// The renderer's DOOR to the map IPC, plus the two prefs the viewer remembers between launches
// (docs/plans/map-viewer.md §4.3, §11 wave 3).
//
// Nothing here parses anything. Main owns `fs`, owns `effectiveEqRoot()` and owns the parse LRU
// (src/main/maps/packs.ts), so a zone arrives as one already-columnar `MapData` — this module's
// whole job is to ask for the right one, to ignore the answer to a question that has since been
// superseded, and to keep the asking honest while it is in flight.
//
// TWO RULES IT EXISTS TO ENFORCE:
//
//   * ONE IN-FLIGHT ANSWER WINS, AND IT IS THE LATEST QUESTION'S. Zoning twice quickly (or
//     clicking two search hits) fires two `maps:get` calls, and IPC gives no ordering guarantee
//     across invokes. Each effect run captures a `cancelled` flag, so a superseded reply is
//     dropped rather than painted over the newer map. There is no renderer-side cache to
//     invalidate: re-asking is an LRU hit in main.
//   * A FAILURE IS DATA. `maps:get` answers `{ok:false, error}` for the ordinary "this machine
//     has no map file for that zone" case, and the view renders that as a quiet state. Nothing
//     in this module throws, and the `.catch` exists only for a torn-down bridge.
//
// PREFS ARE MACHINE-LOCAL, IN `localStorage`, AND DELIBERATELY NOT IN `UI_PREF_SPECS`: which map
// packs are installed and which zone you were last standing in are facts about THIS install, so
// sharing them through a settings bundle would hand another machine a pack id it does not have
// (map-viewer.md §11 wave 3). The keys sit under the `eq.maps.` prefix like every other
// renderer-local view pref (`eq.view`, `eq.combat.scope`).

import { useEffect, useState } from 'react'
import type { MapData, MapPackInfo, MapPackPrefs, ZoneShort } from '@shared/maps'

/** Per-layer pack preference — `{geometry?, labels?}`, JSON. Absent/corrupt ⇒ `{}` (auto). */
export const PACK_PREFS_KEY = 'eq.maps.packs'
/** The zone stem the viewer was last showing, so a relaunch opens where you left off. */
export const LAST_ZONE_KEY = 'eq.maps.zone'

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read the persisted pack preference.
 *
 * Everything unrecognised folds to `{}` — the auto resolution order (§6.3), which always yields
 * a map when one exists. A pref naming a pack the user has since deleted is likewise harmless:
 * `resolveLayer` falls through to the next pack rather than failing.
 */
export function loadPackPrefs(): MapPackPrefs {
  const raw = localStorage.getItem(PACK_PREFS_KEY)
  if (raw == null || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const { geometry, labels } = parsed as Record<string, unknown>
    const g = nonEmpty(geometry)
    const l = nonEmpty(labels)
    return { ...(g == null ? {} : { geometry: g }), ...(l == null ? {} : { labels: l }) }
  } catch {
    return {}
  }
}

export function savePackPrefs(prefs: MapPackPrefs): void {
  localStorage.setItem(PACK_PREFS_KEY, JSON.stringify(prefs))
}

export function loadLastZone(): ZoneShort | null {
  const raw = localStorage.getItem(LAST_ZONE_KEY)
  return raw == null || raw === '' ? null : raw
}

export function saveLastZone(zone: ZoneShort): void {
  localStorage.setItem(LAST_ZONE_KEY, zone)
}

/** What the viewer knows about the installed packs. `ready` distinguishes "none" from "not yet". */
export interface MapPacksState {
  packs: MapPackInfo[]
  /** Every zone stem any pack provides, ascending — the manual picker's corpus. */
  zones: ZoneShort[]
  /** Prose from main when there is nothing to list (no EQ install, no `maps\` dir). */
  error: string | null
  /** The listing has answered. Before it does, the view says nothing rather than "no maps". */
  ready: boolean
}

const NO_PACKS: MapPacksState = { packs: [], zones: [], error: null, ready: false }

/**
 * List the packs and the zone corpus ONCE per mount.
 *
 * Both are main-side scans behind a memoized library keyed on the EQ root, so a remount is
 * cheap; there is no push channel for pack changes in v1 (nothing installs packs yet — §9.2),
 * and re-entering the tab re-lists.
 */
export function useMapPacks(): MapPacksState {
  const [state, setState] = useState<MapPacksState>(NO_PACKS)
  useEffect(() => {
    let cancelled = false
    void Promise.all([window.eq.listMapPacks(), window.eq.listMapZones()])
      .then(([list, zones]) => {
        if (cancelled) return
        setState({ packs: list.packs, zones, error: list.error ?? null, ready: true })
      })
      .catch(() => {
        if (!cancelled) setState({ ...NO_PACKS, ready: true })
      })
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

/** One zone's load: the parsed map, the honest failure, or the in-flight state. */
export interface MapLoad {
  data: MapData | null
  /** `maps:get`'s prose — "no map files for zone 'x'" is the ordinary case, not a crash. */
  error: string | null
  loading: boolean
}

/**
 * Fetch one zone under a per-layer pack preference.
 *
 * The effect depends on the two pref FIELDS rather than on the `prefs` object, so a caller that
 * rebuilds the object each render (every caller does) doesn't re-fetch a map it already has.
 */
export function useMapData(zone: ZoneShort | null, prefs: MapPackPrefs): MapLoad {
  const [load, setLoad] = useState<MapLoad>({ data: null, error: null, loading: zone != null })
  const { geometry, labels } = prefs
  useEffect(() => {
    if (zone == null) {
      setLoad({ data: null, error: null, loading: false })
      return
    }
    let cancelled = false
    setLoad((prev) => ({ ...prev, loading: true }))
    void window.eq
      .getMapData(zone, {
        ...(geometry == null ? {} : { geometry }),
        ...(labels == null ? {} : { labels })
      })
      .then((res) => {
        if (cancelled) return
        setLoad(
          res.ok
            ? { data: res.data, error: null, loading: false }
            : { data: null, error: res.error, loading: false }
        )
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoad({ data: null, error: String(err), loading: false })
      })
    return () => {
      cancelled = true
    }
  }, [zone, geometry, labels])
  return load
}
