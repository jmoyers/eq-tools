import { type JSX, useEffect, useRef, useState } from 'react'
import { Box, LinearProgress, Tooltip, Typography } from '@mui/material'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import type { UpdateStatus } from '@shared/types'
import { updateChipState, type UpdateChipState } from '@shared/update'
import { formatAge } from '../lib/formatDate'

/**
 * UpdateChip (Task #60) — the AMBIENT update affordance, pinned in the left nav
 * directly under Preferences.
 *
 * The product rule this encodes: an update is a REWARD, not a nag. There is
 * exactly one loud state (downloaded + staged ⇒ "Restart to update", gold,
 * clickable, glowing softly ONCE on arrival) and one resting state (a muted
 * "checked 2h ago" line, click to check). Downloading is a hairline bar. Errors
 * render as the resting state — a failed check is not the user's problem; the
 * message stays available in Preferences > Updates, which remains the DETAIL
 * surface (exact timestamp, version, manual check, error text).
 *
 * Nothing here ever re-prompts: if the user ignores the chip, apply-on-quit
 * installs the update the next time they close the app, silently.
 *
 * The status/UI mapping (including the "we were already updated to that version"
 * demotion) is pure and tested — see src/shared/update.ts `updateChipState`.
 */

const GOLD = '#d9b25f'
/** How often the "checked …" age re-renders. Coarse text ⇒ a lazy tick is fine. */
const AGE_TICK_MS = 60_000
/** How long the arrival glow runs before the chip settles into a calm resting look. */
const GLOW_MS = 6_000

/** Post-manual-check window: "up to date" is shown and re-checking is disabled. One
 *  answer is valid for at least this long, and it keeps a rapid clicker off GitHub. */
const CHECK_COOLDOWN_MS = 10_000

/** The one inviting, clickable state: downloaded + staged, waiting on a restart. */
function ReadyChip({
  version,
  glow,
  onInstall
}: {
  version?: string
  glow: boolean
  onInstall: () => void
}): JSX.Element {
  return (
    <Box sx={{ px: 1, pt: 0.75, pb: 1 }}>
      <Box
        component="button"
        type="button"
        data-testid="update-chip-ready"
        onClick={onInstall}
        title={version ? `Restart to update to v${version}` : 'Restart to update'}
        sx={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.25,
          py: 0.9,
          border: 1,
          borderColor: 'rgba(217,178,95,0.55)',
          borderRadius: 1.5,
          bgcolor: 'rgba(217,178,95,0.10)',
          color: GOLD,
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          transition: 'background-color 140ms ease, border-color 140ms ease',
          '&:hover': { bgcolor: 'rgba(217,178,95,0.20)', borderColor: GOLD },
          // Soft, finite arrival glow — two slow breaths, then it rests. No
          // badge, no red, no repeat.
          ...(glow && {
            animation: 'eqUpdateGlow 3s ease-in-out 2',
            '@keyframes eqUpdateGlow': {
              '0%, 100%': { boxShadow: '0 0 0 0 rgba(217,178,95,0)' },
              '50%': { boxShadow: '0 0 12px 1px rgba(217,178,95,0.45)' }
            }
          })
        }}
      >
        <RestartAltIcon fontSize="small" />
        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
          <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
            Restart to update
          </Typography>
          {version && (
            <Typography
              variant="caption"
              sx={{ display: 'block', opacity: 0.75, lineHeight: 1.2, fontFamily: 'monospace' }}
            >
              v{version}
            </Typography>
          )}
        </Box>
      </Box>
    </Box>
  )
}

/** Downloading: a hairline bar, still quiet. */
function DownloadingChip({ percent }: { percent: number }): JSX.Element {
  return (
    <Box sx={{ px: 2, pt: 0.75, pb: 1 }} data-testid="update-chip-downloading">
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.4 }}>
        Downloading update · {percent}%
      </Typography>
      <LinearProgress
        variant="determinate"
        value={percent}
        sx={{
          mt: 0.5,
          height: 2,
          borderRadius: 1,
          bgcolor: 'rgba(255,255,255,0.08)',
          '& .MuiLinearProgress-bar': { bgcolor: 'rgba(217,178,95,0.7)' }
        }}
      />
    </Box>
  )
}

/**
 * Dev build: the updater is OFF, and the line says so. Without this the dev app showed
 * "not checked yet" forever — a truthful but misleading state that reads as a broken
 * production updater. Static text, not a button: clicking would no-op.
 */
function DisabledChip({ version }: { version: string }): JSX.Element {
  return (
    <Box sx={{ px: 2, pt: 0.75, pb: 1 }}>
      <Tooltip title="Auto-update runs only in the installed app — the dev build never checks." placement="top">
        <Typography
          data-testid="update-chip-disabled"
          variant="caption"
          sx={{ display: 'block', color: 'text.disabled', lineHeight: 1.4, cursor: 'default' }}
        >
          {version ? `v${version} · ` : ''}updates off (dev)
        </Typography>
      </Tooltip>
    </Box>
  )
}

