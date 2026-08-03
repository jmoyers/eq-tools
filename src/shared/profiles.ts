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
// and it is exported through an explicit WHITELIST (shareSchema.ts) — a new setting is
// PRIVATE BY DEFAULT and cannot leak by being added to the store.
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
// WHERE THE CODE LIVES. This file kept growing past the factoring ceiling, so the share
// model is now three modules and `shared/profiles` re-exports all of them — every consumer
// still imports from here, and nothing may import the split files directly:
//   ./shareSchema  the wire format: envelope, canonical JSON + checksum, body shapes, the
//                  export whitelist, and the untrusted-input sanitizers.
//   ./shareMerge   the apply semantics: the additive alert merge and the opt-in scalar diff.
//   this file      game profiles, the whitelisted BUILDERS, and the preview wire shapes.
// The codec (compression) lives in src/main/shareCodec.ts because it needs node:zlib;
// everything in the three shared modules is pure so it runs in the renderer, in main, and
// under node:test.

import type { AlertDef, AlertPrefs, AlertTrigger, OverlayKind } from './types'
import {
  clamp01,
  sanitizeAlertDef,
  EXPORTABLE_OVERLAY_KINDS,
  SHARE_LIMITS,
  UI_PREF_SPECS,
  type AlertSetBody,
  type ExportableOverlayConfig,
  type SettingsBundleBody,
  type ShareKind
} from './shareSchema'
import type { AlertMergeItem, ScalarChange } from './shareMerge'

// The re-export is EXPLICIT (never `export *`): the test suite runs these modules through
// tsx's CJS transform, where a star re-export becomes a runtime property copy that the ESM
// named-import linker cannot see — `import { SHARE_PREFIX } from '../src/shared/profiles'`
// in a .mts test would fail to link. Naming each export also keeps this list a readable
// index of the share surface.
export {
  SHARE_PREFIX,
  SHARE_SCHEMA_VERSION,
  OVERLAY_EXPORT_FIELDS,
  EXPORTABLE_OVERLAY_KINDS,
  UI_PREF_SPECS,
  SHARE_LIMITS,
  SHARE_ERROR_TEXT,
  canonicalJson,
  checksum,
  makeEnvelope,
  clampStr,
  clamp01,
  sanitizeAlertDef,
  validateEnvelope
} from './shareSchema'
export type {
  ShareKind,
  ShareEnvelope,
  AlertSetBody,
  ExportableOverlayConfig,
  SettingsBundleBody,
  UiPrefMerge,
  UiPrefSpec,
  ShareDecodeError,
  ShareValidation
} from './shareSchema'

export {
  alertBehaviorKey,
  planAlertMerge,
  applyAlertMerge,
  planScalarChanges,
  mergeUiPref,
  defaultSelectedScalars
} from './shareMerge'
export type { AlertMergeAction, AlertMergeItem, ScalarChange, ScalarContext } from './shareMerge'

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

/** The overlay PREFERENCES (never the geometry), projected out of the stored configs. */
function exportableOverlays(
  stored: SettingsExportInput['overlays']
): Partial<Record<OverlayKind, ExportableOverlayConfig>> {
  const overlays: Partial<Record<OverlayKind, ExportableOverlayConfig>> = {}
  for (const kind of EXPORTABLE_OVERLAY_KINDS) {
    const cfg = stored?.[kind]
    if (!cfg) continue
    overlays[kind] = {
      bgAlpha: clamp01(cfg.bgAlpha, 0.72),
      topN: cfg.topN === 10 ? 10 : 5
    }
  }
  return overlays
}

/** The whitelisted renderer prefs, bounded — anything not in UI_PREF_SPECS never leaves. */
function exportableUiPrefs(ui: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const spec of UI_PREF_SPECS) {
    const v = ui?.[spec.key]
    if (typeof v === 'string' && v.length) out[spec.key] = v.slice(0, SHARE_LIMITS.maxUiValueChars)
  }
  return out
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
    muted: input.alertPrefs?.muted ?? false
  }
  const overlays = exportableOverlays(input.overlays)
  if (Object.keys(overlays).length) body.overlays = overlays
  const ui = exportableUiPrefs(input.ui)
  if (Object.keys(ui).length) body.ui = ui
  return body
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
