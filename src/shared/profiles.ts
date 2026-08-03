// profiles.ts — TWO distinct "profile" concepts live here. Read this header first.
//
//  1. GameProfile      — a SERVER / RULESET (EverQuest Legends, Project 1999). Chooses
//                        which quest data is bundled and which log ruleset parses lines.
//                        Load-bearing today (log/parser.ts, log/rulesets.ts, data/index.ts).
//  2. Share profiles   — the USER-FACING settings/sharing model (Task: profiles): export
//                        your settings, import someone else's, share individual alerts as a
//                        paste-safe string. Everything below the divider.
//
// They are unrelated; the file keeps both only because `profiles` is the natural name for
// each. Nothing here may import Node built-ins — the renderer bundles this module.

/**
 * A "game profile" identifies a server / ruleset. Different EverQuest versions
 * and emulators have wildly different quest rules, item stats, and even log
 * formats, so the app is built around swappable profiles:
 *   - quest data is scraped per profile and bundled under data/<id>/
 *   - log parsing uses a per-profile ruleset (see main/log/rulesets.ts)
 * Adding a new server later (e.g. Project 1999) means adding a profile here, a
 * scraper source (scripts/sources/<id>.ts), and a log ruleset.
 */
export interface GameProfile {
  id: string
  label: string
  description: string
  /** whether quest data has been scraped & bundled for this profile */
  available: boolean
}

export const PROFILES: GameProfile[] = [
  {
    id: 'eqlegends',
    label: 'EverQuest Legends',
    description: 'Daybreak EverQuest Legends server — quest data from eqlwiki.com',
    available: true
  },
  {
    id: 'p99',
    label: 'Project 1999',
    description: 'Classic EQ emulator (wiki.project1999.com) — not yet imported',
    available: false
  }
]

export const DEFAULT_PROFILE = 'eqlegends'

export function getProfile(id: string): GameProfile | undefined {
  return PROFILES.find((p) => p.id === id)
}

// ===========================================================================================
// ============================== SHARE PROFILES (settings sharing) ==========================
// ===========================================================================================
//
// GOALS (user's words, restated as invariants)
//   * export your settings; import settings from other users
//   * settings are GLOBAL — not linked to a character
//   * alerts are INDIVIDUALLY copyable, and "all my alerts" is one string too
//   * imports are ADDITIVE — an import NEVER deletes or replaces what you already have
//   * the envelope must survive into a future where a character's progress (level/AA,
//     inventory, raid kills, Sky quests) rides the same pipe, and a web backend serves it
//
// ------------------------------------------------------------------ classification
//
// Every piece of persisted state is exactly one of four classes. Only GLOBAL is exportable,
// and it is exported through an explicit WHITELIST (below) — a new setting is PRIVATE BY
// DEFAULT and cannot leak by being added to the store.
//
//   GLOBAL     portable between users, carries no machine paths and no character identity.
//              alerts[] · alertPrefs · overlays.<kind>.{bgAlpha,topN} · the whitelisted
//              renderer UI prefs (combat scope, boss density, posky class filter + count
//              source, item favorites, game profile).
//
//   CHARACTER  tied to one character (and to its epoch — AGENTS.md "character epochs").
//              byCharacter[<name_server>] (inventory counts, completedQuests). NOT in the
//              settings bundle: a settings import must never touch another player's
//              progress, and "which character" is meaningless on the receiving machine.
//              This is the slot the FUTURE character-profile envelope fills (design below).
//
//   MACHINE    paths, window geometry, install/update bookkeeping — meaningless or actively
//              harmful on another machine. eqInstallDir · activeLogPath · windowBounds ·
//              inventorySource.path · updateChannel · alertSoundMigration ·
//              overlays.<kind>.{open,locked,bounds,drill} · localStorage 'eq.view'
//              (last open tab) · <userData>/soundpacks/ (binary assets; referenced by id
//              and re-installed from the registry instead) · errors.log.
//              EXCLUDED BY CONSTRUCTION — see the whitelist note above. A path can never
//              appear in an export because no exporter ever reads one.
//
//   DERIVED    rebuildable from the log or the network; exporting it would ship stale data
//              and (for the mined overlay) another user's play history.
//              <userData>/message-overlay.json (learned spell-message verdicts) ·
//              item-knowledge-cache.json · registry-cache.json · every module snapshot
//              (loot/kills/leveling/combat) — those come from replaying the log.
//
// ------------------------------------------------------------------ the envelope
//
// One envelope for every shareable thing, so the alert-sharing feature and the future
// character/backend features are the same code path:
//
//   EQC1-<base64url(deflateRaw(utf8(canonicalJson(envelope))))>
//
//   envelope = { v, kind, app, at, sum, body }
//     v    schema version (SHARE_SCHEMA_VERSION). A decoder REFUSES v > its own and
//          explains why ("made by a newer version"); older v are migrated forward.
//     kind discriminates the body ('alerts' | 'settings' | future 'character').
//     app  the app version that produced it — provenance for bug reports, never trusted.
//     at   ISO creation timestamp.
//     sum  checksum of canonicalJson(body) (NOT of the envelope, so re-wrapping the same
//          body — e.g. a backend re-serving it — keeps the same sum).
//     body the payload.
//
// Why this shape:
//   - compress+base64url ⇒ ONE line, no `+/=` to mangle in Discord/chat/URLs; ~5-8x on
//     JSON, so "all my alerts" stays comfortably under Discord's 2000-char message limit.
//   - the `EQC1-` prefix is the human tell ("this is an EQ Companion share string") AND
//     the version tripwire: a future incompatible format becomes `EQC2-` and old clients
//     reject it by prefix before spending a byte on inflate.
//   - checksum-before-apply ⇒ a truncated paste is REPORTED, never half-applied.
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

function clampStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function clamp01(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback
}

function sanitizeSound(v: unknown): AlertSoundRef | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const packId = clampStr(r.packId, SHARE_LIMITS.maxNameChars)
  const soundId = clampStr(r.soundId, SHARE_LIMITS.maxNameChars)
  return packId && soundId ? { packId, soundId } : null
}

function sanitizePrimitive(v: unknown): AlertTrigger | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (r.type === 'event') {
    const kind = clampStr(r.kind, 64)
    if (!kind) return null
    let where: Record<string, string> | undefined
    if (r.where && typeof r.where === 'object') {
      const src = r.where as Record<string, unknown>
      const out: Record<string, string> = {}
      for (const k of Object.keys(src).slice(0, SHARE_LIMITS.maxWhereFields)) {
        out[clampStr(k, 64)] = clampStr(src[k], SHARE_LIMITS.maxRegexChars)
      }
      if (Object.keys(out).length) where = out
    }
    return { type: 'event', kind: kind as never, ...(where ? { where } : {}) }
  }
  if (r.type === 'raw') {
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

/**
 * Validate a decoded envelope object: shape, version, kind, checksum. Pure — the codec
 * hands us the parsed JSON, we decide whether it may be shown to the user.
 */
export function validateEnvelope(raw: unknown): ShareValidation {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'corrupt' }
  const r = raw as Record<string, unknown>
  if (typeof r.v !== 'number' || typeof r.kind !== 'string' || typeof r.sum !== 'string') {
    return { ok: false, error: 'corrupt' }
  }
  if (r.v > SHARE_SCHEMA_VERSION) return { ok: false, error: 'newer-version' }
  if (r.kind !== 'alerts' && r.kind !== 'settings' && r.kind !== 'character') {
    return { ok: false, error: 'unknown-kind' }
  }
  if (r.body === undefined || r.body === null) return { ok: false, error: 'corrupt' }
  if (checksum(canonicalJson(r.body)) !== r.sum) return { ok: false, error: 'checksum' }
  return {
    ok: true,
    envelope: {
      v: r.v,
      kind: r.kind as ShareKind,
      app: clampStr(r.app, 40),
      at: clampStr(r.at, 40),
      sum: r.sum,
      body: r.body
    }
  }
}

// ------------------------------------------------------------------ builders (whitelisted)

/** Everything the main process may contribute to a settings bundle. */
export interface SettingsExportInput {
  alerts: AlertDef[]
  alertPrefs: AlertPrefs
  /** full stored configs; only OVERLAY_EXPORT_FIELDS are read out of them */
  overlays: Partial<Record<OverlayKind, { bgAlpha: number; topN: number } & Record<string, unknown>>>
  /** raw localStorage values the renderer collected; filtered against UI_PREF_SPECS here */
  ui?: Record<string, string>
}

