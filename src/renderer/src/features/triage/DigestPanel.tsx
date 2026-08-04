// ============================================================================
// DigestPanel — the CLI's digest, rendered.
// ============================================================================
//
// SAME DATA, SAME FUNCTION, SAME NUMBERS as `npx tsx scripts/triage-feedback.mts digest`: main
// calls `renderDigest` from scripts/triageCluster.mts over rows sorted by reportId. That sort
// is why the cluster ids here match the ones the CLI printed — reportId is a ULID, so sorting
// by it is sorting by mint time, and `clusterReports` derives each id from its first member.
//
// The markdown is shown as MONOSPACE TEXT, not parsed into rich HTML. It is a brief written to
// be read whole and handed to a model verbatim; re-styling it would only make it differ from
// what the CLI shows. The clusters are ALSO rendered as rows, because "which clusters are
// regressions" is the one question that deserves a chip rather than a sentence.

import { type JSX, useCallback, useState } from 'react'
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  MenuItem,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import {
  TRIAGE_DEFAULT_QUERY,
  TRIAGE_SINCE_CHOICES,
  type TriageClusterView,
  type TriageDigest,
  type TriageListQuery
} from '@shared/triage'
import { useTriageCall } from './useTriage'

const MARKDOWN_HEIGHT = 300

function ClusterRow({ cluster }: { cluster: TriageClusterView }): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
      <Chip size="small" label={cluster.id} variant="outlined" />
      <Chip
        size="small"
        label={cluster.kind}
        color={cluster.kind === 'crash' ? 'error' : 'default'}
        variant="outlined"
      />
      <Typography variant="caption" color="text.secondary">
        {cluster.reportIds.length.toLocaleString()} reports · {cluster.withLogs.toLocaleString()} with logs
      </Typography>
      {cluster.regression && (
        <Chip size="small" color="warning" label={`regression on ${cluster.versions[0]}`} />
      )}
      <Typography variant="body2" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {cluster.label}
      </Typography>
      {cluster.signature !== undefined && (
        <Typography variant="caption" sx={{ fontFamily: 'monospace' }} color="text.secondary">
          {cluster.signature}
        </Typography>
      )}
    </Stack>
  )
}

export default function DigestPanel(): JSX.Element {
  const [query, setQuery] = useState<TriageListQuery>({ ...TRIAGE_DEFAULT_QUERY, since: '7d' })
  const run = useCallback(() => window.eq.triageDigest(query), [query])
  const digest = useTriageCall<TriageDigest>(run)

  return (
    <Stack spacing={2} data-testid="triage-digest">
      <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap">
        <TextField
          select
          size="small"
          label="Since"
          value={query.since}
          onChange={(e) => setQuery({ ...query, since: e.target.value })}
          sx={{ minWidth: 100 }}
        >
          {TRIAGE_SINCE_CHOICES.map((s) => (
            <MenuItem key={s} value={s}>
              {s}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Channel"
          value={query.channel}
          onChange={(e) => setQuery({ ...query, channel: e.target.value as TriageListQuery['channel'] })}
          sx={{ minWidth: 110 }}
        >
          {(['all', 'prod', 'dev'] as const).map((c) => (
            <MenuItem key={c} value={c}>
              {c}
            </MenuItem>
          ))}
        </TextField>
        {digest.loading && <CircularProgress size={18} />}
      </Stack>

      {digest.error && <Alert severity="error">{digest.error}</Alert>}

      {digest.data && (
        <>
          <Stack spacing={0.5}>
            <Typography variant="subtitle2">
              Clusters ({digest.data.clusters.length.toLocaleString()} over{' '}
              {digest.data.reportCount.toLocaleString()} reports)
            </Typography>
            {digest.data.clusters.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                Nothing clusters in this window — every report is on its own.
              </Typography>
            ) : (
              digest.data.clusters.map((c) => <ClusterRow key={c.id} cluster={c} />)
            )}
          </Stack>

          <Box
            data-testid="triage-digest-markdown"
            sx={{
              height: MARKDOWN_HEIGHT,
              overflow: 'auto',
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              bgcolor: 'background.default',
              fontFamily: 'monospace',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              p: 1
            }}
          >
            {digest.data.markdown}
          </Box>
        </>
      )}
    </Stack>
  )
}
