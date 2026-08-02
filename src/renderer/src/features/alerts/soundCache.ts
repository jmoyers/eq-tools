// soundCache — fetch a pack sound's bytes once (over IPC), build a CSP-safe Blob
// URL, and cache it keyed by packId/soundId. The app's CSP forbids file:// and
// remote audio, but a Blob URL made from bytes we already have is allowed. Blob
// URLs live for the app's lifetime (we intentionally never revoke — the set of
// sounds is tiny and re-fetching on every play would add latency to alerts).

const cache = new Map<string, Promise<string | null>>()

function key(packId: string, soundId: string): string {
  return `${packId}/${soundId}`
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

/**
 * Play a pack sound at `volume` (0..1). Overlapping plays are allowed — each call
 * uses its own <audio> element so a rapid burst doesn't cut off the previous
 * sound. Resolves when playback starts (or immediately on failure).
 */
export async function playSound(packId: string, soundId: string, volume: number): Promise<void> {
  const url = await getSoundUrl(packId, soundId)
  if (!url) return
  const audio = new Audio(url)
  audio.volume = Math.max(0, Math.min(1, volume))
  try {
    await audio.play()
  } catch {
    // Autoplay/user-gesture policies can reject the first play; nothing to do.
  }
}
