/**
 * Wrapping absolute image URLs into the app's PERMANENT image cache.
 *
 * NO image the app downloads may ever be downloaded twice (AGENTS.md, Data sources). The
 * renderer's CSP enforces that structurally: `img-src` lists `'self' data: eqimg:` and NOT
 * `https:`, so a raw `<img src="https://…">` fails to load loudly in dev instead of quietly
 * bypassing the cache. Everything that used to be an absolute URL goes through here.
 *
 * `eqimg://url/<encodeURIComponent(url)>` is served by the main process
 * (src/main/imageCache.ts): a disk hit in `<userData>/image-cache/` when the app has seen
 * that URL before, otherwise ONE polite fetch that is then stored forever. Main re-validates
 * the URL against a strict host allowlist — this helper is a convenience, never a permission.
 * A URL main refuses (or a fetch that fails) responds 404 and the consumer's `<img onError>`
 * falls back, exactly as a dead https URL used to.
 *
 * WHY WRAP AT RENDER TIME instead of rewriting the data: `bosses.json` is SCRAPED data and
 * keeps the real upstream URLs, so it stays diffable against the wiki and the scraper stays
 * idempotent. The caching is the app's concern, not the data's.
 *
 * (Item icons have their own id-keyed route and their own helper — `itemIconUrl` in
 * ItemWindow.tsx — because there the id, not a URL, is what the renderer actually holds.)
 */
export function cachedImageUrl(absoluteUrl: string): string {
  return `eqimg://url/${encodeURIComponent(absoluteUrl)}`
}
