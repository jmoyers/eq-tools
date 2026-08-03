// share.ts — main-side orchestration for settings/alert sharing.
//
// The RULES live in src/shared/profiles.ts (pure, unit-tested) and the WIRE FORMAT lives in
// shareCodec.ts (pure + node:zlib, unit-tested). This file is the thin impure layer that
// reads the electron-store, asks sounds.ts which packs are installed, and writes back.
//
// Renderer prefs (localStorage) can't be read from here, so the renderer passes its
// whitelisted `ui` map in on every call and gets merged values back to write. That keeps
// localStorage semantics entirely in the renderer and the store entirely in main.

import {
  applyAlertMerge,
  buildAlertSetBody,
  buildSettingsBody,
  defaultSelectedScalars,
  makeEnvelope,
  mergeUiPref,
  planAlertMerge,
  planScalarChanges,
  SHARE_ERROR_TEXT,
  UI_PREF_SPECS,
  type AlertSetBody,
  type SettingsBundleBody,
  type ShareApplyResult,
  type SharePreview,
  type ScalarContext
} from '../shared/profiles'
import { decodeShareString, encodeShareString } from './shareCodec'
import {
  getAlertPrefs,
  getAlerts,
  getOverlayConfig,
  saveAlerts,
  setAlertPrefs,
  setOverlayConfig
} from './store'
import { listPacks } from './sounds'
import type { OverlayKind } from '../shared/types'

const KINDS: OverlayKind[] = ['fight', 'overall', 'heal-fight', 'heal-overall', 'events']

/** Which sound packs exist on THIS machine (used to flag imports that reference others). */
function installedPackIds(): string[] {
  try {
    return listPacks().map((p) => p.id)
  } catch {
    // Pack discovery is best-effort; with an empty set the planner simply flags nothing.
    return []
  }
}

function currentOverlays(): ScalarContext['overlays'] {
  const out: ScalarContext['overlays'] = {}
  for (const k of KINDS) {
    const c = getOverlayConfig(k)
    out[k] = { bgAlpha: c.bgAlpha, topN: c.topN }
  }
  return out
}

/** What the export/preview calls carry from the renderer: its whitelisted localStorage map. */
export interface UiPrefMap {
  [key: string]: string
}

/** Encode the GLOBAL settings bundle (whitelisted — see profiles.ts classification). */
export function exportSettingsString(appVersion: string, ui: UiPrefMap): string {
  const body = buildSettingsBody({
    alerts: getAlerts(),
    alertPrefs: getAlertPrefs(),
    overlays: currentOverlays(),
    ui
  })
  return encodeShareString(makeEnvelope('settings', body, appVersion))
}

/** Encode one alert (`ids:[id]`) or every alert (`ids` omitted) as a share string. */
export function exportAlertsString(appVersion: string, ids?: string[]): string {
  const body = buildAlertSetBody(getAlerts(), ids && ids.length ? ids : undefined)
  return encodeShareString(makeEnvelope('alerts', body, appVersion))
}

/** A suggested file name for "save to file" — dated, so a folder of exports self-sorts. */
export function shareFileName(kind: 'settings' | 'alerts', count?: number): string {
  const day = new Date().toISOString().slice(0, 10)
  const what = kind === 'alerts' ? `alerts${count ? `-${count}` : ''}` : 'settings'
  return `eq-companion-${what}-${day}.eqshare`
}

function emptyPreview(text: string, error: string): SharePreview {
  return { ok: false, error, alerts: [], scalars: [], missingPacks: [], text }
}

/**
 * Decode + plan, without changing anything. This is what the import dialog renders: the
 * user sees exactly which alerts will be ADDED (and which are skipped because they already
 * have them), which scalar settings would be replaced (all opt-in, off by default), and
 * which sound packs they're missing — before a single write happens.
 */
