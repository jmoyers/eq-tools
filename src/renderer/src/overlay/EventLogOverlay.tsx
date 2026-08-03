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
//                 A CON ROW ALSO CLICKS THROUGH TO THE APP (Task #64): the hover card is a
//                 glance (six drops, then "+38 more"), and a mob you conned and want to think
//                 about deserves the real page. Clicking asks main to raise the main window and
//                 open the Mobs tab on that mob — every drop listed out, each one hoverable and
//                 clickable. The row carries NO cursor change for it (user's call): the pointer
//                 hand read as a link promise on a window whose other affordances are links,
//                 and the hover card is already the row's answer to "is there more here".
//   locked      — fully click-through and STATIC: the same rows, minus every affordance. No
//                 links, no hover card, no deep link, no pointer cursors (a click-through
//                 window can't be hovered, so an affordance there would be a lie).
//
// HONESTY (law 1): a row shows only what the feed carries. A quest whose dataset names no
// reward has no hover target at all; an item whose page never resolved is plain text, not a
// dead link; an item whose lookup says nothing renders as its NAME, with no "what it's for"
// block at all (an empty block would claim "we checked, there's nothing" — we can't know that).

import { type JSX, useEffect, useRef, useState } from 'react'
import type { FeedDelta, FeedEvent, FeedSnap, ModuleDelta } from '@shared/types'
import { CONSIDER_FACTION_COLOR } from '@shared/logEvents'
import { wikiPageUrl } from '@shared/wiki'
import { formatTime } from '../lib/formatDate'
import { isTradeskillOnly } from '../lib/itemKnowledgeView'
import { ItemHoverCard, MobHoverCard, lookupItemCached } from './feedHoverCards'
import { HoverCardLayer } from './hoverCardLayer'
import { useOverlayChrome, type OverlayChrome } from './useOverlayChrome'
import { IconButton } from './IconButton'

const GOLD = '#d9b25f'

/** Per-kind accent + glyph. Colors match the app's semantics (alerts gold, loot teal, quest green,
 *  consider violet — a hue none of the other three uses, so a con row is identifiable at a glance
 *  even before you read it). The '◎' glyph reads as an eye/reticle: you looked at something. */
const KIND_STYLE: Record<FeedEvent['kind'], { color: string; glyph: string; label: string }> = {
  alert: { color: '#d9b25f', glyph: '!', label: 'Alert' },
  loot: { color: '#6fb3d2', glyph: '◆', label: 'Loot' },
  quest: { color: '#5fbf72', glyph: '✦', label: 'Quest' },
  con: { color: '#a98bf0', glyph: '◎', label: 'Considered' }
}

/**
 * A con row's ACCENT is the faction rung's color, not the kind's — the whole point of a consider
 * is "how does this thing feel about me", so the row's left edge and headline say it before you
 * read a word. The violet kind color stays on the glyph, so the row is still recognizably a con.
 */
