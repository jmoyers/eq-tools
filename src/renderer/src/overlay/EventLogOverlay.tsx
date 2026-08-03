// EventLogOverlay (Task #59) — the 'events' overlay kind: a live, reverse-chronological feed of
// alerts firing, notable loot, and quest completions.
//
// It is a sibling of OverlayMeter in the SAME overlay.html bundle (kind read from `?kind=`), so
// it shares all the per-kind machinery: persisted `overlays.events` config, drag/resize, the
// bg-alpha slider, and the lock (pin) semantics. Styling deliberately mirrors the meter — plain
// divs + inline styles, no MUI — so the window stays cheap to paint over the game.
//
// DATA: the main-side eventFeed module (modules/eventFeed.ts) owns the capped ring and is the
// single source of truth. We hydrate it once over `module:getSnapshot` and then ride
// `module:delta`, the same contract useModule implements for the main app. Because that module
// admits only LIVE events, opening this overlay during the startup replay shows an empty feed
// that fills as things actually happen — never a burst of hours-old history.
//
// INTERACTION, by mode:
//   interactive — rows with a link open the wiki page in the DEFAULT BROWSER (an <a
//                 target="_blank">, turned into shell.openExternal by main's
//                 setWindowOpenHandler; the overlay window itself never navigates), and EVERY
//                 item name reveals that item's in-game-style card on hover — a quest's reward
//                 item (hover the row, the reward is named at its right edge) and a LOOT row's
//                 item name (hover the name; the rest of the row is metadata). One card, both
//                 places: what it is, then what it's for.
//   locked      — fully click-through and STATIC: the same rows, minus every affordance. No
//                 links, no hover card, no pointer cursors (a click-through window can't be
//                 hovered, so an affordance there would be a lie).
//
// HONESTY (law 1): a row shows only what the feed carries. A quest whose dataset names no
// reward has no hover target at all; an item whose page never resolved is plain text, not a
// dead link; an item whose lookup says nothing renders as its NAME, with no "what it's for"
// block at all (an empty block would claim "we checked, there's nothing" — we can't know that).

import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FeedDelta, FeedEvent, FeedSnap, ItemKnowledge, ModuleDelta, OverlayConfig } from '@shared/types'
import { wikiPageUrl } from '@shared/wiki'
import { formatTime } from '../lib/formatDate'
import { isTradeskillOnly, questUseOutcomes, questUseWhere } from '../lib/itemKnowledgeView'

// The game-style item window is a MUI component; the overlay bundle is otherwise MUI-free by
// design. Loading it LAZILY keeps that promise where it matters — a pinned, locked overlay (and
// any session where the user never hovers a reward) never pulls MUI into this window at all.
const ItemWindow = lazy(() =>
  import('../lib/ItemWindow').then((m) => ({ default: m.ItemWindow }))
)

const GOLD = '#d9b25f'
/** Card palette — the same semantics as EQ_ITEM_COLORS, respelled here so importing it
 *  (from ItemWindow.tsx, which pulls MUI at module scope) can't defeat the lazy import. */
const CARD_TEXT = '#e9eaf2'
const CARD_LABEL = '#a8b0c6'
const CARD_ITEM = '#5fe08a'
const CARD_MONO = '"Consolas","Courier New",monospace'
/** How many quest uses / recipes the card lists before collapsing to "+N more". */
const MAX_LISTED = 4
/** Gap the hover card keeps from its anchor AND from every window edge. */
const CARD_MARGIN = 4

// ---- item knowledge: ONE fetch per item name, for the whole window's lifetime ----------
//
// Both consumers here ask the same question of the same door (`window.eqOverlay.lookupItem`,
// which is cache-first in main): the tradeskill FILTER asks about every loot row that appears,
// and the hover CARD asks about the row you're pointing at. Sharing one map means a hovered
// loot item is normally already answered — the card paints from memory with no IPC at all —
// and two rows for the same item can never race into two round trips.
const KNOWLEDGE = new Map<string, ItemKnowledge>()
const PENDING = new Map<string, Promise<ItemKnowledge | null>>()

function cachedKnowledge(name: string): ItemKnowledge | undefined {
  return KNOWLEDGE.get(name.toLowerCase())
}