/** Build an alert-set body — one alert (`ids:[id]`) or all of them (`ids` omitted). */
export function buildAlertSetBody(alerts: AlertDef[], ids?: readonly string[]): AlertSetBody {
  const wanted = ids ? new Set(ids) : null
  const picked = alerts.filter((a) => !wanted || wanted.has(a.id)).slice(0, SHARE_LIMITS.maxAlerts)
  // Re-sanitize on the way OUT too: the store is ours, but this guarantees the wire shape
  // matches the schema exactly, with no stray keys a future store field might add.
  return { alerts: picked.map(sanitizeAlertDef).filter((a): a is AlertDef => a !== null) }
}

/**
 * Build the GLOBAL settings body. This is the whitelist in executable form: it PROJECTS
 * named fields out of the inputs, so a machine path or window bound cannot appear in an
 * export even if some future code puts one in the store.
 */
export function buildSettingsBody(input: SettingsExportInput): SettingsBundleBody {
  const body: SettingsBundleBody = {}
  const alerts = buildAlertSetBody(input.alerts).alerts
  if (alerts.length) body.alerts = alerts
  body.alertPrefs = {
    globalVolume: clamp01(input.alertPrefs?.globalVolume, 0.7),
    muted: !!input.alertPrefs?.muted
  }
  const overlays: Partial<Record<OverlayKind, ExportableOverlayConfig>> = {}
  for (const kind of EXPORTABLE_OVERLAY_KINDS) {
    const cfg = input.overlays?.[kind]
    if (!cfg) continue
    overlays[kind] = {
      bgAlpha: clamp01(cfg.bgAlpha, 0.72),
      topN: cfg.topN === 10 ? 10 : 5
    }
  }
  if (Object.keys(overlays).length) body.overlays = overlays
  const ui: Record<string, string> = {}
  for (const spec of UI_PREF_SPECS) {
    const v = input.ui?.[spec.key]
    if (typeof v === 'string' && v.length) ui[spec.key] = v.slice(0, SHARE_LIMITS.maxUiValueChars)
  }
  if (Object.keys(ui).length) body.ui = ui
  return body
}

// ------------------------------------------------------------------ additive merge

/**
 * The BEHAVIOR fingerprint of an alert: what it listens for and what it plays. Name, note
 * and enabled state are deliberately EXCLUDED — two alerts that fire on the same thing with
 * the same sound ARE the same alert however they're labelled, so:
 *   - re-importing the same string twice is a no-op (idempotent),
 *   - a friend's set that overlaps yours doesn't spam duplicate sounds,
 *   - renaming your copy doesn't make the next import duplicate it.
 */
export function alertBehaviorKey(def: AlertDef): string {
  return checksum(
    canonicalJson({
      trigger: def.trigger,
      sound: def.sound,
      volume: def.volume ?? 1,
      cooldownMs: def.cooldownMs ?? 2000
    })
  )
}

export type AlertMergeAction = 'add' | 'rekey' | 'skip'

/** One planned import. The UI renders these as the preview; apply consumes the same list. */
export interface AlertMergeItem {
  /** the sanitized incoming def, EXCEPT id/name which become finalId/finalName */
  incoming: AlertDef
  action: AlertMergeAction
  /** id it will be stored under (differs from incoming.id only when action === 'rekey') */
  finalId: string
  /** name it will be stored under (suffixed only on a same-name/different-behavior clash) */
  finalName: string
  /** why — shown in the preview so the user can see nothing is being overwritten */
  reason: string
  /** set when the alert's sound pack is not installed here; the alert still imports */
  missingPackId?: string
  behaviorKey: string
}