function rowAccent(e: FeedEvent): string {
  return e.con ? CONSIDER_FACTION_COLOR[e.con.faction] : KIND_STYLE[e.kind].color
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
  // `boolean | undefined` is the honest value type: a title with NO verdict yet reads
  // undefined, and the `=== false` filter below is what holds that row back until the
  // lookup lands. Typing it as plain `boolean` would make that comparison look redundant.
  const [verdict, setVerdict] = useState<Record<string, boolean | undefined>>({})
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


/** What a row hovers, and what it links or hands off to. Locked mode has none of it. */
interface RowAffordances {
  href: string | undefined
  /** a CON row explains a MOB, not an item — same hover machinery, different card */
  previewMob: string | undefined
  /** a quest's reward item, else — for a loot row — the item that dropped, which IS the headline */
  previewItem: string | undefined
  /** a quest row hovers by ROW (the reward sits at the row's right edge, so the row is the target) */
  rowHover: boolean
  /** a loot or CON row hovers by NAME: the name is the subject, the rest of the row is metadata */
  nameHover: boolean
}

function rowAffordances(e: FeedEvent, interactive: boolean): RowAffordances {
  const reward = e.reward
  const previewMob = interactive && e.kind === 'con' ? e.title : undefined
  const previewItem =
    interactive && !previewMob ? (reward?.item ?? (e.kind === 'loot' ? e.title : undefined)) : undefined
  return {
    href: interactive ? wikiPageUrl(e.page) : undefined,
    previewMob,
    previewItem,
    rowHover: !!previewItem && !!reward,
    nameHover: (!!previewItem && !reward) || !!previewMob
  }
}

/** The row's headline: a wiki link when the feed knows a page and we're interactive, else text. */
function RowTitle({
  e,
  accent,
  href,
  nameHover,
  isMob,
  onEnter,
  onLeave
}: {
  e: FeedEvent
  accent: string
  href: string | undefined
  nameHover: boolean
  isMob: boolean
  onEnter: (ev: React.MouseEvent<HTMLElement>) => void
  onLeave: () => void
}): JSX.Element {
  // For a quest the link is the QUEST page, not the reward item's.
  if (href) {
    return (
      <a
        data-testid="feed-title"
        href={href}
        target="_blank"
        rel="noreferrer"
        style={{ color: accent, fontWeight: 600, textDecoration: 'none' }}
        onMouseEnter={(ev) => {
          ev.currentTarget.style.textDecoration = 'underline'
          if (nameHover) onEnter(ev)
        }}
        onMouseLeave={(ev) => {
          ev.currentTarget.style.textDecoration = 'none'
          if (nameHover) onLeave()
        }}
      >
        {e.title}
      </a>
    )
  }
  return (
    <span
      data-testid="feed-title"
      // A CON row's name carries no cursor change at all (see the deep-link note below);
      // an item name keeps the `help` cursor, which is what its hover card is.
      style={{ color: accent, fontWeight: 600, cursor: nameHover && !isMob ? 'help' : undefined }}
      onMouseEnter={nameHover ? onEnter : undefined}
      onMouseLeave={nameHover ? onLeave : undefined}
    >
      {e.title}
    </span>
  )
}

/** One feed row. `interactive` false ⇒ locked mode: identical content, zero affordances. */
function Row({ e, interactive }: { e: FeedEvent; interactive: boolean }): JSX.Element {
  // The hover card's ANCHOR element (null = no card). Holding the element itself, not a boolean,
  // is what lets the layer clamp against the exact thing you're pointing at.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const style = KIND_STYLE[e.kind]
  const accent = rowAccent(e)
  const reward = e.reward
  const { href, previewMob, previewItem, rowHover, nameHover } = rowAffordances(e, interactive)
  // DEEP LINK (Task #64): a con row hands the mob to the app. Interactive mode only — a locked
  // overlay is click-through by law and has no clicks to give. Deliberately NO cursor change:
  // the pointer hand is this window's link vocabulary, and this is a hand-off, not a link.
  const deepLinkMob = previewMob
  const enter = (ev: React.MouseEvent<HTMLElement>): void => setAnchor(ev.currentTarget)
  const leave = (): void => setAnchor(null)

  return (
    <div
      data-testid="feed-row"
      data-deeplink-mob={deepLinkMob}
      onMouseEnter={rowHover ? enter : undefined}
      onMouseLeave={rowHover ? leave : undefined}
      onClick={deepLinkMob ? () => window.eqOverlay.focusMob(deepLinkMob) : undefined}
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'baseline',
        padding: '3px 4px',
        borderLeft: `2px solid ${accent}`,
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
        <RowTitle
          e={e}
          accent={accent}
          href={href}
          nameHover={nameHover}
          isMob={!!previewMob}
          onEnter={enter}
          onLeave={leave}
        />
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

      {anchor && previewMob && (
        <HoverCardLayer anchor={anchor}>
          <MobHoverCard mob={previewMob} con={e.con} />
        </HoverCardLayer>
      )}
      {anchor && !previewMob && previewItem && (
        <HoverCardLayer anchor={anchor}>
          <ItemHoverCard item={previewItem} stats={reward?.stats} />
        </HoverCardLayer>
      )}
    </div>
  )
}

/**
 * Hydrate the feed, then ride deltas. A `log:character` rebuild resets the module's ring; the
 * next delta's seq restarts low, so we accept a delta whose seq went BACKWARDS by re-hydrating
 * rather than silently dropping rows forever. Same gap/dupe rule useModule enforces in the app.
 */
function useEventFeed(): FeedSnap {
  const [rows, setRows] = useState<FeedSnap>([])
  const seqRef = useRef(-1)

  useEffect(() => {
    let alive = true
    const hydrate = (): void => {
      void window.eqOverlay.getModuleSnapshot<FeedSnap>('eventFeed').then((snap) => {
        if (!alive || !snap) return
        seqRef.current = snap.seq
        setRows(snap.state)
      })
    }
    hydrate()
    const off = window.eqOverlay.onModuleDelta<FeedDelta>((d: ModuleDelta<FeedDelta>) => {
      if (d.moduleId !== 'eventFeed') return
      if (d.seq <= seqRef.current) {
        // Backwards seq ⇒ the module reset (character switch). Re-hydrate from scratch.
        if (d.seq < seqRef.current) hydrate()
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

  return rows
}

/** Header — same shape as the meter's: tag, title, count, controls. Drag handle when interactive. */
function FeedHeader({
  count,
  chrome
}: {
  count: number
  chrome: Pick<OverlayChrome, 'locked' | 'hovering' | 'dragRegion' | 'noDrag' | 'toggleLock'>
}): JSX.Element {
  const { locked, hovering, dragRegion, noDrag, toggleLock } = chrome
  return (
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
      <span style={{ color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
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
  )
}

/** Footer — interactive mode only: the bg-alpha slider, matching the meters. */
function FeedFooter({
  bgAlpha,
  patch,
  noDrag
}: {
  bgAlpha: number
  patch: OverlayChrome['patch']
  noDrag: React.CSSProperties
}): JSX.Element {
  return (
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
  )
}

export default function EventLogOverlay(): JSX.Element {
  const rows = useEventFeed()
  const { locked, bgAlpha, hovering, patch, toggleLock, onEnter, onLeave, dragRegion, noDrag } =
    useOverlayChrome()
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
      <FeedHeader
        count={feed.length}
        chrome={{ locked, hovering, dragRegion, noDrag, toggleLock }}
      />

      {/* The feed. Newest first; a fixed-height scroll box (AGENTS.md: a growing list never sizes
          to its content). */}
      <div style={{ flexGrow: 1, minHeight: 0, overflow: 'auto', padding: '4px 6px' }}>
        {feed.length === 0 ? (
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', padding: '8px 2px' }}>
            Watching for alerts, notable loot, considers and quest completions…
          </div>
        ) : (
          feed.map((e) => <Row key={e.id} e={e} interactive={!locked} />)
        )}
      </div>

      {!locked && <FeedFooter bgAlpha={bgAlpha} patch={patch} noDrag={noDrag} />}
    </div>
  )
}
