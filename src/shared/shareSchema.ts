// shareSchema.ts — the SHARE WIRE FORMAT: the envelope, the canonical-JSON/checksum pair the
// envelope is built on, the bundle body shapes, the export WHITELIST, and the sanitizers that
// turn an untrusted pasted payload into something the app may look at.
//
// Split out of src/shared/profiles.ts (which had grown past the 400-code-line factoring
// ceiling) with the text unchanged. `shared/profiles` re-exports every name here, so it is
// still the one import site for consumers and no import path changed. Read profiles.ts's
// header first — it carries the classification (GLOBAL / CHARACTER / MACHINE / DERIVED) and
// the argument for this format.
//
// The codec (compression) lives in src/main/shareCodec.ts because it needs node:zlib;
// everything here is pure so it runs in the renderer, in main, and under node:test.

import type { AlertDef, AlertPrefs, AlertSoundRef, AlertTrigger, OverlayKind } from './types'

/** Human-readable prefix + format generation. Bump the digit only for a BREAKING format. */
export const SHARE_PREFIX = 'EQC1-'

/** Envelope schema version. Additive body changes bump this; decoders migrate forward. */
export const SHARE_SCHEMA_VERSION = 1

/** What a share string carries. 'character' is DESIGNED but not produced/consumed yet. */
export type ShareKind = 'alerts' | 'settings' | 'character'

/** The versioned wrapper every share string carries. */
export interface ShareEnvelope<K extends ShareKind = ShareKind, B = unknown> {
  /** schema version — SHARE_SCHEMA_VERSION at write time */
  v: number
  kind: K
  /** producing app version (provenance only — never a trust signal) */
  app: string
  /** ISO-8601 creation time */
  at: string
  /** checksum() of canonicalJson(body) */
  sum: string
  body: B
}

/** Body of a `kind:'alerts'` envelope — one alert or many, same shape. */
export interface AlertSetBody {
  alerts: AlertDef[]
}

/** The overlay fields that are actually PREFERENCES (the rest is window geometry). */
export interface ExportableOverlayConfig {
  bgAlpha: number
  topN: number
}

/** Body of a `kind:'settings'` envelope. Every field is optional so a bundle can be partial. */
export interface SettingsBundleBody {
  alerts?: AlertDef[]
  alertPrefs?: AlertPrefs
  overlays?: Partial<Record<OverlayKind, ExportableOverlayConfig>>
  /** whitelisted renderer prefs, raw localStorage values keyed by UI_PREF_SPECS[].key */
  ui?: Record<string, string>
}

// ------------------------------------------------------------------ the whitelist

/**
 * The ONLY overlay fields that leave this machine. `open`/`locked`/`bounds`/`drill` are
 * MACHINE state: bounds are monitor coordinates and drill holds live entity ids.
 */
export const OVERLAY_EXPORT_FIELDS = ['bgAlpha', 'topN'] as const

/** Overlay kinds a bundle may carry (mirrors OverlayKind; explicit so a new kind is a choice). */
export const EXPORTABLE_OVERLAY_KINDS: OverlayKind[] = [
  'fight',
  'overall',
  'heal-fight',
  'heal-overall',
  'events'
]

/**
 * How an imported UI pref combines with what you already have.
 *  - 'replace'    a scalar (a mode, a density). Cannot be additive, so it is OPT-IN on
 *                 import and defaults to OFF.
 *  - 'union'      a JSON array of strings (favorites, selected classes). Additive by
 *                 nature: the union is taken, nothing you had is ever dropped.
 */
export type UiPrefMerge = 'replace' | 'union'

export interface UiPrefSpec {
  /** the localStorage key — the renderer owns reading/writing it */
  key: string
  label: string
  merge: UiPrefMerge
}

/**
 * Renderer localStorage keys that ride in a settings bundle. WHITELIST: anything not
 * listed here (notably `eq.view`, the last-open tab) never leaves the machine.
 */
export const UI_PREF_SPECS: readonly UiPrefSpec[] = [
  { key: 'eq.combat.scope', label: 'Combat scope (Fight / Overall)', merge: 'replace' },
  { key: 'eq.bossDensity', label: 'Raid target list density', merge: 'replace' },
  { key: 'eq.countSource', label: 'Item count source', merge: 'replace' },
  { key: 'eq.profile', label: 'Game profile (server ruleset)', merge: 'replace' },
  { key: 'eq.selectedClasses', label: 'Plane of Sky class filter', merge: 'union' },
  { key: 'eq.favorites', label: 'Favorited items', merge: 'union' }
] as const

