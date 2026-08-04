// ============================================================================
// AnalyticsPanel — the readout (docs/plans/usage-analytics.md A3, surface 1).
// ============================================================================
//
// Pulse · Adoption · Funnels · Health · Versions · Retention, off `usage_daily` +
// `usage_funnel_daily` + `analytics_install`, read in MAIN through the triage role and handed
// over already computed (`src/main/triage/analytics.ts`). This file renders; it decides
// nothing that `./analyticsRows.ts` cannot decide as a pure function and a test cannot pin.
//
// THREE STATES, AND THEY ARE DIFFERENT ON PURPOSE:
//   * TABLES MISSING (`available:false`) — a cluster that predates the A2 migration. Says so,
//     names the table, and says what to run. This is the ONLY arm that hides the dashboard.
//   * TABLES EMPTY — honest zeros plus one "no data yet" line. That is the state every build
//     shipped so far is in (`TELEMETRY_API_URL` is still '', so nothing has ever been sent),
//     and it is a REAL, informative answer: the pipe exists and is quiet.
//   * DATA — the six sections.
//
// The earlier version of this panel listed a `SHAPE` table of promised fields as a stand-in
// for the dashboard. It is gone, and so is its field list, which had gone stale against the
// expanded design (it still said `byPlatform`/`opens`) — the panel IS the shape now.
//
// Sparklines are tiny inline SVG through `sparklinePoints`, the PerfChip precedent: sixty
// numbers do not need a chart library, and a pure points function is testable.

import type { JSX, ReactNode } from 'react'
import { useCallback, useState } from 'react'
import {
  Alert,
  AlertTitle,
  Box,
  CircularProgress,
  Divider,
  Stack,
  Tab,
  Tabs,
  Typography
} from '@mui/material'
import type {
  TriageAnalytics,
  TriageAnalyticsData,
  TriageFunnelView,
  TriageMixRow,
  UsageDayPoint
} from '@shared/triage'
import { TRIAGE_ANALYTICS_DAYS, TRIAGE_ANALYTICS_DEFAULT_DAYS } from '@shared/triage'
import { sparklinePoints } from '@shared/perf'
import { formatNum } from '../../lib/formatRate'
import { useTriageCall } from './useTriage'
import {
  cohortCell,
  durationLabel,
  funnelBars,
  pctLabel,
  pulseTiles,
  rateLabel,
  seriesValues,
  windowIsEmpty
} from './analyticsRows'

const SPARK_W = 220
const SPARK_H = 28

function Sparkline({ points }: { points: readonly UsageDayPoint[] }): JSX.Element {
  return (
    <Box
      component="svg"
      data-testid="analytics-sparkline"
      viewBox={`0 0 ${String(SPARK_W)} ${String(SPARK_H)}`}
      preserveAspectRatio="none"
      sx={{ width: '100%', height: SPARK_H, display: 'block' }}
    >
      <polyline
        points={sparklinePoints(seriesValues(points), SPARK_W, SPARK_H)}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        opacity={0.75}
      />
    </Box>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">{title}</Typography>
      {children}
      <Divider />
    </Stack>
  )
}

/** `label  value  ▁▁▃▅` — the one row shape every mix list in this panel uses. */
function MixList({ rows, empty }: { rows: readonly TriageMixRow[]; empty: string }): JSX.Element {
  if (rows.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary">
        {empty}
      </Typography>
    )
  }
  const max = Math.max(...rows.map((r) => r.n))
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(120px, max-content) 1fr max-content', columnGap: 1.5, rowGap: 0.25 }}>
      {rows.map((r) => (
        <Box key={r.id} sx={{ display: 'contents' }}>
          <Typography variant="caption">{r.id}</Typography>
          <Box sx={{ alignSelf: 'center', height: 6, bgcolor: 'action.hover', borderRadius: 1 }}>
            <Box
              sx={{
                width: `${String(max > 0 ? (r.n / max) * 100 : 0)}%`,
                height: '100%',
                bgcolor: 'primary.main',
                borderRadius: 1
              }}
            />
          </Box>
          <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatNum(r.n)}
          </Typography>
        </Box>
      ))}
    </Box>
  )
}

function PulseSection({ data }: { data: TriageAnalyticsData }): JSX.Element {
  return (
    <Section title="Pulse">
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
        {pulseTiles(data).map((t) => (
          <Stack key={t.label} spacing={0} sx={{ minWidth: 140 }}>
            <Typography variant="caption" color="text.secondary">
              {t.label}
            </Typography>
            <Typography variant="h6" sx={{ fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>
              {t.value}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t.note}
            </Typography>
          </Stack>
        ))}
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 2 }}>
        <Stack spacing={0.25}>
          <Typography variant="caption" color="text.secondary">
            Active installs per day
          </Typography>
          <Sparkline points={data.pulse.activeSeries} />
        </Stack>
        <Stack spacing={0.25}>
          <Typography variant="caption" color="text.secondary">
            Sessions per day
          </Typography>
          <Sparkline points={data.pulse.sessionSeries} />
        </Stack>
      </Box>
    </Section>
  )
}