/**
 * CONFLICT RULES (additive by law — nothing existing is ever modified or deleted):
 *
 *   same behavior already present   → SKIP. You already have this alert; a second copy
 *                                     would just double the sound. Makes import idempotent.
 *   same id, different behavior     → REKEY to `<id>~<behaviorKey4>` and keep BOTH. Ids
 *                                     like 'charm-break' are seeded identically for every
 *                                     user, so an id collision means "different objects,
 *                                     colliding namespace", never "same object". The suffix
 *                                     is derived from the behavior (not a random or a
 *                                     counter) so importing the SAME string twice lands on
 *                                     the same id and the second pass skips.
 *   otherwise                       → ADD under its own id, preserving it across the hop so
 *                                     round-tripping a set is stable.
 *
 * Name clashes never affect identity; a colliding name just gets " (imported)" appended so
 * the list stays readable.
 *
 * MISSING SOUND PACK: if the sound's packId isn't installed, the alert is STILL imported —
 * flagged, with the pack name surfaced so the user can install it from the registry
 * browser. We never silently re-point it at a default (that would fabricate the sender's
 * intent) and never silently drop it (that would mute it invisibly).
 */
export function planAlertMerge(
  existing: readonly AlertDef[],
  incoming: readonly AlertDef[],
  installedPackIds: Iterable<string>
): AlertMergeItem[] {
  const installed = new Set(installedPackIds)
  const byBehavior = new Map<string, AlertDef>()
  const byId = new Map<string, AlertDef>()
  const names = new Set<string>()
  for (const a of existing) {
    byBehavior.set(alertBehaviorKey(a), a)
    byId.set(a.id, a)
    names.add(a.name.toLowerCase())
  }

  const out: AlertMergeItem[] = []
  for (const raw of incoming.slice(0, SHARE_LIMITS.maxAlerts)) {
    const def = sanitizeAlertDef(raw)
    if (!def) continue
    const behaviorKey = alertBehaviorKey(def)
    const missingPackId = installed.size && !installed.has(def.sound.packId) ? def.sound.packId : undefined

    const twin = byBehavior.get(behaviorKey)
    if (twin) {
      out.push({
        incoming: def,
        action: 'skip',
        finalId: twin.id,
        finalName: twin.name,
        reason: `Already have this — “${twin.name}”`,
        missingPackId,
        behaviorKey
      })
      continue
    }

    let finalId = def.id
    let action: AlertMergeAction = 'add'
    let reason = 'New alert'
    if (byId.has(finalId)) {
      finalId = `${def.id}~${behaviorKey.slice(0, 4)}`
      action = 'rekey'
      reason = `Id “${def.id}” is taken by a different alert — imported alongside it`
    }

    let finalName = def.name
    if (names.has(finalName.toLowerCase())) finalName = `${def.name} (imported)`

    // Reserve so two incoming alerts in the SAME payload can't collide with each other.
    byBehavior.set(behaviorKey, { ...def, id: finalId, name: finalName })
    byId.set(finalId, { ...def, id: finalId, name: finalName })
    names.add(finalName.toLowerCase())

    out.push({ incoming: def, action, finalId, finalName, reason, missingPackId, behaviorKey })
  }
  return out
}

/**
 * Apply a plan. `selected` (by finalId) makes import per-item opt-in; omit it to take
 * everything. Skips are never applied. The existing list is returned UNTOUCHED at its head —
 * additions are appended, so ordering (and therefore the user's mental model) is preserved.
 */
export function applyAlertMerge(
  existing: readonly AlertDef[],
  plan: readonly AlertMergeItem[],
  selected?: ReadonlySet<string>
): { alerts: AlertDef[]; added: number; skipped: number; rekeyed: number } {
  const next = [...existing]
  let added = 0
  let rekeyed = 0
  let skipped = 0
  for (const item of plan) {
    if (item.action === 'skip') {
      skipped++
      continue
    }
    if (selected && !selected.has(item.finalId)) {
      skipped++
      continue
    }
    next.push({ ...item.incoming, id: item.finalId, name: item.finalName })
    added++
    if (item.action === 'rekey') rekeyed++
  }
  return { alerts: next, added, skipped, rekeyed }
}

// ------------------------------------------------------------------ scalar (opt-in) changes

/**
 * A setting that CANNOT be merged additively — a volume, a mute flag, a density. Importing
 * one necessarily replaces yours, so each is surfaced individually in the preview with your
 * current value beside the incoming one, and is OFF by default. The user opts in per row.
 */
export interface ScalarChange {
  /** stable address, e.g. 'alertPrefs.globalVolume' | 'overlay.fight.topN' | 'ui.eq.favorites' */
  id: string
  label: string
  current: string
  incoming: string
  /** 'union' rows are additive (lists) and default to ON; 'replace' rows default to OFF */
  merge: UiPrefMerge
}

