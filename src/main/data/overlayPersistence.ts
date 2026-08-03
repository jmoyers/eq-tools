// Observed-message-overlay persistence (Task #36).
//
// The overlay has TWO on-disk sources, merged at startup (both feed the miner additively):
//   1. the COMMITTED BASELINE — messageOverlay.baseline.json, generated from the full log by
//      scripts/gen-message-overlay.ts and imported (so electron-vite INLINES it into the main
//      bundle, exactly like spells.json — a path-relative read would miss it in prod). Ships
//      with the app so a fresh install starts warm.
//   2. the USER OVERLAY — <userData>/message-overlay.json, what THIS user's live log has
//      taught us since install. Written debounced by index.ts, loaded here on startup.
//
// Both are the same versioned MessageOverlay shape. A version mismatch on the user file is
// ignored (we fall back to the baseline only) so a schema bump can't crash startup.

import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MessageOverlay } from '../../shared/types'
import { OVERLAY_VERSION } from './messageOverlay'
// Inlined committed baseline (bundled into the main build, like spells.json).
import baselineJson from './messageOverlay.baseline.json'

/** The committed baseline overlay (typed). */
export function baselineOverlay(): MessageOverlay {
  return baselineJson as unknown as MessageOverlay
}

/** Path of the user's persisted overlay in userData. */
function userOverlayPath(): string {
  return join(app.getPath('userData'), 'message-overlay.json')
}

/** Load the user's persisted overlay, or null when absent / stale-version / unreadable. */
export function loadUserOverlay(): MessageOverlay | null {
  try {
    const txt = readFileSync(userOverlayPath(), 'utf8')
    const ov = JSON.parse(txt) as MessageOverlay
    if (ov?.version !== OVERLAY_VERSION || !Array.isArray(ov.messages)) return null
    return ov
  } catch {
    return null
  }
}

/** Persist the user's overlay to userData (best-effort; a write error is swallowed). */
export function saveUserOverlay(overlay: MessageOverlay): void {
  try {
    writeFileSync(userOverlayPath(), JSON.stringify(overlay), 'utf8')
  } catch {
    // Non-fatal — the overlay is a nicety, not required state.
  }
}