function AdoptionSection({ data }: { data: TriageAnalyticsData }): JSX.Element {
  const a = data.adoption
  return (
    <Section title="Adoption">
      <Typography variant="caption" color="text.secondary">
        Feature numbers are USES, not reach: a daily counter cannot say how many distinct
        installs touched a feature without keeping a per-install trail, which this design
        deliberately does not.
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 2 }}>
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            Views by dwell share
          </Typography>
          <MixList
            rows={a.views.map((v) => ({ id: `${v.id} · ${pctLabel(v.share)}`, n: v.visits }))}
            empty="No view dwell recorded."
          />
        </Stack>
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            Features (uses · per session)
          </Typography>
          <MixList
            rows={a.features.map((f) => ({ id: `${f.id} · ${f.perSession.toFixed(2)}/s`, n: f.uses }))}
            empty="No feature use recorded."
          />
        </Stack>
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            Overlays opened
          </Typography>
          <MixList rows={a.overlays} empty="No overlay opened." />
        </Stack>
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            Voice engine · cursor ring · auto-hide
          </Typography>
          <MixList
            rows={[
              ...a.voice.map((v) => ({ id: `voice ${v.id}`, n: v.n })),
              ...a.cursorRing.map((v) => ({ id: `cursor ring ${v.id}`, n: v.n })),
              ...a.autoHide.map((v) => ({ id: `auto-hide ${v.id}`, n: v.n }))
            ]}
            empty="No setup snapshot recorded."
          />
        </Stack>
      </Box>
      <Typography variant="caption" color="text.secondary">
        Alerts fired {formatNum(a.alertsFired)} · spoken {formatNum(a.alertsSpoken)}
      </Typography>
    </Section>
  )
}

function FunnelCard({ view }: { view: TriageFunnelView }): JSX.Element {
  const bars = funnelBars(view.steps)
  return (
    <Stack spacing={0.5}>
      <Typography variant="caption" sx={{ fontWeight: 600 }}>
        {view.funnel}
      </Typography>
      {bars.map((b) => (
        <Box key={b.step} sx={{ display: 'grid', gridTemplateColumns: '150px 1fr 120px', columnGap: 1.5, alignItems: 'center' }}>
          <Typography variant="caption">{b.step}</Typography>
          <Box sx={{ height: 8, bgcolor: 'action.hover', borderRadius: 1 }}>
            <Box sx={{ width: `${String(b.widthPct)}%`, height: '100%', bgcolor: 'success.main', borderRadius: 1 }} />
          </Box>
          <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatNum(b.n)} · {b.conversion}
            {b.dropOff === null ? '' : ` · ${b.dropOff}`}
          </Typography>
        </Box>
      ))}
      {view.byVersion.length > 1 && (
        <Typography variant="caption" color="text.secondary">
          by version —{' '}
          {view.byVersion
            .map((v) => `${v.version}: ${funnelBars(v.steps).at(-1)?.conversion ?? '—'} end-to-end`)
            .join(' · ')}
        </Typography>
      )}
      {view.failures.length > 0 && (
        <Typography variant="caption" color="warning.main">
          failures — {view.failures.map((f) => `${f.id} ${String(f.n)}`).join(' · ')}
        </Typography>
      )}
    </Stack>
  )
}

function HealthSection({ data }: { data: TriageAnalyticsData }): JSX.Element {
  const h = data.health
  return (
    <Section title="Health">
      <Typography variant="caption" color="text.secondary">
        {formatNum(h.reports)} per-session health rollups received.
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 2 }}>
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            Error classes
          </Typography>
          <MixList rows={h.errors} empty="No errors reported." />
        </Stack>
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            Update success
          </Typography>
          {h.update.map((u) => (
            <Typography key={u.step} variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {u.step}: {rateLabel(u.rate)} ({formatNum(u.ok)} ok · {formatNum(u.failed)} failed)
            </Typography>
          ))}
          {h.updateFailures.length > 0 && (
            <Typography variant="caption" color="warning.main">
              {h.updateFailures.map((f) => `${f.id} ${String(f.n)}`).join(' · ')}
            </Typography>
          )}
        </Stack>
      </Box>
    </Section>
  )
}