export function previewShare(text: string, ui: UiPrefMap): SharePreview {
  const decoded = decodeShareString(text)
  if (!decoded.ok) return emptyPreview(text, SHARE_ERROR_TEXT[decoded.error])
  const env = decoded.envelope

  const body = env.body as Partial<SettingsBundleBody & AlertSetBody>
  const incomingAlerts = Array.isArray(body.alerts) ? body.alerts : []
  const alerts = planAlertMerge(getAlerts(), incomingAlerts, installedPackIds())

  let scalars: SharePreview['scalars'] = []
  if (env.kind === 'settings') {
    scalars = planScalarChanges(body as SettingsBundleBody, {
      alertPrefs: getAlertPrefs(),
      overlays: currentOverlays(),
      ui
    })
  }

  if (env.kind === 'character') {
    // Designed, not built (profiles.ts forward-design section). Say so plainly instead of
    // pretending there is nothing in the string.
    return emptyPreview(
      text,
      'That share string carries a character profile. This version can share settings and alerts only.'
    )
  }

  if (!alerts.length && !scalars.length) return emptyPreview(text, SHARE_ERROR_TEXT['empty-payload'])

  const missingPacks = [
    ...new Set(alerts.filter((a) => a.action !== 'skip' && a.missingPackId).map((a) => a.missingPackId as string))
  ]

  return {
    ok: true,
    kind: env.kind,
    appVersion: env.app,
    createdAt: env.at,
    alerts,
    scalars,
    missingPacks,
    text
  }
}

/** Per-item opt-in from the preview. Omit either list to take that category's defaults. */
export interface ShareSelection {
  /** finalIds of alerts to add (defaults to every non-skip item) */
  alertIds?: string[]
  /** ScalarChange ids to apply (defaults to the additive unions only) */
  scalarIds?: string[]
}

/**
 * Apply a previewed share, ADDITIVELY. Alerts are appended (never overwritten — see
 * planAlertMerge's conflict rules); scalar settings are written only when explicitly
 * selected. Returns the localStorage writes for the renderer to perform.
 */
export function applyShare(text: string, ui: UiPrefMap, selection?: ShareSelection): ShareApplyResult {
  const preview = previewShare(text, ui)
  if (!preview.ok) {
    return { ok: false, error: preview.error, added: 0, skipped: 0, rekeyed: 0, scalarsApplied: 0, ui: {} }
  }

  const selectedAlerts = selection?.alertIds ? new Set(selection.alertIds) : undefined
  const merged = applyAlertMerge(getAlerts(), preview.alerts, selectedAlerts)
  if (merged.added > 0) saveAlerts(merged.alerts)

  const chosen = new Set(selection?.scalarIds ?? defaultSelectedScalars(preview.scalars))
  // previewShare already proved this decodes; re-read the body to source the values.
  const decoded = decodeShareString(text)
  const body = decoded.ok && preview.kind === 'settings' ? (decoded.envelope.body as SettingsBundleBody) : null

  const uiWrites: Record<string, string> = {}
  let scalarsApplied = 0
  if (body) {
    for (const change of preview.scalars) {
      if (!chosen.has(change.id)) continue
      if (change.id === 'alertPrefs.globalVolume' && body.alertPrefs) {
        setAlertPrefs({ ...getAlertPrefs(), globalVolume: body.alertPrefs.globalVolume })
        scalarsApplied++
      } else if (change.id === 'alertPrefs.muted' && body.alertPrefs) {
        setAlertPrefs({ ...getAlertPrefs(), muted: body.alertPrefs.muted })
        scalarsApplied++
      } else if (change.id.startsWith('overlay.')) {
        const [, kind, field] = change.id.split('.')
        const inc = body.overlays?.[kind as OverlayKind]
        if (inc && (field === 'bgAlpha' || field === 'topN')) {
          setOverlayConfig(kind as OverlayKind, { [field]: inc[field] })
          scalarsApplied++
        }
      } else if (change.id.startsWith('ui.')) {
        const key = change.id.slice(3)
        const spec = UI_PREF_SPECS.find((s) => s.key === key)
        const inc = body.ui?.[key]
        if (spec && inc !== undefined) {
          uiWrites[key] = mergeUiPref(spec, ui[key], inc)
          scalarsApplied++
        }
      }
    }
  }

  return {
    ok: true,
    added: merged.added,
    skipped: merged.skipped,
    rekeyed: merged.rekeyed,
    scalarsApplied,
    ui: uiWrites
  }
}
