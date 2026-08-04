// TelemetryNotice — the first-run usage-analytics notice (docs/plans/usage-analytics.md T1).
//
// THE ONE THING THIS COMPONENT IS FOR: nothing may ever be transmitted before a user has been
// TOLD. Analytics is opt-OUT here (the owner's decision, taken over the integrator's opt-in
// recommendation), and opt-out is only honest if the telling comes first. So the network gate in
// main (`telemetryFlushEnabled`) requires `noticeShown`, and this modal is the only thing that
// sets it.
//
// THE RULES IT OBEYS, each of which is a way this pattern is usually done badly:
//
//   * EQUAL PROMINENCE. "Keep it on" and "Turn it off" are the same size, the same variant and
//     the same colour. No primary/secondary, no colour-coded "recommended".
//   * NOTHING IS PRE-CHECKED, because there is nothing to check: two buttons, no form.
//   * DISMISSAL KEEPS IT ON, and the modal says so out loud rather than letting a click on the
//     backdrop mean something the user did not read. That is what opt-out means; hiding it
//     would be the dishonest half of the design.
//   * IT IS SHOWN ONCE, EVER — and the flag flips whichever button is pressed, so a user who
//     turns it off is not asked again either.
//   * IT STATES WHAT IS COLLECTED IN PLAIN WORDS, using the same sentences as TELEMETRY.md
//     (the generated doc is the contract; this is its short form). "State, never process."
//
// Mounted from App.tsx, unconditionally: it reads the prefs itself and renders nothing at all
// once `noticeShown` is true, which is every launch after the first.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material'

/** What the app measures, in the same words as TELEMETRY.md's summary. */
const COLLECTED = [
  'Which tabs you open and how long you stay on them.',
  'Which features you use, as counts — never what you searched for or typed.',
  'How long the app runs, whether it started cleanly, and how many alerts fired.',
  'The shape of your setup as RANGES, not numbers: "1 character", "100–512 MB of log".'
]

const NEVER = [
  'character, server, guild, zone, mob, spell or item names',
  'anything you type — chat, tells, search boxes, alert names',
  'any line of your log, or any file path'
]

export function TelemetryNotice(): JSX.Element | null {
  // `null` = not asked yet. The modal must not flash open for the ~1 frame before main answers.
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
    <Dialog
      open
      maxWidth="sm"
      fullWidth
      // A backdrop/Escape close is a real answer here, and it is the one the copy names: keep
      // it on. `onClose` therefore does exactly what the "Keep it on" button does.
      onClose={() => {
        answer(true)
      }}
      data-testid="telemetry-notice"
    >
      <DialogTitle sx={{ fontWeight: 700 }}>Anonymous usage counts</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <Typography variant="body2">
            This app can send anonymous counts about how it is used, so the things people
            actually use get the attention — and the things that break get found. It is on by
            default. You can change it any time in Preferences → Usage analytics, where you can
            also read the exact events waiting to be sent.
          </Typography>

          <Typography variant="subtitle2">What it measures</Typography>
          <Stack component="ul" spacing={0.25} sx={{ pl: 2.5, m: 0 }}>
            {COLLECTED.map((line) => (
              <Typography key={line} component="li" variant="body2" color="text.secondary">
                {line}
              </Typography>
            ))}
          </Stack>

          <Typography variant="subtitle2">What it can never contain</Typography>
          <Typography variant="body2" color="text.secondary">
            Not by policy — by shape. There is no free-text field anywhere in what is sent, so
            there is nowhere for {NEVER.join('; ')} to go. It is identified only by a random id
            that you can replace at any time, and that is deliberately not the same id a bug
            report uses.
          </Typography>

          <Typography variant="caption" color="text.secondary" data-testid="telemetry-notice-dark">
            This build has no endpoint compiled in, so nothing is being sent anywhere at all
            today. Everything it records stays on your machine, and Preferences shows it to you.
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Closing this window keeps it on.
          </Typography>
        </Stack>
      </DialogContent>
      {/* Equal prominence, deliberately: same size, same variant, same colour, no default. */}
      <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
        <Button
          size="medium"
          variant="outlined"
          color="inherit"
          data-testid="telemetry-notice-off"
          onClick={() => {
            answer(false)
          }}
        >
          Turn it off
        </Button>
        <Button
          size="medium"
          variant="outlined"
          color="inherit"
          data-testid="telemetry-notice-on"
          onClick={() => {
            answer(true)
          }}
        >
          Keep it on
        </Button>
      </DialogActions>
    </Dialog>
  )
}
