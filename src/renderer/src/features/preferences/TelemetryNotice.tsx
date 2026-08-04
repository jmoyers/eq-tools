// TelemetryNotice — the first-run usage-analytics notice (docs/plans/usage-analytics.md T1).
//
// THE ONE THING THIS COMPONENT IS FOR: nothing may ever be transmitted before a user has been
// TOLD. Analytics is opt-OUT here (the owner's decision, taken over the integrator's opt-in
// recommendation), and opt-out is only honest if the telling comes first. So the network gate in
// main (`telemetryFlushEnabled`) requires `noticeShown`, and this bar is the only thing that
// sets it.
//
// IT IS A SLIM BOTTOM BAR, NOT A MODAL (T1 amended 2026-08-04 by the owner). The first thing a
// new user meets should be the app, not a consent wall — so this is one sentence and three
// controls along the bottom edge, and the explanation lives where someone who wants it will
// look for it: Preferences → Usage analytics, and TELEMETRY.md. A modal that has to be read
// before the app can be used buys agreement, not understanding.
//
// THE RULES IT OBEYS, each of which is a way this pattern is usually done badly:
//
//   * OPT OUT IS A BUTTON, not a footnote. "Details" is the small link; the action that costs
//     the app something is the one rendered plainly.
//   * DISMISSAL KEEPS IT ON. That is what opt-out means, and it is the same answer as
//     "Details" — both mark the notice shown and leave collection running.
//   * IT IS SHOWN ONCE, EVER — the flag flips on every one of the three exits, so a user who
//     opts out is not asked again either.
//   * IT DOES NOT MOVE THE APP. A Snackbar is fixed-position and portalled, so the bar floats
//     over the bottom of the content area: no reflow, and nothing above it (title bar, nav,
//     the separate overlay windows) is touched.
//
// Mounted from App.tsx, unconditionally: it reads the prefs itself and renders nothing at all
// once `noticeShown` is true, which is every launch after the first.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { Button, IconButton, Link, Paper, Snackbar, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'

export function TelemetryNotice({ onOpenDetails }: { onOpenDetails: () => void }): JSX.Element | null {
  // `null` = not asked yet. The bar must not flash open for the ~1 frame before main answers.
  const [show, setShow] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    void window.eq.getTelemetryPrefs().then((prefs) => {
      if (alive) setShow(!prefs.noticeShown)
    })
    return () => {
      alive = false
    }
  }, [])

  const answer = useCallback((keepEnabled: boolean): void => {
    setShow(false)
    void window.eq.telemetryNoticeShown(keepEnabled)
  }, [])

  if (show !== true) return null

  return (
    <Snackbar
      open
      // No autoHideDuration: a notice that vanishes on its own was never shown to a user who
      // looked away. It closes when the user closes it.
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      sx={{ left: 16, right: 16, bottom: 16, transform: 'none' }}
    >
      <Paper
        elevation={6}
        sx={{ px: 2, py: 1, width: '100%', display: 'flex', alignItems: 'center', gap: 1.5 }}
        data-testid="telemetry-notice"
      >
        <Typography variant="body2" sx={{ flexGrow: 1, minWidth: 0 }} data-testid="telemetry-notice-text">
          We collect completely anonymous usage data.
        </Typography>

        <Button
          size="small"
          variant="outlined"
          color="inherit"
          data-testid="telemetry-notice-off"
          onClick={() => {
            answer(false)
          }}
        >
          Opt out
        </Button>

        {/* Reading the details is not consenting to anything new — it keeps the default, like
            dismissal does, and marks the question asked. */}
        <Link
          component="button"
          type="button"
          variant="caption"
          color="text.secondary"
          data-testid="telemetry-notice-details"
          onClick={() => {
            answer(true)
            onOpenDetails()
          }}
        >
          Details
        </Link>

        <IconButton
          size="small"
          aria-label="Dismiss — keeps anonymous usage data on"
          data-testid="telemetry-notice-dismiss"
          onClick={() => {
            answer(true)
          }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Paper>
    </Snackbar>
  )
}