/** Resolve an item's knowledge, at most once per name. Never rejects — a miss resolves null. */
function lookupItemCached(name: string): Promise<ItemKnowledge | null> {
  const key = name.toLowerCase()
  const hit = KNOWLEDGE.get(key)
  if (hit) return Promise.resolve(hit)
  const inflight = PENDING.get(key)
  if (inflight) return inflight
  const p = window.eqOverlay
    .lookupItem(name)
    .then((k: ItemKnowledge) => {
      KNOWLEDGE.set(key, k)
      PENDING.delete(key)
      return k
    })
    .catch(() => {
      PENDING.delete(key)
      return null
    })
  PENDING.set(key, p)
  return p
}

/**
 * Knowledge for a card that is CURRENTLY OPEN. The card mounts on hover and unmounts on leave,
 * so "on mount" IS "on first hover" — a feed of 100 rows costs zero lookups until one is
 * pointed at, and a second hover of the same row costs nothing at all (the map above).
 */
function useItemKnowledge(name: string): { data: ItemKnowledge | null; loading: boolean } {
  const [data, setData] = useState<ItemKnowledge | null>(() => cachedKnowledge(name) ?? null)
  const [loading, setLoading] = useState(() => !cachedKnowledge(name))

  useEffect(() => {
    const hit = cachedKnowledge(name)
    if (hit) {
      setData(hit)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    void lookupItemCached(name).then((k) => {
      if (!alive) return
      setData(k)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [name])

  return { data, loading }
}

/** Per-kind accent + glyph. Colors match the app's semantics (alerts gold, loot teal, quest green). */
const KIND_STYLE: Record<FeedEvent['kind'], { color: string; glyph: string; label: string }> = {
  alert: { color: '#d9b25f', glyph: '!', label: 'Alert' },
  loot: { color: '#6fb3d2', glyph: '◆', label: 'Loot' },
  quest: { color: '#5fbf72', glyph: '✦', label: 'Quest' }
}

/** Newest first — the feed module keeps its ring newest-LAST. */
function newestFirst(rows: FeedSnap): FeedEvent[] {
  return rows.slice().reverse()
}

/**
 * TRADESKILL FILTER (Task #62) — hide loot rows for items that are only recipe ingredients.
 *
 * The feed admits a loot row when the item is NOTABLE, and an item page's stats block hands
 * the QUEST ITEM flag to a whole family of things no quest anywhere uses (spider legs, gnome
 * meat, bone-chip-grade components). On a glanceable overlay that is pure noise, so they never
 * appear here. UNCONDITIONAL, unlike the loot tab's toggle: this window is a separate renderer
 * entry with its own storage partition (it cannot read the main window's localStorage) and its
 * persisted config lives in the main-owned store, so there is no honest place to keep a pref
 * yet. The loot tab remains the surface where you can ask to see them.
 *
 * A row is held back until its verdict lands rather than shown-then-yanked: the item is already
 * in main's item cache (the feed only exists because a lookup resolved it), so the answer is an
 * IPC round trip, not a wiki call. A lookup that fails counts as "not tradeskill" — an outage
 * must never blank the feed.
 */
function useTradeskillFilter(feed: FeedEvent[]): FeedEvent[] {
  const [verdict, setVerdict] = useState<Record<string, boolean>>({})
  const asked = useRef<Set<string>>(new Set())

  const lootKeys = feed
    .filter((e) => e.kind === 'loot')
    .map((e) => e.title.toLowerCase())
    .join('|')

  useEffect(() => {
    let alive = true
    const todo: string[] = []
    for (const e of feed) {
      if (e.kind !== 'loot') continue
      const key = e.title.toLowerCase()
      if (asked.current.has(key)) continue
      asked.current.add(key)
      todo.push(e.title)
    }
    for (const title of todo) {
      // Same door the hover card uses (lookupItemCached), so the verdict ALSO warms the card.
      void lookupItemCached(title).then((k) => {
        // A lookup that failed (null) counts as "not tradeskill" — an outage must never blank
        // the feed.
        if (alive) setVerdict((v) => ({ ...v, [title.toLowerCase()]: k ? isTradeskillOnly(k) : false }))
      })
    }
    return () => {
      alive = false
    }
    // Re-run when the set of loot titles on screen changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lootKeys])

  return feed.filter((e) => e.kind !== 'loot' || verdict[e.title.toLowerCase()] === false)
}

const LABEL_STYLE: React.CSSProperties = { color: CARD_LABEL, fontSize: 10, lineHeight: 1.4 }
const TEXT_STYLE: React.CSSProperties = { color: CARD_TEXT, fontSize: 10, lineHeight: 1.4 }

/**
 * "What it's for" — the block BELOW the hairline, mirroring the main window's KnownItemTooltip:
 * quest uses first (the reason an item is notable at all), then the recipes that consume it,
 * which is the honest answer for the big family of QUEST-ITEM-flagged tradeskill components.
 *
 * Outcomes are PLAIN TEXT here, unlike the main window's nested card. This is a compact,
 * always-on-top window with no room to escape a popper chain and no dismiss affordance: ONE
 * card, no hops. Renders nothing when we know nothing (an empty block would read as "checked,
 * nothing there", which a failed lookup can't claim).
 */
function WhatItsFor({ k }: { k: ItemKnowledge }): JSX.Element | null {
  const uses = k.questUses
  const recipes = k.recipes ?? []
  if (uses.length === 0 && recipes.length === 0) return null

  const shownUses = uses.slice(0, MAX_LISTED)
  const shownRecipes = recipes.slice(0, MAX_LISTED)

  return (
    <div
      data-testid="feed-card-uses"
      style={{
        marginTop: 6,
        paddingTop: 5,
        borderTop: '1px solid rgba(255,255,255,0.12)',
        fontFamily: CARD_MONO
      }}
    >
      {shownUses.length > 0 && (
        <div style={{ marginBottom: shownRecipes.length > 0 ? 5 : 0 }}>
          <div style={LABEL_STYLE}>Used in {uses.length === 1 ? 'quest' : 'quests'}:</div>
          {shownUses.map((u) => {
            const where = questUseWhere(u)
            const outcomes = questUseOutcomes(u)
            return (
              <div key={`${u.source}:${u.page ?? ''}:${u.quest}:${u.role ?? ''}`} style={{ marginTop: 2 }}>
                <div style={TEXT_STYLE}>
                  {u.quest}
                  {u.role === 'reward' && <span style={{ color: CARD_LABEL }}> · reward</span>}
                  {where && <span style={{ color: CARD_LABEL }}> · {where}</span>}
                </div>
                {/* Turning it in yields these. Named, never hoverable — see the header above. */}
                {outcomes.length > 0 && (
                  <div style={{ ...LABEL_STYLE, paddingLeft: 8 }}>→ {outcomes.join(', ')}</div>
                )}
              </div>
            )
          })}
          {uses.length > shownUses.length && (
            <div style={LABEL_STYLE}>+{uses.length - shownUses.length} more</div>
          )}
        </div>
      )}

      {shownRecipes.length > 0 && (
        <div>
          <div style={LABEL_STYLE}>Used in {recipes.length === 1 ? 'recipe' : 'recipes'}:</div>
          {shownRecipes.map((r) => {
            const how = [r.tradeskill, r.trivial != null ? String(r.trivial) : null]
              .filter(Boolean)
              .join(' ')
            return (
              <div key={`${r.tradeskill ?? ''}:${r.recipe}`} style={{ ...LABEL_STYLE, marginTop: 2 }}>
                <span style={{ color: CARD_ITEM }}>{r.recipe}</span>
                {how && <> · {how}</>}
              </div>
            )
          })}
          {recipes.length > shownRecipes.length && (
            <div style={LABEL_STYLE}>+{recipes.length - shownRecipes.length} more</div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * THE item hover card — one component behind every hover in this window (a quest's reward item
 * and a loot row's item alike). It answers the two questions a name can't: what it IS (the same
 * game item window the loot dialog and posky tooltip draw) and what it's FOR (WhatItsFor).
 *
 * It prefers a live `lookupItem` result (structured stats + icon, cache-first in main) and falls
 * back to the stat blob the scraped quest data already carries, so a reward renders instantly
 * and offline. Neither available ⇒ ItemWindow shows just the NAME, which is the honest answer.
 */
function ItemHoverCard({ item, stats }: { item: string; stats?: string }): JSX.Element {
  const { data, loading } = useItemKnowledge(item)
  return (
    <div
      data-testid="feed-item-card"
      data-item={item}
      style={{
        background: 'rgba(15,16,23,0.98)',
        border: `1px solid ${GOLD}`,
        borderRadius: 6,
        padding: 8,
        maxWidth: 300,
        boxShadow: '0 6px 20px rgba(0,0,0,0.6)'
      }}
    >
      <Suspense fallback={<div style={{ fontSize: 11, color: CARD_ITEM, fontFamily: CARD_MONO }}>{item}</div>}>
        <ItemWindow
          name={item}
          stats={data?.stats}
          rawStats={stats ?? data?.statsBlock}
          iconId={data?.iconId}
          flavor={data?.summary}
          compact
        />
      </Suspense>
      {loading && !data && (
        <div style={{ ...LABEL_STYLE, fontFamily: CARD_MONO, marginTop: 4 }}>Looking up…</div>
      )}
      {data && <WhatItsFor k={data} />}
      {data?.offline && (
        <div style={{ ...LABEL_STYLE, fontFamily: CARD_MONO, marginTop: 4 }}>
          offline — showing what&apos;s known locally
        </div>
      )}
    </div>
  )
}

/**
 * Places a hover card near its anchor and CLAMPS it inside the window.
 *
 * `position: fixed`, not absolute-in-the-row: the feed is an `overflow:auto` scroll box inside an
 * `overflow:hidden` shell, so a card positioned within a row would be clipped by the scroller
 * (and, worse, could grow its scroll extent). Fixed coordinates are measured against the
 * VIEWPORT — the overlay window itself — which is also the only frame that matters here: this
 * window is small and routinely parked against a screen edge.
 *
 * Placement: above the anchor by preference (the feed reads newest-first, so a card below would
 * cover the rows you're scanning), flipped below when there's no room, then clamped on both
 * axes so it can never hang off any edge. Re-runs whenever the card's own size changes — the
 * MUI ItemWindow arrives lazily and its icon later still, so the first measurement is never the
 * last one. Hidden until placed, so it never flashes at 0,0.
 *
 * `pointerEvents: none` is load-bearing: the card has nothing to click (no links, no nested
 * hover), and a card that took the pointer while overlapping its own anchor would fire the
 * anchor's mouseleave, unmount itself, and flicker.
 */
function HoverCardLayer({ anchor, children }: { anchor: HTMLElement; children: React.ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const place = (): void => {
      const a = anchor.getBoundingClientRect()
      const c = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const m = CARD_MARGIN
      let top = a.top - c.height - m
      if (top < m) top = a.bottom + m
      if (top + c.height > vh - m) top = Math.max(m, vh - m - c.height)
      let left = a.left
      if (left + c.width > vw - m) left = vw - m - c.width
      if (left < m) left = m
      setPos((p) => (p && Math.abs(p.left - left) < 0.5 && Math.abs(p.top - top) < 0.5 ? p : { left, top }))
    }
    place()
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(place)
    })
    ro.observe(el)
    window.addEventListener('resize', place)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [anchor])

  return (
    <div
      ref={ref}
      data-testid="feed-hover-card"
      style={{
        position: 'fixed',
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? 'visible' : 'hidden',
        zIndex: 20,
        pointerEvents: 'none',
        maxWidth: `calc(100vw - ${CARD_MARGIN * 2}px)`,
        maxHeight: `calc(100vh - ${CARD_MARGIN * 2}px)`,
        overflow: 'hidden'
      }}
    >
      {children}
    </div>
  )
}

/** One feed row. `interactive` false ⇒ locked mode: identical content, zero affordances. */
function Row({ e, interactive }: { e: FeedEvent; interactive: boolean }): JSX.Element {
  // The hover card's ANCHOR element (null = no card). Holding the element itself, not a boolean,
  // is what lets the layer clamp against the exact thing you're pointing at.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const style = KIND_STYLE[e.kind]
  const href = interactive ? wikiPageUrl(e.page) : undefined
  const reward = e.reward
  // WHICH item the card explains: a quest's reward item, else — for a loot row — the item that
  // dropped, which IS the headline. Locked mode has no card at all (the header's law).
  const previewItem = interactive ? (reward?.item ?? (e.kind === 'loot' ? e.title : undefined)) : undefined
  // A quest row hovers by ROW (the reward is named at the row's right edge, so the whole row is
  // the target); a loot row hovers by NAME, because the name is the item and the timestamp /
  // source half of the row is metadata you shouldn't have to avoid.
  const rowHover = !!previewItem && !!reward
  const nameHover = !!previewItem && !reward
  const enter = (ev: React.MouseEvent<HTMLElement>): void => setAnchor(ev.currentTarget)
  const leave = (): void => setAnchor(null)

  return (
    <div
      data-testid="feed-row"
      onMouseEnter={rowHover ? enter : undefined}
      onMouseLeave={rowHover ? leave : undefined}
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'baseline',
        padding: '3px 4px',
        borderLeft: `2px solid ${style.color}`,
        marginBottom: 2,
        background: 'rgba(255,255,255,0.04)',
        borderRadius: 3,
        fontSize: 11,
        lineHeight: 1.3
      }}
    >
      <span
        title={style.label}
        style={{ color: style.color, flexShrink: 0, width: 10, textAlign: 'center', fontWeight: 700 }}
      >
        {style.glyph}
      </span>
      <span
        style={{
          color: 'rgba(255,255,255,0.45)',
          flexShrink: 0,
          fontVariantNumeric: 'tabular-nums',
          fontSize: 10
        }}
      >
        {formatTime(e.ts)}
      </span>
      <span style={{ flexGrow: 1, minWidth: 0 }}>
        {/* The headline. When the feed knows a wiki page AND we're interactive, it's a link —
            for a quest that is the QUEST page, not the reward item's. */}
        {href ? (
          <a
            data-testid="feed-title"
            href={href}
            target="_blank"
            rel="noreferrer"
            style={{ color: style.color, fontWeight: 600, textDecoration: 'none' }}
            onMouseEnter={(ev) => {
              ev.currentTarget.style.textDecoration = 'underline'
              if (nameHover) enter(ev)
            }}
            onMouseLeave={(ev) => {
              ev.currentTarget.style.textDecoration = 'none'
              if (nameHover) leave()
            }}
          >
            {e.title}
          </a>
        ) : (
          <span
            data-testid="feed-title"
            style={{ color: style.color, fontWeight: 600, cursor: nameHover ? 'help' : undefined }}
            onMouseEnter={nameHover ? enter : undefined}
            onMouseLeave={nameHover ? leave : undefined}
          >
            {e.title}
          </span>
        )}
        {e.detail && (
          <span style={{ color: 'rgba(255,255,255,0.6)', marginLeft: 5 }}>{e.detail}</span>
        )}
        {/* A quest that awards an item names it inline — the hover card is the detail view. */}
        {reward && (
          <span style={{ color: 'rgba(255,255,255,0.85)', marginLeft: 5 }}>
            → <span style={{ color: '#5fe08a' }}>{reward.item}</span>
          </span>
        )}
      </span>

      {anchor && previewItem && (
        <HoverCardLayer anchor={anchor}>
          <ItemHoverCard item={previewItem} stats={reward?.stats} />
        </HoverCardLayer>
      )}
    </div>
  )
}

export default function EventLogOverlay(): JSX.Element {
  const [cfg, setCfg] = useState<OverlayConfig | null>(null)
  const [rows, setRows] = useState<FeedSnap>([])
  const [hovering, setHovering] = useState(false)
  const hoveringRef = useRef(false)
  // Last applied module seq — the same gap/dupe rule useModule enforces in the main app.
  const seqRef = useRef(-1)

  useEffect(() => {
    void window.eqOverlay.getConfig().then(setCfg)
    return window.eqOverlay.onConfig(setCfg)
  }, [])

  // Hydrate the feed, then ride deltas. A `log:character` rebuild resets the module's ring; the
  // next delta's seq restarts low, so we accept a delta whose seq went BACKWARDS by re-hydrating
  // rather than silently dropping rows forever.
  useEffect(() => {
    let alive = true
    void window.eqOverlay.getModuleSnapshot<FeedSnap>('eventFeed').then((snap) => {
      if (!alive || !snap) return
      seqRef.current = snap.seq
      setRows(snap.state)
    })
    const off = window.eqOverlay.onModuleDelta<FeedDelta>((d: ModuleDelta<FeedDelta>) => {
      if (d.moduleId !== 'eventFeed') return
      if (d.seq <= seqRef.current) {
        // Backwards seq ⇒ the module reset (character switch). Re-hydrate from scratch.
        if (d.seq < seqRef.current) {
          void window.eqOverlay.getModuleSnapshot<FeedSnap>('eventFeed').then((snap) => {
            if (!snap) return
            seqRef.current = snap.seq
            setRows(snap.state)
          })
        }
        return
      }
      seqRef.current = d.seq
      setRows((prev) => {
        const next = [...prev, ...d.delta.appended]
        // Mirror the module's cap so a long session can't grow this list unboundedly.
        return next.length > 100 ? next.slice(next.length - 100) : next
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const locked = cfg?.locked ?? false
  const bgAlpha = cfg?.bgAlpha ?? 0.72

  const patch = (p: Partial<OverlayConfig>): void => {
    setCfg((c) => (c ? { ...c, ...p } : c))
    void window.eqOverlay.setConfig(p)
  }

  const setHoverCapture = (capture: boolean): void => {
    if (hoveringRef.current === capture) return
    hoveringRef.current = capture
    setHovering(capture)
    window.eqOverlay.setIgnoreMouse(!capture)
  }
  const toggleLock = (): void => {
    const next = !locked
    window.eqOverlay.setLocked(next)
    patch({ locked: next })
    if (next) setHoverCapture(false)
  }
  const onEnter = (): void => {
    if (locked) setHoverCapture(true)
  }
  const onLeave = (): void => {
    if (locked) setHoverCapture(false)
  }

  const dragRegion = !locked ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : {}
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties
  const feed = useTradeskillFilter(newestFirst(rows))

  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Inter, "Segoe UI", Roboto, system-ui, sans-serif',
        color: '#f2f2f2',
        background: `rgba(14,17,21,${bgAlpha})`,
        border: locked ? '1px solid rgba(255,255,255,0.04)' : `1px solid rgba(217,178,95,0.4)`,
        borderRadius: 8,
        boxSizing: 'border-box',
        overflow: 'hidden'
      }}
    >
      {/* Header — same shape as the meter's: tag, title, count, controls. Drag handle when interactive. */}
      <div
        style={{
          ...dragRegion,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          fontSize: 11,
          flexShrink: 0
        }}
      >
        <span
          style={{
            fontSize: 8,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.4)',
            flexShrink: 0
          }}
        >
          EVENTS
        </span>
        <span style={{ fontWeight: 700, color: GOLD, flexGrow: 1, whiteSpace: 'nowrap' }}>Event log</span>
        <span style={{ color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums' }}>
          {feed.length}
        </span>
        {(!locked || hovering) && (
          <div style={{ ...noDrag, display: 'flex', alignItems: 'center', gap: 2, marginLeft: 2 }}>
            <IconButton
              title={locked ? 'Unlock (interactive)' : 'Lock (click-through)'}
              onClick={toggleLock}
              accent={locked}
            >
              {locked ? '🔓' : '📌'}
            </IconButton>
            {!locked && (
              <IconButton title="Close overlay" onClick={() => window.eqOverlay.close()} danger>
                ✕
              </IconButton>
            )}
          </div>
        )}
      </div>

      {/* The feed. Newest first; a fixed-height scroll box (AGENTS.md: a growing list never sizes
          to its content). */}
      <div style={{ flexGrow: 1, minHeight: 0, overflow: 'auto', padding: '4px 6px' }}>
        {feed.length === 0 ? (
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', padding: '8px 2px' }}>
            Watching for alerts, notable loot and quest completions…
          </div>
        ) : (
          feed.map((e) => <Row key={e.id} e={e} interactive={!locked} />)
        )}
      </div>

      {/* Footer — interactive mode only: the bg-alpha slider, matching the meters. */}
      {!locked && (
        <div
          style={{
            ...noDrag,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '3px 8px 5px',
            borderTop: '1px solid rgba(255,255,255,0.08)',
            fontSize: 10,
            color: 'rgba(255,255,255,0.6)',
            flexShrink: 0
          }}
        >
          <span title="Background opacity">bg</span>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.02}
            value={bgAlpha}
            onChange={(e) => patch({ bgAlpha: Number(e.target.value) })}
            style={{ flexGrow: 1, accentColor: GOLD, height: 4 }}
          />
        </div>
      )}
    </div>
  )
}

/** A small square icon button (plain, no MUI — the overlay bundle stays lean). */
function IconButton({
  onClick,
  title,
  children,
  danger,
  accent
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
  danger?: boolean
  accent?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        width: 20,
        height: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        fontSize: 11,
        lineHeight: 1,
        background: accent ? 'rgba(217,178,95,0.2)' : 'transparent',
        color: danger ? '#cf6679' : 'inherit',
        padding: 0
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.14)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = accent ? 'rgba(217,178,95,0.2)' : 'transparent')}
    >
      {children}
    </button>
  )
}
