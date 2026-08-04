import { type JSX, useRef, useState } from 'react'
import {
  HOVER,
  OverlaySelectPopup,
  type ElementRef,
  type OverlaySelectRow
} from './OverlaySelect'
import { IconButton, ICON_ACCENT_GOLD } from './IconButton'
import type { OverlayChrome } from './useOverlayChrome'

/**
 * OverlayHeader — the ONE header row every overlay kind renders, and (in interactive mode) the
 * selector's trigger.
 *
 * WHY IT EXISTS: the five kinds hand-rolled three near-identical header bars, and each METER kind
 * then stacked a SECOND row underneath holding the segment selector. On a 380×320 window that row
 * cost 26–32px of bars to repeat what the header was already saying — the same name, the same live
 * dot, the same rate. So the header row IS the trigger now: click it and the existing popup
 * (OverlaySelect) opens directly under the header, unchanged rows and all. Picking a row updates
 * this header in place, because the header has always rendered the SELECTED segment.
 *
 * WORDING IS UNTOUCHED. The title is still the segment's own name and the tag still carries
 * `· LAST` for a head row that is a finished fight — the honest live/last vocabulary (world-model
 * law 6 / the Fight-vs-Overall scope rule) is not restated, re-cased or re-ordered here. All this
 * row gained is a chevron.
 *
 * MODES:
 *   interactive — title + tail are a no-drag click target with a chevron; the popup anchors to
 *                 this row's bottom edge and spans the window width.
 *   locked      — byte-identical to the plain header it always was: no chevron, no click target,
 *                 no listeners, fully click-through (the lock/close buttons still appear during
 *                 the hover-capture dance, exactly as before).
 *
 * DRAG: this row is the window's ONLY drag handle, and a `-webkit-app-region: drag` element
 * swallows clicks entirely — so the trigger carries `no-drag` and the LEFT cluster (live dot +
 * kind tag) plus the padding around the controls stays the drag surface.
 *
 * MUI-FREE ON PURPOSE: plain React + inline styles, like every file in this bundle.
 */

/** The selector this header triggers. Omitted by kinds that have nothing to select (events). */
export interface OverlayHeaderSelect {
  rows: OverlaySelectRow[]
  value: string
  onChange: (v: string) => void
  /** the owning overlay's accent color (damage gold / heal green). */
  accent: string
}

const TAIL_COLOR = 'rgba(255,255,255,0.7)'

/** Lock/close, shown when interactive or while a locked overlay has captured the mouse. */
function HeaderControls({
  chrome,
  iconAccentBg
}: {
  chrome: Pick<OverlayChrome, 'locked' | 'hovering' | 'noDrag' | 'toggleLock'>
  iconAccentBg: string
}): JSX.Element | null {
  const { locked, hovering, noDrag, toggleLock } = chrome
  if (locked && !hovering) return null
  return (
    <div style={{ ...noDrag, display: 'flex', alignItems: 'center', gap: 2, marginLeft: 2 }}>
      <IconButton
        title={locked ? 'Unlock (interactive)' : 'Lock (click-through)'}
        onClick={toggleLock}
        accent={locked}
        accentBg={iconAccentBg}
      >
        {locked ? '🔓' : '📌'}
      </IconButton>
      {!locked && (
        <IconButton
          title="Close overlay"
          onClick={() => window.eqOverlay.close()}
          danger
          accentBg={iconAccentBg}
        >
          ✕
        </IconButton>
      )}
    </div>
  )
}

/** Name + (interactive) chevron + the numeric tail. Identical content in both modes. */
function HeaderBody({
  title,
  titleColor,
  tail,
  tailTitle,
  tailColor,
  open
}: {
  title: string
  titleColor: string
  tail: string
  tailTitle?: string
  tailColor: string
  /** null when this header has nothing to open — then no chevron is drawn at all. */
  open: boolean | null
}): JSX.Element {
  return (
    <>
      <span
        style={{
          fontWeight: 700,
          color: titleColor,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flexGrow: 1
        }}
      >
        {title}
      </span>
      {open !== null && (
        <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 9, flexShrink: 0 }}>
          {open ? '▲' : '▼'}
        </span>
      )}
      <span
        title={tailTitle}
        style={{ color: tailColor, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
      >
        {tail}
      </span>
    </>
  )
}

/** The live/idle dot (kinds without a combat state — the event log — pass no `live` at all). */
function LiveDot({ live }: { live: boolean }): JSX.Element {
  return (
    <span
      title={live ? 'In combat' : 'Idle'}
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
        background: live ? '#5fbf72' : 'rgba(255,255,255,0.25)',
        boxShadow: live ? '0 0 5px #5fbf72' : 'none'
      }}
    />
  )
}

