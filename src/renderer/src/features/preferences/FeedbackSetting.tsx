// FeedbackSetting — the Preferences card that opens the feedback dialog (Task #65, §4.4).
//
// Its own file for the same reason UpdateSetting.tsx is: PreferencesView.tsx is the settings
// TABLE, and a section's actual UI lives beside it rather than inside it.
//
// Feedback is a DIALOG, not a view (appViews.ts is untouched), so this card owns no state — it
// only calls up to App.tsx, which hosts the dialog. Two buttons rather than one because TYPE is
// the first thing the dialog asks, and a user who came here to report a problem already knows.

import type { JSX } from 'react'
import { Button, Stack, Typography } from '@mui/material'
import BugReportIcon from '@mui/icons-material/BugReport'
import LightbulbIcon from '@mui/icons-material/Lightbulb'
import type { FeedbackPrefill } from '../feedback/useFeedback'

/** Opens the app-level feedback dialog, optionally preselecting a type. */
export type OpenFeedback = (prefill?: FeedbackPrefill) => void

export function FeedbackSetting({ onSend }: { onSend: OpenFeedback }): JSX.Element {
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} flexWrap="wrap">
        <Button
          size="small"
          variant="outlined"
          startIcon={<LightbulbIcon />}
          data-testid="prefs-feedback-feature"
          onClick={() => onSend({ type: 'feature' })}
        >
          Request a feature
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={<BugReportIcon />}
          data-testid="prefs-feedback-bug"
          onClick={() => onSend({ type: 'bug' })}
        >
          Report a problem
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        A bug report can attach a scrubbed slice of your EverQuest log — chat, tells, group and
        /who lines are removed, and you read every line that remains before it leaves the machine.
      </Typography>
    </Stack>
  )
}