/** Current values the preview compares against (main + renderer both contribute). */
export interface ScalarContext {
  alertPrefs: AlertPrefs
  overlays: Partial<Record<OverlayKind, { bgAlpha: number; topN: number }>>
  ui: Record<string, string>
}

const OVERLAY_KIND_LABEL: Record<OverlayKind, string> = {
  fight: 'Fight meter',
  overall: 'Overall meter',
  'heal-fight': 'Healing (fight)',
  'heal-overall': 'Healing (overall)',
  events: 'Event feed'
}

/** Diff a settings body against the current state; only genuinely different rows come back. */
export function planScalarChanges(body: SettingsBundleBody, ctx: ScalarContext): ScalarChange[] {
  const out: ScalarChange[] = []
  const push = (id: string, label: string, cur: unknown, inc: unknown, merge: UiPrefMerge): void => {
    const c = String(cur ?? '')
    const i = String(inc ?? '')
    if (c !== i) out.push({ id, label, current: c, incoming: i, merge })
  }
  if (body.alertPrefs) {
    push('alertPrefs.globalVolume', 'Global alert volume', ctx.alertPrefs.globalVolume, body.alertPrefs.globalVolume, 'replace')
    push('alertPrefs.muted', 'Mute all alerts', ctx.alertPrefs.muted, body.alertPrefs.muted, 'replace')
  }
  for (const kind of EXPORTABLE_OVERLAY_KINDS) {
    const inc = body.overlays?.[kind]
    if (!inc) continue
    const cur = ctx.overlays?.[kind]
    push(`overlay.${kind}.bgAlpha`, `${OVERLAY_KIND_LABEL[kind]} — background opacity`, cur?.bgAlpha, inc.bgAlpha, 'replace')
    push(`overlay.${kind}.topN`, `${OVERLAY_KIND_LABEL[kind]} — rows shown`, cur?.topN, inc.topN, 'replace')
  }
  for (const spec of UI_PREF_SPECS) {
    const inc = body.ui?.[spec.key]
    if (inc === undefined) continue
    if (spec.merge === 'union') {
      const merged = mergeUiPref(spec, ctx.ui?.[spec.key], inc)
      // A union that adds nothing is not a change worth showing.
      push(`ui.${spec.key}`, spec.label, ctx.ui?.[spec.key] ?? '', merged, 'union')
    } else {
      push(`ui.${spec.key}`, spec.label, ctx.ui?.[spec.key] ?? '', inc, 'replace')
    }
  }
  return out
}

/**
 * Combine one UI pref value. 'union' parses both sides as JSON string arrays and unions
 * them (order-stable: yours first, then theirs) — nothing you had is dropped. Anything that
 * doesn't parse as an array falls back to 'replace' semantics rather than guessing.
 */
export function mergeUiPref(spec: UiPrefSpec, current: string | undefined, incoming: string): string {
  if (spec.merge !== 'union') return incoming
  const parse = (s: string | undefined): string[] | null => {
    if (!s) return []
    try {
      const v: unknown = JSON.parse(s)
      return Array.isArray(v) ? v.map((x) => String(x)) : null
    } catch {
      return null
    }
  }
  const mine = parse(current)
  const theirs = parse(incoming)
  if (mine === null || theirs === null) return incoming
  const seen = new Set(mine)
  const merged = [...mine]
  for (const t of theirs) {
    if (!seen.has(t)) {
      seen.add(t)
      merged.push(t)
    }
  }
  return JSON.stringify(merged)
}

/** The rows that are ON by default in the preview: additive unions, never scalar replaces. */
export function defaultSelectedScalars(changes: readonly ScalarChange[]): string[] {
  return changes.filter((c) => c.merge === 'union').map((c) => c.id)
}

// ------------------------------------------------------------------ preview (wire shape)

/** What the import dialog renders. Produced in main, consumed by the renderer. */
export interface SharePreview {
  ok: boolean
  /** SHARE_ERROR_TEXT[...] when !ok — already user-facing prose, never a raw exception */
  error?: string
  kind?: ShareKind
  /** app version that produced the string, for the "made with vX" line */
  appVersion?: string
  createdAt?: string
  alerts: AlertMergeItem[]
  scalars: ScalarChange[]
  /** distinct sound packs referenced by imported alerts that aren't installed here */
  missingPacks: string[]
  /** the original string, echoed back so apply doesn't have to be re-pasted */
  text: string
}