/** The small uppercase kind tag, with the finished-fight marker the locked overlay depends on. */
function HeaderTag({ tag, last }: { tag: string; last: boolean }): JSX.Element {
  return (
    <span
      style={{
        fontSize: 8,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        color: 'rgba(255,255,255,0.4)',
        flexShrink: 0
      }}
    >
      {tag}
      {/* The head row is a FINISHED fight (no pull is open). Say so in the tag, because a LOCKED
          overlay has no selector at all — the tag would otherwise read as if this fight were
          still going. */}
      {last && <span style={{ opacity: 0.75 }}> · LAST</span>}
    </span>
  )
}

/**
 * The interactive half: the header's title/tail wrapped as a click target, plus the popup it
 * opens. Anchored to the ROW (not to itself) so the list hangs off the header's bottom edge and
 * spans the window, and marked `no-drag` so the click reaches React instead of moving the window.
 */
function HeaderTrigger({
  select,
  rowRef,
  noDrag,
  children
}: {
  select: OverlayHeaderSelect
  rowRef: ElementRef
  noDrag: React.CSSProperties
  /** the header body, which needs `open` for its chevron. */
  children: (open: boolean) => JSX.Element
}): JSX.Element {
  const triggerRef = useRef<HTMLDivElement>(null)
  // Open state lives HERE, not in the header, so locking the overlay (which unmounts this) can
  // never leave a popup half-open waiting to reappear when the user unlocks again.
  const [open, setOpen] = useState(false)
  const [hot, setHot] = useState(false)
  const current = select.rows.find((r) => r.value === select.value) ?? select.rows[0] ?? null

  return (
    <>
      <div
        ref={triggerRef}
        role="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setHot(true)}
        onMouseLeave={() => setHot(false)}
        // The disambiguation timing the popup rows carry, on the closed state too — the header
        // shows the name, the tooltip says WHICH one.
        title={current ? `${current.label} · ${current.timing}` : undefined}
        style={{
          ...noDrag,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexGrow: 1,
          minWidth: 0,
          padding: '2px 4px',
          borderRadius: 4,
          cursor: 'pointer',
          userSelect: 'none',
          background: open || hot ? HOVER : 'transparent'
        }}
      >
        {children(open)}
      </div>

      {open && (
        <OverlaySelectPopup
          rows={select.rows}
          value={select.value}
          accent={select.accent}
          anchorRef={rowRef}
          triggerRef={triggerRef}
          noDragStyle={noDrag}
          onPick={(v) => {
            select.onChange(v)
            setOpen(false)
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

export function OverlayHeader({
  live,
  tag,
  last = false,
  title,
  titleColor,
  tail,
  tailTitle,
  tailColor = TAIL_COLOR,
  iconAccentBg = ICON_ACCENT_GOLD,
  select,
  chrome
}: {
  /** omit entirely for a kind with no combat state (the event log draws no dot). */
  live?: boolean
  tag: string
  /** the head row is the LAST (finished) fight — never dress it up as live. */
  last?: boolean
  title: string
  titleColor: string
  tail: string
  tailTitle?: string
  tailColor?: string
  iconAccentBg?: string
  select?: OverlayHeaderSelect
  chrome: Pick<OverlayChrome, 'locked' | 'hovering' | 'dragRegion' | 'noDrag' | 'toggleLock'>
}): JSX.Element {
  const { locked, dragRegion, noDrag } = chrome
  const rowRef = useRef<HTMLDivElement>(null)

  // A locked overlay is click-through, and an empty list has nothing to pick: both fall back to
  // the plain header, so no hit-test target and no listeners can leak into those states.
  const selectable = select && !locked && select.rows.length > 0 ? select : null
  const body = (open: boolean | null): JSX.Element => (
    <HeaderBody
      title={title}
      titleColor={titleColor}
      tail={tail}
      tailTitle={tailTitle}
      tailColor={tailColor}
      open={open}
    />
  )

  return (
    <div
      ref={rowRef}
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
      {live !== undefined && <LiveDot live={live} />}
      <HeaderTag tag={tag} last={last} />

      {selectable ? (
        <HeaderTrigger select={selectable} rowRef={rowRef} noDrag={noDrag}>
          {body}
        </HeaderTrigger>
      ) : (
        body(null)
      )}

      <HeaderControls chrome={chrome} iconAccentBg={iconAccentBg} />
    </div>
  )
}