/** Working / quiet: one muted line, click to check. */
function QuietChip({
  label,
  tip,
  disabled,
  onCheck
}: {
  label: string
  tip: string
  disabled: boolean
  onCheck: () => void
}): JSX.Element {
  return (
    <Box sx={{ px: 2, pt: 0.75, pb: 1 }}>
      <Tooltip title={tip} placement="top">
        <Box
          component="button"
          type="button"
          data-testid="update-chip-quiet"
          disabled={disabled}
          onClick={onCheck}
          sx={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            border: 0,
            p: 0,
            bgcolor: 'transparent',
            fontFamily: 'inherit',
            fontSize: 11,
            lineHeight: 1.4,
            color: 'text.disabled',
            cursor: 'pointer',
            transition: 'color 140ms ease',
            '&:hover': { color: 'text.secondary' },
            '&:disabled': { cursor: 'default' }
          }}
        >
          {label}
        </Box>
      </Tooltip>
    </Box>
  )
}

/**
 * The muted line's text + tooltip.
 *
 * The quiet line leads with the INSTALLED version — the chip is the bottom-left
 * "what am I running" spot, and "checked 2h ago" alone answered only half of it.
 *
 * A MANUAL check that finds nothing must say so: for the cooldown window the line reads
 * "up to date" instead of the ambiguous "checked just now" (which never answered the
 * question the click asked).
 *
 * Errors stay INVISIBLE here (same muted line) — only the tooltip admits it, and
 * Preferences > Updates carries the detail.
 */
function quietLine(
  ui: UpdateChipState,
  ctx: { version: string; now: number; busy: boolean; cooldown: boolean }
): { label: string; tip: string } {
  const vPrefix = ctx.version ? `v${ctx.version} · ` : ''
  const upToDate = ctx.cooldown && ui.kind === 'quiet' && !ui.failed
  const label =
    ui.kind === 'working'
      ? ui.label
      : ctx.busy
        ? 'Checking for updates…'
        : upToDate
          ? `${vPrefix}up to date`
          : ui.checkedAt
            ? `${vPrefix}checked ${formatAge(ui.checkedAt, ctx.now)}`
            : `${vPrefix}not checked yet`
  const tip =
    ui.kind === 'quiet' && ui.failed
      ? `Last check didn't complete${ui.message ? ` — ${ui.message}` : ''}. Click to try again.`
      : 'Click to check for updates'
  return { label, tip }
}

export function UpdateChip(): JSX.Element {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [version, setVersion] = useState<string>('')
  const [now, setNow] = useState(() => Date.now())
  const [glow, setGlow] = useState(false)
  const [busy, setBusy] = useState(false)
  // Post-manual-check window: the label says "up to date" and re-checking is disabled.
  const [cooldown, setCooldown] = useState(false)
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasReady = useRef<boolean | null>(null)

  const startCooldown = (): void => {
    setCooldown(true)
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current)
    cooldownTimer.current = setTimeout(() => setCooldown(false), CHECK_COOLDOWN_MS)
  }
  useEffect(
    () => () => {
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current)
    },
    []
  )

  useEffect(() => {
    let alive = true
    // Pull first: a push that fired before this mounted would otherwise be lost.
    void window.eq.getUpdateStatus().then((s) => {
      if (alive) setStatus(s)
    })
    void window.eq.getAppVersion().then((v) => {
      if (alive) setVersion(v)
    })
    const off = window.eq.onUpdateStatus(setStatus)
    const t = setInterval(() => setNow(Date.now()), AGE_TICK_MS)
    return () => {
      alive = false
      off()
      clearInterval(t)
    }
  }, [])

  const ui = updateChipState(status, version || undefined)
  const ready = ui.kind === 'ready'

  // Glow exactly ONCE, on the TRANSITION into ready. `wasReady` starts null so
  // the first observed status only seeds the baseline — remounting (or a status
  // that was already ready) never re-fires the celebration.
  useEffect(() => {
    const prev = wasReady.current
    wasReady.current = ready
    if (prev !== false || !ready) return
    setGlow(true)
    const t = setTimeout(() => setGlow(false), GLOW_MS)
    return () => clearTimeout(t)
  }, [ready])

  if (ui.kind === 'ready') {
    return <ReadyChip version={ui.version} glow={glow} onInstall={() => void window.eq.installUpdate()} />
  }

  if (ui.kind === 'downloading') return <DownloadingChip percent={ui.percent} />

  if (ui.kind === 'quiet' && ui.disabled) return <DisabledChip version={version} />

  // Working / quiet. The cooldown window ALSO disables re-checking — no spinner, no extra
  // chrome, the button just won't fire again for a few seconds. One click's answer is valid
  // for at least that long, and it keeps a rapid-clicker from hammering GitHub.
  const { label, tip } = quietLine(ui, { version, now, busy, cooldown })
  return (
    <QuietChip
      label={label}
      tip={tip}
      disabled={busy || cooldown || ui.kind === 'working'}
      onCheck={() => {
        setBusy(true)
        void window.eq.checkForUpdates().finally(() => {
          setBusy(false)
          startCooldown()
        })
      }}
    />
  )
}

export default UpdateChip
