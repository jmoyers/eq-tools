// TelemetrySetting — Preferences → Usage analytics (docs/plans/usage-analytics.md T3 + T4).
//
// Three controls and one window onto the truth:
//
//   * THE SWITCH. Off stops collection AND drops everything already buffered, immediately. The
//     caption says so, because a switch that quietly left 500 events on disk would be lying.
//   * ROTATE. A new anonymous id, and the buffer goes with it. That deliberately severs the
//     retention chain — a rotated id is a brand-new cohort member, which is a real cost and is
//     stated rather than buried.
//   * THE PAYLOAD VIEWER (T4: "show the payload"). The live buffer and the last batch sent, as
//     JSON, verbatim. Not a summary of it, not a description of it — the bytes. It is the only
//     claim about privacy that a user can check for themselves, which is why it exists.
//
// AND IT IS HONEST ABOUT BEING DARK. This build has no endpoint compiled in, so "last batch
// sent" will be empty forever, and the pane SAYS that rather than rendering an empty box the
// user has to interpret. When wave A2 lights the endpoint, `endpointConfigured` flips and this
// copy changes with it — the component reads the fact, it does not assume it.
//
// ONE BORDER: PreferencesView wraps each item in an outlined Paper, so this renders bare Stacks.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { Box, Button, FormControlLabel, Stack, Switch, Typography } from '@mui/material'
import type { TelemetryPayloadView } from '@shared/telemetry'

/** Poll cadence while the pane is open — the buffer grows from main, which has no push channel
 *  for it (and should not gain one for a settings pane nobody watches for minutes). */
const REFRESH_MS = 4_000

function usePayload(): [TelemetryPayloadView | null, () => void] {
  const [payload, setPayload] = useState<TelemetryPayloadView | null>(null)

  const refresh = useCallback((): void => {
    void window.eq.getTelemetryPayload().then(setPayload)
  }, [])

  useEffect(() => {
    let alive = true
    const read = (): void => {
      void window.eq.getTelemetryPayload().then((p) => {
        if (alive) setPayload(p)
      })
    }
    read()
    const timer = setInterval(read, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  return [payload, refresh]
}

/** A scrolling, fixed-height JSON box. AGENTS.md UI law: a GROWING list lives in a FIXED-height
 *  scroll box — a 500-event buffer rendered at its natural height would own the whole pane. */
function JsonBox({ value, testId }: { value: unknown; testId: string }): JSX.Element {
  return (
    <Box
      data-testid={testId}
      component="pre"
      sx={{
        m: 0,
        p: 1,
        maxHeight: 220,
        overflow: 'auto',
        fontSize: 11,
        lineHeight: 1.45,
        borderRadius: 1,
        bgcolor: 'action.hover',
        color: 'text.secondary',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word'
      }}
    >
      {JSON.stringify(value, null, 2)}
    </Box>
  )
}

/** The live ring: what would go out on the next batch, exactly as it is held. */
function BufferPanel({ payload }: { payload: TelemetryPayloadView }): JSX.Element {
  const n = payload.buffered.length
  return (
    <Stack spacing={0.75}>
      <Typography variant="subtitle2">Waiting to be sent ({n})</Typography>
      {n === 0 ? (
        <Typography variant="caption" color="text.secondary" data-testid="telemetry-buffer-empty">
          Nothing is buffered right now.
        </Typography>
      ) : (
        <JsonBox testId="telemetry-buffer" value={payload.buffered} />
      )}
    </Stack>
  )
}

/** The last batch that actually left the machine. Permanently absent while the build is dark. */
function LastSentPanel({ payload }: { payload: TelemetryPayloadView }): JSX.Element {
  if (payload.lastBatch !== null) {
    return (
      <Stack spacing={0.75}>
        <Typography variant="subtitle2">Last batch sent</Typography>
        <JsonBox testId="telemetry-last-batch" value={payload.lastBatch} />
      </Stack>
    )
  }
  return (
    <Stack spacing={0.75}>
      <Typography variant="subtitle2">Last batch sent</Typography>
      <Typography variant="caption" color="text.secondary" data-testid="telemetry-last-batch-empty">
        {payload.endpointConfigured
          ? 'Nothing has been sent yet.'
          : 'Nothing, and nothing ever will be from this build — it has no analytics endpoint compiled in, and there is no code in it that could send one. This panel exists so that when that changes, you can read exactly what left.'}
      </Typography>
    </Stack>
  )
}

/** The id + the rotate action. The cost of rotating is stated, not buried. */
function IdentityRow({
  payload,
  onRotate
}: {
  payload: TelemetryPayloadView
  onRotate: () => void
}): JSX.Element {
  return (
    <Stack spacing={0.5}>
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="caption" color="text.secondary" data-testid="telemetry-id">
          Anonymous id: {payload.prefs.analyticsId ?? 'none yet'}
        </Typography>
        <Button size="small" data-testid="telemetry-rotate" onClick={onRotate}>
          Use a new id
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        A random id made on your machine, and deliberately not the one a bug report uses — the
        two can’t be joined. Replacing it also throws away everything buffered, and looks like a
        brand-new install from then on.
      </Typography>
    </Stack>
  )
}

export function TelemetrySetting(): JSX.Element {
  const [payload, refresh] = usePayload()

  const setEnabled = useCallback(
    (enabled: boolean): void => {
      void window.eq.setTelemetryEnabled(enabled).then(refresh)
    },
    [refresh]
  )
  const rotate = useCallback((): void => {
    void window.eq.rotateAnalyticsId().then(refresh)
  }, [refresh])

  if (payload === null) return <Typography variant="body2">Loading…</Typography>

  const enabled = payload.prefs.enabled
  return (
    <Stack spacing={2} data-testid="pref-telemetry">
      <Stack spacing={0.5}>
        <FormControlLabel
          control={
            <Switch
              size="small"
              data-testid="pref-telemetry-enabled"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked)
              }}
            />
          }
          label={<Typography variant="body2">Send anonymous usage counts</Typography>}
        />
        <Typography variant="caption" color="text.secondary">
          {enabled
            ? 'Counts only, from a fixed list of events — never your character names, zones, chat, searches or log lines. There is no field in what’s sent that could hold them.'
            : 'Off. Nothing is collected. Everything that had been buffered — and the random id itself — was thrown away the moment you switched it off; turning it back on starts from empty with a new one.'}
        </Typography>
      </Stack>

      {enabled && <IdentityRow payload={payload} onRotate={rotate} />}

      <Stack spacing={1.5}>
        <BufferPanel payload={payload} />
        <LastSentPanel payload={payload} />
      </Stack>
    </Stack>
  )
}
