// search.ts — shared helpers for the app's non-blocking search pattern.
//
// The pattern (see AGENTS.md "UI conventions"):
//   1. The input echoes IMMEDIATELY from local state; the FILTER consumes a
//      DEFERRED copy of the query (useDeferredValue) so typing never waits on the
//      filter + re-render. React renders the deferred filter at low priority and
//      keeps the input responsive.
//   2. Searchable text is lowercased ONCE per data change (a cached key computed in
//      a useMemo keyed on the source array), never per keystroke — so the filter is a
//      plain substring test. Each view builds its own key inline (see LootView /
//      SuggestAlertsDialog / SoundPacksDialog).
//   3. Long dense result lists are windowed (useWindowedRows), so a large match set
//      never mounts hundreds of rows synchronously.
//
// These surfaces are RENDER-bound, not compute-bound (measured: filtering 3.5k loot
// rows is <1ms) — so no Web Worker / database is needed. Defer + precompute + window.

/** Normalize a query for substring matching (trim + lowercase). */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase()
}
