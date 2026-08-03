import { type JSX, useEffect, useRef, useState } from 'react'

/**
 * The overlay's segment/session selector.
 *
 * WHY IT IS NOT A `<select>`: a native select paints its popup with the OS widget — an opaque
 * white list in a system font, with one flat line per option — dropped on top of a dark,
 * translucent, 11px meter. It also cannot carry the dense two-line disambiguation row (name +
 * rate on top, start clock · age · duration underneath) that tells five same-named giant pulls
 * apart. This is the same list rendered with the meter's own chrome: the panel background, the
 * bars' hairline borders, tabular-num rates and the same hover wash the bar rows use.
 *
 * MUI-FREE ON PURPOSE: the overlay is its own renderer entry (overlay.html) with no theme and no
 * component library — every pixel here is plain React + inline styles, exactly like Bar/IconButton
 * in OverlayMeter. Do not import @mui/* into this bundle.
 *
 * INTERACTIVE MODE ONLY: a locked overlay is fully click-through, so callers simply do not render
 * this. It owns no click-through state itself — there is nothing here that could leak a hit-test
 * target into locked mode.
 */

export interface OverlaySelectRow {
  /** the selection value handed back to `onChange`. */
  value: string
  /** main line, left. */
  label: string
  /** main line, right — a formatted rate. */
  rate: string
  /** dim second line: the disambiguation timing (start clock · age · duration). */
  timing: string
  /** genuinely live right now — gets the pulsing accent dot. */
  live: boolean
}

/** Shared chrome tokens so the trigger, the popup and the meter agree. */
const PANEL_BG = 'rgba(18,22,28,0.97)'
const HAIRLINE = 'rgba(255,255,255,0.12)'
const HOVER = 'rgba(255,255,255,0.08)'

/**
 * The closed-state trigger: live dot · label · rate · caret, in the meter's own chrome.
 * `current` is null only when there is nothing to select at all, which is also the
 * disabled state.
 */
function SelectTrigger({
  current,
  open,
  disabled,
  accent,
  emptyLabel,
  onToggle
}: {
  current: OverlaySelectRow | null
  open: boolean
  disabled: boolean
  accent: string
  emptyLabel: string
  onToggle: () => void
}): JSX.Element {
  return (
    <div
      role="button"
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={() => !disabled && onToggle()}
      title={current ? `${current.label} · ${current.rate} · ${current.timing}` : emptyLabel}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 20,
        padding: '0 6px',
        borderRadius: 4,
        border: `1px solid ${open ? accent : HAIRLINE}`,
        background: open ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.32)',
        color: '#f2f2f2',
        fontSize: 11,
        lineHeight: 1,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        userSelect: 'none'
      }}
    >
      {current?.live && (
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: accent, flexShrink: 0 }} />
      )}
      <span style={{ flexGrow: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {current ? current.label : emptyLabel}
      </span>
      {current && (
        <span style={{ color: 'rgba(255,255,255,0.6)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
          {current.rate}
        </span>
      )}
      <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 9, flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
    </div>
  )
}

/** One popup row: the dense two-line disambiguation the native widget could never carry. */
function OptionRow({
  row,
  selected,
  hovered,
  accent,
  onHover,
  onPick
}: {
  row: OverlaySelectRow
  selected: boolean
  hovered: boolean
  accent: string
  onHover: (hovering: boolean) => void
  onPick: () => void
}): JSX.Element {
  return (
    <div
      role="option"
      aria-selected={selected}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onClick={onPick}
      style={{
        padding: '3px 6px',
        borderRadius: 3,
        cursor: 'pointer',
        // The selected row keeps a full-height accent stripe — the same device the
        // drill-down bars use for a category — so it reads without a checkmark glyph.
        borderLeft: `2px solid ${selected ? accent : 'transparent'}`,
        background: hovered ? HOVER : selected ? 'rgba(255,255,255,0.045)' : 'transparent'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11, lineHeight: 1.25 }}>
        {row.live && (
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: accent, flexShrink: 0 }} />
        )}
        <span
          style={{
            flexGrow: 1,
            minWidth: 0,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {row.label}
        </span>
        <span style={{ color: 'rgba(255,255,255,0.62)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
          {row.rate}
        </span>
      </div>
      <div
        style={{
          fontSize: 9.5,
          lineHeight: 1.3,
          color: 'rgba(255,255,255,0.42)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {row.timing}
      </div>
    </div>
  )
}

export function OverlaySelect({
  rows,
  value,
  onChange,
  accent,
  emptyLabel,
  noDragStyle
}: {
  rows: OverlaySelectRow[]
  value: string
  onChange: (v: string) => void
  /** the owning overlay's accent color (damage gold / heal green). */
  accent: string
  /** shown on the trigger when there is nothing to select at all. */
  emptyLabel: string
  /** the caller's `WebkitAppRegion: 'no-drag'` style — the popup must not become a drag handle. */
  noDragStyle?: React.CSSProperties
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const current = rows.find((r) => r.value === value) ?? rows[0] ?? null

  // Close on outside click / Esc. Both are registered only while open, so a closed selector
  // costs nothing and the locked (click-through) overlay never installs a listener at all.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const disabled = rows.length === 0

  return (
    <div ref={wrapRef} style={{ ...noDragStyle, position: 'relative', padding: '4px 8px 2px', flexShrink: 0 }}>
      <SelectTrigger
        current={current}
        open={open}
        disabled={disabled}
        accent={accent}
        emptyLabel={emptyLabel}
        onToggle={() => setOpen((o) => !o)}
      />

      {open && !disabled && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            left: 8,
            right: 8,
            top: '100%',
            zIndex: 20,
            maxHeight: 220,
            overflowY: 'auto',
            background: PANEL_BG,
            border: `1px solid ${HAIRLINE}`,
            borderRadius: 5,
            boxShadow: '0 6px 18px rgba(0,0,0,0.55)',
            padding: 2
          }}
        >
          {rows.map((r) => (
            <OptionRow
              key={r.value}
              row={r}
              selected={r.value === value}
              hovered={hover === r.value}
              accent={accent}
              onHover={(hovering) =>
                setHover((h) => (hovering ? r.value : h === r.value ? null : h))
              }
              onPick={() => {
                onChange(r.value)
                setOpen(false)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
