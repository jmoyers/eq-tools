// soundCache — fetch a pack sound's bytes once (over IPC), build a CSP-safe Blob
// URL, and cache it keyed by packId/soundId. The app's CSP forbids file:// and
// remote audio, but a Blob URL made from bytes we already have is allowed. Blob
// URLs live for the app's lifetime (we intentionally never revoke — the set of
// sounds is tiny and re-fetching on every play would add latency to alerts).

const cache = new Map<string, Promise<string | null>>()

function key(packId: string, soundId: string): string {
  return `${packId}/${soundId}`
}

/**
 * Drop all cached sound Blob URLs (revoking them). Call after a pack is
 * installed/uninstalled so the next play re-fetches fresh bytes over IPC — a
 * reinstalled pack may have changed, and a stale cache would keep old audio.
 */
export function invalidateSoundCaches(): void {
  for (const p of cache.values()) {
    void p.then((url) => {
      if (url) URL.revokeObjectURL(url)
    })
  }
  cache.clear()
}

/** Resolve a Blob URL for a pack sound (cached). Null if the sound can't be loaded. */
export function getSoundUrl(packId: string, soundId: string): Promise<string | null> {
  const k = key(packId, soundId)
  const hit = cache.get(k)
  if (hit) return hit
  const p = window.eq
    .getSoundData(packId, soundId)
    .then((data) => {
      if (!data) return null
      const bytes = Uint8Array.from(atob(data.dataBase64), (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: data.mime })
      return URL.createObjectURL(blob)
    })
    .catch(() => null)
  cache.set(k, p)
  return p
}

/** Longest an alert's sound may hold a queued utterance hostage before it speaks anyway. */
const MAX_QUEUED_SOUND_MS = 10_000

/**
 * Play a pack sound at `volume` (0..1). Overlapping plays are allowed — each call
 * uses its own <audio> element so a rapid burst doesn't cut off the previous
 * sound. Resolves when playback starts (or immediately on failure).
 *
 * `onEnded` is the SEAM the `audio:'both'` alerts use (voice alerts, decision D5): the sound
 * plays and the speech is queued behind it, so the two never talk over each other. It is
 * called EXACTLY ONCE and it is called on every path — playback finished, playback errored,
 * autoplay refused, the sound could not be loaded at all — because the caller is a
 * continuation, not a success handler: a missing wav must not swallow the spoken half of the
 * alert. A hard cap backstops a media element that never fires `ended` (a zero-byte or
 * unseekable file), so a queued utterance can't be lost to a stuck decoder.
 */
export async function playSound(
  packId: string,
  soundId: string,
  volume: number,
  onEnded?: () => void
): Promise<void> {
  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    onEnded?.()
  }
  const url = await getSoundUrl(packId, soundId)
  if (!url) {
    finish()
    return
  }
  const audio = new Audio(url)
  audio.volume = Math.max(0, Math.min(1, volume))
  if (onEnded) {
    audio.addEventListener('ended', finish)
    audio.addEventListener('error', finish)
    setTimeout(finish, MAX_QUEUED_SOUND_MS)
  }
  try {
    await audio.play()
  } catch {
    // Autoplay/user-gesture policies can reject the first play; nothing to do.
    finish()
  }
}

// ----- registry PREVIEW playback (Task #31) -----
//
// Preview an UN-installed registry pack's audio: bytes are fetched over the
// `packs:previewSound` IPC (off GitHub raw, main-side LRU) and turned into a Blob
// URL cached keyed by packName/file. Unlike installed-sound URLs (kept for the app
// lifetime), preview URLs are tied to the dialog: `revokePreviewCache()` drops them
// all when the registry dialog closes. Only one preview plays at a time.

const previewCache = new Map<string, Promise<string | null>>()
let previewAudio: HTMLAudioElement | null = null

function previewKey(packName: string, file: string): string {
  return `${packName}::${file}`
}

/** Resolve a Blob URL for a registry pack's preview file (cached). Null on failure. */
function getPreviewUrl(packName: string, file: string): Promise<string | null> {
  const k = previewKey(packName, file)
  const hit = previewCache.get(k)
  if (hit) return hit
  const p = window.eq
    .previewPackSound(packName, file)
    .then((data) => {
      if (!data) return null
      const bytes = Uint8Array.from(atob(data.dataBase64), (c) => c.charCodeAt(0))
      return URL.createObjectURL(new Blob([bytes], { type: data.mime }))
    })
    .catch(() => null)
  previewCache.set(k, p)
  return p
}

/**
 * Play a registry pack's preview sound at `volume` (0..1). Stops any preview
 * already playing (only one at a time). Resolves once the fetch + play kicks off;
 * returns false if the sound couldn't be loaded.
 */
export async function playPreviewSound(
  packName: string,
  file: string,
  volume: number
): Promise<boolean> {
  const url = await getPreviewUrl(packName, file)
  if (!url) return false
  stopPreview()
  const audio = new Audio(url)
  audio.volume = Math.max(0, Math.min(1, volume))
  previewAudio = audio
  try {
    await audio.play()
  } catch {
    // Autoplay/user-gesture policies can reject; nothing to do.
  }
  return true
}

/** Stop the currently-playing preview (if any). */
export function stopPreview(): void {
  if (previewAudio) {
    previewAudio.pause()
    previewAudio.currentTime = 0
    previewAudio = null
  }
}

/**
 * Drop all cached preview Blob URLs (revoking them) and stop playback. Call when the
 * registry dialog closes so preview bytes don't leak for the app's lifetime.
 */
export function revokePreviewCache(): void {
  stopPreview()
  for (const p of previewCache.values()) {
    void p.then((url) => {
      if (url) URL.revokeObjectURL(url)
    })
  }
  previewCache.clear()
}
