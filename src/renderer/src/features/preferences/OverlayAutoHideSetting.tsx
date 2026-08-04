// OverlayAutoHideSetting — Preferences → Overlays.
//
// Two independent switches over one question: when should the floating meters get out of the
// way? They are deliberately NOT one three-state mode, because they are not two points on a
// scale — "don't leave meters floating over my desktop when I'm not playing" is housekeeping
// almost everyone wants, while "vanish every time I alt-tab" is a taste many people actively
// don't share (you alt-tab TO read the numbers).
//
// STATE, NEVER PROCESS (the repo's UI law): the captions say what happens and what the current
// setting means. Nothing here mentions the watcher, the poll, or the process check — the user
// asked for overlays that behave, not for a description of how the app looks at Windows.
//
// ONE BORDER: PreferencesView already wraps each item in an outlined Paper, so this renders bare
// Stacks — a Paper here would draw a second frame inside the first.
//
// HIDE, NEVER CLOSE, and the copy says so: an auto-hidden overlay keeps its position, its lock
// state and its drill-down, and the TitleBar menu still lists it as open. That is the difference
// between a setting and a surprise.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { FormControlLabel, Stack, Switch, Typography } from '@mui/material'
import { type OverlayAutoHidePrefs, DEFAULT_OVERLAY_AUTO_HIDE } from '@shared/presencePrefs'

/**
 * The prefs blob, hydrated once from main and written back on every change — the VoiceSetting
 * pattern exactly. Writes are optimistic locally (a switch must not lag an IPC round trip) and
 * authoritative from main's reply, which is what was actually stored.
 */
function useOverlayAutoHide(): [OverlayAutoHidePrefs, (patch: Partial<OverlayAutoHidePrefs>) => void] {
  const [prefs, setPrefs] = useState<OverlayAutoHidePrefs>(DEFAULT_OVERLAY_AUTO_HIDE)

  useEffect(() => {
    let alive = true
    void window.eq.getOverlayAutoHide().then((stored) => {
      if (alive) setPrefs(stored)
    })
    return () => {
      alive = false
    }
  }, [])

  const update = useCallback((patch: Partial<OverlayAutoHidePrefs>) => {
    setPrefs((cur) => ({ ...cur, ...patch }))
    void window.eq.setOverlayAutoHide(patch).then(setPrefs)
  }, [])

  return [prefs, update]
}

export function OverlayAutoHideSetting(): JSX.Element {
  const [prefs, update] = useOverlayAutoHide()
  return (
    <Stack spacing={2} data-testid="pref-overlay-autohide">
      <Stack spacing={0.5}>
        <FormControlLabel
          control={
            <Switch
              size="small"
              data-testid="pref-hide-when-not-running"
              checked={prefs.hideWhenNotRunning}
              onChange={(e) => update({ hideWhenNotRunning: e.target.checked })}
            />
          }
          label={<Typography variant="body2">Hide overlays when EverQuest isn’t running</Typography>}
        />
        <Typography variant="caption" color="text.secondary">
          {prefs.hideWhenNotRunning
            ? 'Your open overlays disappear while the game is closed and come back when it starts. They keep their position, size and lock — nothing is closed.'
            : 'Off. Open overlays stay on screen whether or not the game is running.'}
        </Typography>
      </Stack>

      <Stack spacing={0.5}>
        <FormControlLabel
          control={
            <Switch
              size="small"
              data-testid="pref-hide-when-unfocused"
              checked={prefs.hideWhenUnfocused}
              onChange={(e) => update({ hideWhenUnfocused: e.target.checked })}
            />
          }
          label={<Typography variant="body2">Hide overlays when you’re not in EverQuest</Typography>}
        />
        <Typography variant="caption" color="text.secondary">
          {prefs.hideWhenUnfocused
            ? 'Your open overlays disappear while another app is in front. This app’s own windows don’t count — clicking an overlay, or the main window, keeps them up.'
            : 'Off. Open overlays stay on screen while you work in other apps.'}
        </Typography>
      </Stack>
    </Stack>
  )
}
