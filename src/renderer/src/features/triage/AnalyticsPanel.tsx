// ============================================================================
// AnalyticsPanel — honestly empty, and specific about why.
// ============================================================================
//
// NO ZEROS. Usage analytics does not exist yet: `docs/plans/usage-analytics.md` wave A1 is the
// client half and A2 is the infra that would give this panel a table to read, and neither is
// built. A dashboard of zeros is indistinguishable from "nobody used the app", so this panel
// says what is true — nothing is collected, there is no table — and then shows the SHAPE it
// will consume, so the panel and the schema are designed against each other before either
// ships. That is the same discipline the feedback dialog used while F1 shipped dark.

import type { JSX } from 'react'
import { useCallback } from 'react'
import { Alert, AlertTitle, Box, CircularProgress, Stack, Typography } from '@mui/material'
import type { TriageAnalytics } from '@shared/triage'
import { useTriageCall } from './useTriage'

/** The fields `TriageAnalyticsData` promises, written out so A2 has a target to hit. */
const SHAPE: { field: string; meaning: string }[] = [
  { field: 'windowDays', meaning: 'the reporting window this roll-up covers' },
  { field: 'installs', meaning: 'distinct analyticsIds seen in the window' },
  { field: 'sessions', meaning: 'app launches, not hours' },
  { field: 'byVersion[]', meaning: 'installs per appVersion — how fast an update actually lands' },
  { field: 'byPlatform[]', meaning: 'installs per platform string' },
  { field: 'byFeature[]', meaning: 'opens per allowlisted feature id — never free-form strings' }
]

export default function AnalyticsPanel(): JSX.Element {
  const run = useCallback(() => window.eq.triageAnalytics(), [])
  const analytics = useTriageCall<TriageAnalytics>(run)

  if (analytics.loading) return <CircularProgress size={20} />
  if (analytics.error) return <Alert severity="error">{analytics.error}</Alert>
  if (analytics.data?.available === true) {
    // The arm that lands with A2. Until then this is unreachable and deliberately not
    // pre-built: a panel written against a schema nobody has produced a row for is fiction.
    return (
      <Typography variant="body2" data-testid="triage-analytics">
        {analytics.data.data.installs.toLocaleString()} installs over the last{' '}
        {analytics.data.data.windowDays.toLocaleString()} days.
      </Typography>
    )
  }

  return (
    <Stack spacing={2} data-testid="triage-analytics">
      <Alert severity="info">
        <AlertTitle>Nothing is collected yet</AlertTitle>
        {analytics.data?.reason ??
          'Usage analytics lands with telemetry wave A2 (docs/plans/usage-analytics.md).'}
      </Alert>
      <Stack spacing={0.5}>
        <Typography variant="subtitle2">What this panel will read</Typography>
        <Typography variant="caption" color="text.secondary">
          Table <code>{analytics.data?.table ?? 'usage_daily'}</code> — an allowlisted, opt-out
          roll-up keyed on a rotatable analyticsId that is deliberately NOT the feedback installId.
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 2, rowGap: 0.25, mt: 1 }}>
          {SHAPE.map((s) => (
            <Box key={s.field} sx={{ display: 'contents' }}>
              <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                {s.field}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {s.meaning}
              </Typography>
            </Box>
          ))}
        </Box>
      </Stack>
    </Stack>
  )
}
