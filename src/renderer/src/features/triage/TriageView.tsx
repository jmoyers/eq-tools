// ============================================================================
// TriageView — the DEV-ONLY operator tab. Reports · Ops · Digest · Analytics.
// ============================================================================
//
// THIS FILE IS NOT IN SHIPPED BUILDS. It is reached exclusively through
// `__EQ_DEV_TOOLS__ ? lazy(() => import('./features/triage/TriageView')) : null` in
// `src/renderer/src/devTriage.tsx`. `__EQ_DEV_TOOLS__` is a compile-time define
// (electron.vite.config.ts) that is `true` only under `electron-vite dev`, so
// `electron-vite build` — which is what every installer AND `npm run test:e2e` runs — sees
// `false ? … : null`, and rollup deletes this entire subtree from the bundle. The e2e suite
// asserts the nav row is ABSENT in exactly that build.
//
// AND THE DATA CANNOT BE REACHED EITHER. Every panel below reads through `window.eq.triage*`,
// whose handlers are registered in main only when `!app.isPackaged && !E2E`, from a module that
// imports devDependencies electron-builder never packages, authenticating with the launching
// shell's AWS profile. Three independent locks; this one is the cosmetic one.
//
// THE LAW (§10.3) rides along: a log slice never reaches anything public. Slice text is
// fetched on demand into a local, fixed-height box (SliceBox) and has no path out of it.

import { type JSX, useState } from 'react'
import { Box, Stack, Tab, Tabs, Typography } from '@mui/material'
import ReportsPanel from './ReportsPanel'
import OpsPanel from './OpsPanel'
import DigestPanel from './DigestPanel'
import AnalyticsPanel from './AnalyticsPanel'

type TriageTab = 'reports' | 'ops' | 'digest' | 'analytics'

const TABS: { id: TriageTab; label: string }[] = [
  { id: 'reports', label: 'Reports' },
  { id: 'ops', label: 'Ops' },
  { id: 'digest', label: 'Digest' },
  { id: 'analytics', label: 'Analytics' }
]

/** Remembered like every other tab selection in this app: renderer-local, nothing persisted
 *  in main, and harmless if the key survives into a build that no longer has this tab. */
const TAB_KEY = 'eq.triage.tab'

function loadTab(): TriageTab {
  const v = localStorage.getItem(TAB_KEY)
  return TABS.some((t) => t.id === v) ? (v as TriageTab) : 'reports'
}

export default function TriageView(): JSX.Element {
  const [tab, setTab] = useState<TriageTab>(loadTab)

  const select = (next: TriageTab): void => {
    setTab(next)
    localStorage.setItem(TAB_KEY, next)
  }

  return (
    <Stack spacing={2} sx={{ height: '100%' }} data-testid="triage-view">
      <Stack direction="row" spacing={2} alignItems="baseline" useFlexGap flexWrap="wrap">
        <Typography variant="h6">Feedback triage</Typography>
        {/* STATE, not process: what this surface IS reading, and with whose credentials. */}
        <Typography variant="caption" color="text.secondary">
          Live backlog · Aurora DSQL + S3 · your shell&apos;s AWS profile · dev builds only
        </Typography>
      </Stack>

      <Tabs value={tab} onChange={(_e, v: TriageTab) => select(v)} variant="scrollable">
        {TABS.map((t) => (
          <Tab key={t.id} value={t.id} label={t.label} data-testid={`triage-tab-${t.id}`} />
        ))}
      </Tabs>

      <Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'reports' && <ReportsPanel />}
        {tab === 'ops' && <OpsPanel />}
        {tab === 'digest' && <DigestPanel />}
        {tab === 'analytics' && <AnalyticsPanel />}
      </Box>
    </Stack>
  )
}