/** Max sizes — a pasted string is UNTRUSTED input, so every list and string is bounded. */
export const SHARE_LIMITS = {
  /** longest share string we will even try to decode (~64KB of base64url) */
  maxStringChars: 64 * 1024,
  /** longest inflated JSON we will parse */
  maxJsonChars: 512 * 1024,
  maxAlerts: 500,
  maxConditions: 32,
  maxNameChars: 120,
  maxNoteChars: 500,
  maxRegexChars: 500,
  maxWhereFields: 12,
  maxUiValueChars: 20 * 1024
} as const

// ------------------------------------------------------------------ canonical JSON + checksum

/**
 * Deterministic JSON: object keys sorted, no whitespace, `undefined` dropped. Two machines
 * that hold the same logical value produce byte-identical text, which is what makes the
 * checksum (and the alert behavior fingerprint) stable across export/import.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  const rec = value as Record<string, unknown>
  const parts: string[] = []
  for (const k of Object.keys(rec).sort()) {
    if (rec[k] === undefined) continue
    parts.push(`${JSON.stringify(k)}:${canonicalJson(rec[k])}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * FNV-1a 32-bit over UTF-8, as 8 lowercase hex chars. Not a security primitive — it is a
 * TRANSPORT check (truncated paste, mangled newline, chat client eating a character) and a
 * content fingerprint. Deliberately dependency-free so it runs identically in main, the
 * renderer, and node:test.
 */
export function checksum(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // Fold UTF-16 code units byte-wise so the digest is over bytes, not units.
    h ^= c & 0xff
    h = Math.imul(h, 0x01000193)
    if (c > 0xff) {
      h ^= (c >>> 8) & 0xff
      h = Math.imul(h, 0x01000193)
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Wrap a body in a checksummed envelope. `now` is injectable so tests are deterministic. */
export function makeEnvelope<K extends ShareKind, B>(
  kind: K,
  body: B,
  appVersion: string,
  now: Date = new Date()
): ShareEnvelope<K, B> {
  return {
    v: SHARE_SCHEMA_VERSION,
    kind,
    app: appVersion || 'unknown',
    at: now.toISOString(),
    sum: checksum(canonicalJson(body)),
    body
  }
}

// ------------------------------------------------------------------ validation / sanitizing

export type ShareDecodeError =
  | 'empty'
  | 'not-a-share-string'
  | 'too-long'
  | 'corrupt'
  | 'checksum'
  | 'newer-version'
  | 'unknown-kind'
  | 'empty-payload'

/** User-facing text for each failure. The UI reports these — it never throws at the user. */
export const SHARE_ERROR_TEXT: Record<ShareDecodeError, string> = {
  empty: 'Nothing to import — paste a share string first.',
  'not-a-share-string': `That doesn't look like a share string. It should start with "${SHARE_PREFIX}".`,
  'too-long': 'That share string is too large to be genuine.',
  corrupt: 'That share string is damaged — it may have been cut off when it was copied.',
  checksum: 'That share string failed its integrity check — copy it again, in full.',
  'newer-version': 'That share string was made by a newer version of the app. Update, then import.',
  'unknown-kind': "That share string carries something this version doesn't understand.",
  'empty-payload': 'That share string is valid but contains nothing to import.'
}

export type ShareValidation<T = unknown> =
  | { ok: true; envelope: ShareEnvelope<ShareKind, T> }
  | { ok: false; error: ShareDecodeError }

/** Untrusted → a bounded string ('' for anything that isn't one). */
export function clampStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

/** Untrusted → a finite 0..1 number, or the caller's fallback. */
export function clamp01(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback
}

function sanitizeSound(v: unknown): AlertSoundRef | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const packId = clampStr(r.packId, SHARE_LIMITS.maxNameChars)
  const soundId = clampStr(r.soundId, SHARE_LIMITS.maxNameChars)
  return packId && soundId ? { packId, soundId } : null
}

/**
 * An event trigger's optional field matchers. Bounded in COUNT and in each value's length;
 * `undefined` when nothing survived, so the caller can omit the key entirely.
 */
function sanitizeWhere(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const src = v as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const k of Object.keys(src).slice(0, SHARE_LIMITS.maxWhereFields)) {
    out[clampStr(k, 64)] = clampStr(src[k], SHARE_LIMITS.maxRegexChars)
  }
  return Object.keys(out).length ? out : undefined
}

