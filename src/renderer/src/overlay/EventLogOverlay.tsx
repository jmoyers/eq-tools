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
//                 setWindowOpenHandler; the overlay window itself never navigates), and a quest
//                 that awards an item reveals that item's in-game-style card on hover.
//   locked      — fully click-through and STATIC: the same rows, minus every affordance. No
//                 links, no hover card, no pointer cursors (a click-through window can't be
//                 hovered, so an affordance there would be a lie).
//
// HONESTY (law 1): a row shows only what the feed carries. A quest whose dataset names no
// reward has no hover target at all; an item whose page never resolved is plain text, not a
// dead link.

import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import type { FeedDelta, FeedEvent, FeedSnap, ItemKnowledge, ModuleDelta, OverlayConfig } from '@shared/types'
import { wikiPageUrl } from '@shared/wiki'
import { formatTime } from '../lib/formatDate'

// The game-style item window is a MUI component; the overlay bundle is otherwise MUI-free by
// design. Loading it LAZILY keeps that promise where it matters — a pinned, locked overlay (and
// any session where the user never hovers a reward) never pulls MUI into this window at all.
const ItemWindow = lazy(() =>
  import('../lib/ItemWindow').then((m) => ({ default: m.ItemWindow }))
)

const GOLD = '#d9b25f'

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
 * The reward item's hover card: the same game item window the loot dialog and posky tooltip
 * draw. It prefers a live `lookupItem` result (structured stats + icon, cache-first in main)
 * and falls back to the stat blob the scraped quest data already carries, so it renders
 * instantly and offline. Neither available ⇒ ItemWindow shows just the name, which is the
 * honest answer.
 */
function RewardCard({ item, stats }: { item: string; stats?: string }): JSX.Element {
  const [k, setK] = useState<ItemKnowledge | null>(null)
  useEffect(() => {
    let alive = true
    void window.eqOverlay
      .lookupItem(item)
      .then((res) => alive && setK(res))
      .catch(() => {
        /* never rejects in production; a miss just means we render the posky blob */
      })
    return () => {
      alive = false
    }
  }, [item])

  return (
    <div
      style={{
        background: 'rgba(15,16,23,0.98)',
        border: `1px solid ${GOLD}`,
        borderRadius: 6,
        padding: 8,
        maxWidth: 300,
        boxShadow: '0 6px 20px rgba(0,0,0,0.6)'
      }}
    >
      <Suspense fallback={<div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>{item}</div>}>
        <ItemWindow name={item} stats={k?.stats} rawStats={stats} iconId={k?.iconId} compact />
      </Suspense>
    </div>
  )
}

/** One feed row. `interactive` false ⇒ locked mode: identical content, zero affordances. */
function Row({ e, interactive }: { e: FeedEvent; interactive: boolean }): JSX.Element {
  const [hover, setHover] = useState(false)
  const style = KIND_STYLE[e.kind]
  const href = interactive ? wikiPageUrl(e.page) : undefined
  const reward = e.reward
  const canPreview = interactive && !!reward

  return (
    <div
      onMouseEnter={canPreview ? () => setHover(true) : undefined}
      onMouseLeave={canPreview ? () => setHover(false) : undefined}
      style={{
        position: 'relative',
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
            href={href}
            target="_blank"
            rel="noreferrer"
            style={{ color: style.color, fontWeight: 600, textDecoration: 'none' }}
            onMouseEnter={(ev) => (ev.currentTarget.style.textDecoration = 'underline')}
            onMouseLeave={(ev) => (ev.currentTarget.style.textDecoration = 'none')}
          >
            {e.title}
          </a>
        ) : (
          <span style={{ color: style.color, fontWeight: 600 }}>{e.title}</span>
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

      {hover && reward && (
        <div style={{ position: 'absolute', right: 0, bottom: '100%', zIndex: 5, paddingBottom: 4 }}>
          <RewardCard item={reward.item} stats={reward.stats} />
        </div>
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
  const feed = newestFirst(rows)

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