/** Result of applying a preview. `ui` is handed back for the RENDERER to write. */
export interface ShareApplyResult {
  ok: boolean
  error?: string
  added: number
  skipped: number
  rekeyed: number
  scalarsApplied: number
  /** localStorage writes the renderer must perform (already merged + whitelisted) */
  ui: Record<string, string>
}

/** One-line human summary of a trigger, for the preview list. */
export function describeTrigger(t: AlertTrigger): string {
  const one = (p: AlertTrigger): string => {
    if ('conditions' in p) return ''
    if (p.type === 'event') {
      const where = p.where && Object.keys(p.where).length
        ? ` {${Object.entries(p.where).map(([k, v]) => `${k}=${v}`).join(', ')}}`
        : ''
      return `event:${p.kind}${where}`
    }
    if (p.type === 'raw') return `raw:/${p.regex}/i`
    return `app:${p.signal}`
  }
  if ('conditions' in t) return `${t.type}(${t.conditions.map(one).join(', ')})`
  return one(t)
}

// ===========================================================================================
// ================ FORWARD DESIGN — character profiles + backend (NOT BUILT) ================
// ===========================================================================================
//
// Nothing below is produced or consumed today. It is written down so the envelope above is
// provably sufficient and so the next agent doesn't invent a second, incompatible format.
//
// SHAPE. A character profile is just `kind:'character'` in the SAME envelope, so the
// checksum, the version gate, the `EQC1-` prefix, the paste-safe codec, the file
// export/import and the "preview before apply" flow are all reused unchanged:
//
//   export interface CharacterProfileBody {
//     character: { name: string; server: string; classes?: string[]; level?: number }
//     /** the epoch this snapshot describes — see AGENTS.md "character epochs". A profile
//      *  from a PREVIOUS epoch must never be merged into the current one, so the boundary
//      *  travels with the data instead of being re-derived on the receiving machine. */
//     epoch: { id: string; startedAt: string }
//     aa?: { earned: number; spent: number; unspent: number; abilities: { name: string; rank: number }[] }
//     inventory?: { name: string; count: number }[]
//     raid?: { bossKey: string; killedAt: string; count: number }[]
//     quests?: { key: string; completedAt?: string }[]
//     /** WORLD-MODEL LAW 1 (messages over inference): anything not read verbatim out of the
//      *  log is labelled, so a viewer can tell observed progress from estimated progress. */
//     provenance?: Record<string, 'observed' | 'inferred'>
//   }
//
// MERGE. Character bodies are SNAPSHOTS, not settings — you don't "additively import"
// someone else's AA total into yours. They are therefore READ-ONLY on import: they open a
// viewer ("Vebarn@freeport — 12 raid targets, 4/12 Sky quests"), and the only additive
// action offered is per-row ("mark these Sky quests complete on MY character"), which routes
// through the existing per-character progress writes. The additive law holds because the
// import never writes a character record wholesale.
//
// BACKEND (later; explicitly not now). The natural split: the app POSTs the SAME envelope
// JSON (uncompressed — compression is a transport concern of the paste format only), the
// service stores it under an opaque share id and serves `GET /p/<id>` → envelope. The client
// validates `v`/`sum` exactly as it does for a pasted string, so a hostile or buggy service
// can't inject anything a paste couldn't. `EQC1-` strings and share URLs stay
// interchangeable; a URL is just a pointer to a body.
//
// PRIVACY (a design constraint, not a footnote). A settings bundle is anonymous by
// construction — the whitelist above admits no name, no server, no path. A CHARACTER profile
// is the opposite: name + server IS an identity on a live server, and inventory/kill history
// is a movement log. So the character envelope must be (a) opt-in per share, (b) explicit
// about what it includes with a per-section preview BEFORE the string/URL exists, (c)
// capable of a pseudonymous mode (drop `character.name`, keep class/level/progress), and
// (d) revocable once a backend exists (deleting the share id must actually stop serving it).
// None of that is required for the settings/alert sharing shipped today, which is exactly
// why the two kinds are separate `kind`s rather than one growing blob.