function VersionsSection({ data }: { data: TriageAnalyticsData }): JSX.Element {
  return (
    <Section title="Versions">
      {data.versions.length === 0 ? (
        <Typography variant="caption" color="text.secondary">
          No version has reported yet.
        </Typography>
      ) : (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'max-content max-content max-content 1fr', columnGap: 2, rowGap: 0.25 }}>
          {data.versions.map((v) => (
            <Box key={v.version} sx={{ display: 'contents' }}>
              <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                {v.version}
              </Typography>
              <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatNum(v.installs)} installs
              </Typography>
              <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                peak {pctLabel(v.peakShare)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                first seen {v.firstSeenDay ?? '—'} ·{' '}
                {v.daysToAdopt === null
                  ? 'never reached a majority'
                  : `${String(v.daysToAdopt)} days to majority (${v.majorityDay ?? '—'})`}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Section>
  )
}

function RetentionSection({ data }: { data: TriageAnalyticsData }): JSX.Element {
  return (
    <Section title="Retention">
      <Typography variant="caption" color="text.secondary">
        Survival, computed at read time from `analytics_install`: of the installs first seen on
        a day, how many were still being seen on or after +1 / +7 / +30. A dash means the
        cohort has not reached that horizon yet.
      </Typography>
      {data.retention.length === 0 ? (
        <Typography variant="caption" color="text.secondary">
          No cohorts yet.
        </Typography>
      ) : (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(5, max-content)', columnGap: 3, rowGap: 0.25 }}>
          {['Cohort', 'Installs', 'D1', 'D7', 'D30'].map((h) => (
            <Typography key={h} variant="caption" color="text.secondary">
              {h}
            </Typography>
          ))}
          {data.retention.map((c) => (
            <Box key={c.cohortDay} sx={{ display: 'contents' }}>
              <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                {c.cohortDay}
              </Typography>
              <Typography variant="caption">{formatNum(c.installs)}</Typography>
              <Typography variant="caption">{cohortCell(c.d1, c.installs)}</Typography>
              <Typography variant="caption">{cohortCell(c.d7, c.installs)}</Typography>
              <Typography variant="caption">{cohortCell(c.d30, c.installs)}</Typography>
            </Box>
          ))}
        </Box>
      )}
    </Section>
  )
}

function Readout({ data }: { data: TriageAnalyticsData }): JSX.Element {
  return (
    <Stack spacing={2}>
      {windowIsEmpty(data) && (
        <Alert severity="info" data-testid="analytics-empty">
          <AlertTitle>No data yet</AlertTitle>
          The tables are there and empty — every number below is a true zero, not a missing
          reading. Nothing has been sent: the client ships dark (<code>TELEMETRY_API_URL</code>{' '}
          is empty) until the commit that lights it.
        </Alert>
      )}
      <PulseSection data={data} />
      <AdoptionSection data={data} />
      <Section title="Funnels">
        <Stack spacing={2}>
          {data.funnels.map((f) => (
            <FunnelCard key={f.funnel} view={f} />
          ))}
        </Stack>
      </Section>
      <HealthSection data={data} />
      <VersionsSection data={data} />
      <RetentionSection data={data} />
      <Typography variant="caption" color="text.secondary">
        Window {data.days[0] ?? '?'} → {data.days.at(-1) ?? '?'} · median session length is a
        bucket range, not an average · durations shown as {durationLabel(1_800_000)}-style spans.
      </Typography>
    </Stack>
  )
}

export default function AnalyticsPanel(): JSX.Element {
  const [days, setDays] = useState<number>(TRIAGE_ANALYTICS_DEFAULT_DAYS)
  const run = useCallback(() => window.eq.triageAnalytics(days), [days])
  const analytics = useTriageCall<TriageAnalytics>(run)

  const header = (
    <Tabs value={days} onChange={(_e, v: number) => setDays(v)} variant="scrollable">
      {TRIAGE_ANALYTICS_DAYS.map((d) => (
        <Tab key={d} value={d} label={`${String(d)}d`} data-testid={`analytics-days-${String(d)}`} />
      ))}
    </Tabs>
  )

  return (
    <Stack spacing={2} data-testid="triage-analytics">
      {header}
      {analytics.loading && <CircularProgress size={20} />}
      {analytics.error !== null && <Alert severity="error">{analytics.error}</Alert>}
      {analytics.data?.available === false && (
        <Alert severity="warning" data-testid="analytics-unavailable">
          <AlertTitle>No usage-analytics tables on this cluster</AlertTitle>
          {analytics.data.reason}
        </Alert>
      )}
      {analytics.data?.available === true && <Readout data={analytics.data.data} />}
    </Stack>
  )
}