function sanitizeEventTrigger(r: Record<string, unknown>): AlertTrigger | null {
  const kind = clampStr(r.kind, 64)
  if (!kind) return null
  const where = sanitizeWhere(r.where)
  return { type: 'event', kind: kind as never, ...(where ? { where } : {}) }
}

function sanitizeRawTrigger(r: Record<string, unknown>): AlertTrigger | null {
  const regex = clampStr(r.regex, SHARE_LIMITS.maxRegexChars)
  if (!regex) return null
  // A hostile/broken pattern must not blow up the evaluator later.
  try {
    // eslint-disable-next-line no-new
    new RegExp(regex, 'i')
  } catch {
    return null
  }
  return { type: 'raw', regex }
}

function sanitizePrimitive(v: unknown): AlertTrigger | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (r.type === 'event') return sanitizeEventTrigger(r)
  if (r.type === 'raw') return sanitizeRawTrigger(r)
  if (r.type === 'app') {
    const signal = clampStr(r.signal, 64)
    return signal ? { type: 'app', signal: signal as never } : null
  }
  return null
}

function sanitizeTrigger(v: unknown): AlertTrigger | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if ((r.type === 'any' || r.type === 'all') && Array.isArray(r.conditions)) {
    const conditions = r.conditions
      .slice(0, SHARE_LIMITS.maxConditions)
      .map(sanitizePrimitive)
      .filter((c): c is AlertTrigger => c !== null && 'type' in c && !('conditions' in c))
    if (!conditions.length) return null
    return { type: r.type, conditions: conditions as never }
  }
  return sanitizePrimitive(v)
}

/**
 * Normalize ONE alert from an untrusted payload, or null if it can't be made sense of.
 * Unknown keys are dropped by construction (we rebuild the object field by field), so a
 * sender can't smuggle extra state into your store.
 */
export function sanitizeAlertDef(v: unknown): AlertDef | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const id = clampStr(r.id, SHARE_LIMITS.maxNameChars).trim()
  const name = clampStr(r.name, SHARE_LIMITS.maxNameChars).trim()
  const trigger = sanitizeTrigger(r.trigger)
  const sound = sanitizeSound(r.sound)
  if (!id || !name || !trigger || !sound) return null
  const def: AlertDef = {
    id,
    name,
    enabled: r.enabled !== false,
    trigger,
    sound
  }
  if (r.volume !== undefined) def.volume = clamp01(r.volume, 1)
  if (typeof r.cooldownMs === 'number' && Number.isFinite(r.cooldownMs)) {
    def.cooldownMs = Math.max(0, Math.min(600000, Math.round(r.cooldownMs)))
  }
  const note = clampStr(r.note, SHARE_LIMITS.maxNoteChars).trim()
  if (note) def.note = note
  return def
}

/** The three header fields that must be present and well-typed before anything else is read. */
function hasEnvelopeHeader(
  r: Record<string, unknown>
): r is Record<string, unknown> & { v: number; kind: string; sum: string } {
  return typeof r.v === 'number' && typeof r.kind === 'string' && typeof r.sum === 'string'
}

/**
 * Validate a decoded envelope object: shape, version, kind, checksum. Pure — the codec
 * hands us the parsed JSON, we decide whether it may be shown to the user.
 */
export function validateEnvelope(raw: unknown): ShareValidation {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'corrupt' }
  const r = raw as Record<string, unknown>
  if (!hasEnvelopeHeader(r)) return { ok: false, error: 'corrupt' }
  if (r.v > SHARE_SCHEMA_VERSION) return { ok: false, error: 'newer-version' }
  if (r.kind !== 'alerts' && r.kind !== 'settings' && r.kind !== 'character') {
    return { ok: false, error: 'unknown-kind' }
  }
  if (r.body == null) return { ok: false, error: 'corrupt' }
  if (checksum(canonicalJson(r.body)) !== r.sum) return { ok: false, error: 'checksum' }
  return {
    ok: true,
    envelope: {
      v: r.v,
      kind: r.kind,
      app: clampStr(r.app, 40),
      at: clampStr(r.at, 40),
      sum: r.sum,
      body: r.body
    }
  }
}
