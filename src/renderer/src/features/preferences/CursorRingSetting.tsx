// CursorRingSetting — Preferences → Cursor ring.
//
// A thick white circle that follows the mouse, drawn ONLY over the EverQuest window (owner
// request: "I lose my mouse on EQ screens"). Off by default; the toggle is the only thing that
// makes it exist.
//
// THE NOTE ABOUT SCOPE IS NOT DECORATION. "Only over EverQuest" is the single most surprising
// thing about this feature — a user who turns it on while reading Preferences sees nothing
// happen, and without that line would reasonably conclude it is broken. It states WHERE the
// ring is, which is state, not process.
//
// The sliders are live: main pushes the new size/thickness to the ring window on every write,
// so dragging one resizes the halo under the pointer instead of on the next restart.
//
// ONE BORDER: PreferencesView wraps each item in an outlined Paper, so this renders bare Stacks.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { FormControlLabel, Slider, Stack, Switch, Typography } from '@mui/material'
import {
  type CursorRingPrefs,
  DEFAULT_CURSOR_RING,
  MAX_RING_SIZE_PX,
  MAX_RING_THICKNESS_PX,
  MIN_RING_SIZE_PX,
  MIN_RING_THICKNESS_PX
} from '@shared/presencePrefs'

/** Hydrate once from main, write back on every change; main's reply is authoritative (every
 *  field is re-clamped there, so a slider at the cap visibly stops instead of drifting). */
function useCursorRing(): [CursorRingPrefs, (patch: Partial<CursorRingPrefs>) => void] {
  const [prefs, setPrefs] = useState<CursorRingPrefs>(DEFAULT_CURSOR_RING)

  useEffect(() => {
    let alive = true
    void window.eq.getCursorRing().then((stored) => {
      if (alive) setPrefs(stored)
    })
    return () => {
      alive = false
    }
  }, [])

  const update = useCallback((patch: Partial<CursorRingPrefs>) => {
    setPrefs((cur) => ({ ...cur, ...patch }))
    void window.eq.setCursorRing(patch).then(setPrefs)
  }, [])

  return [prefs, update]
}

/** A small live sample of the ring, so the sliders describe something you can see without
 *  alt-tabbing into the game. Same three shadows as the real thing (cursor.html). */
function RingPreview({ prefs }: { prefs: CursorRingPrefs }): JSX.Element {
  return (
    <div
      data-testid="pref-cursor-ring-preview"
      style={{
        width: prefs.sizePx,
        height: prefs.sizePx,
        boxSizing: 'border-box',
        borderRadius: '50%',
        borderStyle: 'solid',
        borderWidth: prefs.thicknessPx,
        borderColor: 'rgba(255,255,255,0.9)',
        boxShadow:
          '0 0 0 1px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(0,0,0,0.6), 0 0 14px 4px rgba(0,0,0,0.28)',
        flexShrink: 0
      }}
    />
  )
}

/** Size + stroke. Both are whole px and both are clamped in main; the labels state the value so
 *  the cap is legible rather than felt. */
function RingSliders({
  prefs,
  onChange
}: {
  prefs: CursorRingPrefs
  onChange: (patch: Partial<CursorRingPrefs>) => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap" useFlexGap>
      <Stack sx={{ minWidth: 180 }}>
        <Typography variant="caption" color="text.secondary">
          Size ({prefs.sizePx}px)
        </Typography>
        <Slider
          size="small"
          data-testid="pref-cursor-ring-size"
          min={MIN_RING_SIZE_PX}
          max={MAX_RING_SIZE_PX}
          step={2}
          value={prefs.sizePx}
          onChange={(_e, v) => onChange({ sizePx: v as number })}
          sx={{ width: 160 }}
        />
      </Stack>
      <Stack sx={{ minWidth: 180 }}>
        <Typography variant="caption" color="text.secondary">
          Thickness ({prefs.thicknessPx}px)
        </Typography>
        <Slider
          size="small"
          data-testid="pref-cursor-ring-thickness"
          min={MIN_RING_THICKNESS_PX}
          max={MAX_RING_THICKNESS_PX}
          step={1}
          value={prefs.thicknessPx}
          onChange={(_e, v) => onChange({ thicknessPx: v as number })}
          sx={{ width: 160 }}
        />
      </Stack>
    </Stack>
  )
}

export function CursorRingSetting(): JSX.Element {
  const [prefs, update] = useCursorRing()
  return (
    <Stack spacing={2} data-testid="pref-cursor-ring">
      <Stack spacing={0.5}>
        <FormControlLabel
          control={
            <Switch
              size="small"
              data-testid="pref-cursor-ring-enabled"
              checked={prefs.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
            />
          }
          label={<Typography variant="body2">Show a ring around your mouse cursor</Typography>}
        />
        <Typography variant="caption" color="text.secondary">
          {prefs.enabled
            ? 'A white ring follows your pointer so you can find it on a busy screen. Your real cursor is untouched — the ring never gets in the way of a click.'
            : 'Off. Nothing is drawn and nothing is tracked.'}
        </Typography>
      </Stack>

      <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap" useFlexGap>
        <RingSliders prefs={prefs} onChange={update} />
        <RingPreview prefs={prefs} />
      </Stack>

      <Typography variant="caption" color="text.secondary">
        The ring only appears over EverQuest, while the game is the window you’re in.
      </Typography>
    </Stack>
  )
}
