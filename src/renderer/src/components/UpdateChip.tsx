import { useEffect, useRef, useState } from 'react'
import { Box, LinearProgress, Tooltip, Typography } from '@mui/material'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import type { UpdateStatus } from '@shared/types'
import { updateChipState } from '@shared/update'
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

export function UpdateChip(): JSX.Element {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [version, setVersion] = useState<string>('')
  const [now, setNow] = useState(() => Date.now())
  const [glow, setGlow] = useState(false)
  const [busy, setBusy] = useState(false)
  const wasReady = useRef<boolean | null>(null)

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

  // ---- ready: the one inviting, clickable state -----------------------------
  if (ui.kind === 'ready') {
    return (
      <Box sx={{ px: 1, pt: 0.75, pb: 1 }}>
        <Box
          component="button"
          type="button"
          data-testid="update-chip-ready"
          onClick={() => void window.eq.installUpdate()}
          title={ui.version ? `Restart to update to v${ui.version}` : 'Restart to update'}
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
            {ui.version && (
              <Typography
                variant="caption"
                sx={{ display: 'block', opacity: 0.75, lineHeight: 1.2, fontFamily: 'monospace' }}
              >
                v{ui.version}
              </Typography>
            )}
          </Box>
        </Box>
      </Box>
    )
  }

  // ---- downloading: a hairline bar, still quiet -----------------------------
  if (ui.kind === 'downloading') {
    return (
      <Box sx={{ px: 2, pt: 0.75, pb: 1 }} data-testid="update-chip-downloading">
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.4 }}>
          Downloading update · {ui.percent}%
        </Typography>
        <LinearProgress
          variant="determinate"
          value={ui.percent}
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

  // ---- dev build: the updater is OFF, and the line says so ------------------
  // Without this the dev app showed "not checked yet" forever — a truthful but
  // misleading state that reads as a broken production updater. Static text,
  // not a button: clicking would no-op.
  if (ui.kind === 'quiet' && ui.disabled) {
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

  // ---- working / quiet: one muted line, click to check ----------------------
  // The quiet line leads with the INSTALLED version — the chip is the bottom-left
  // "what am I running" spot, and "checked 2h ago" alone answered only half of it.
  const vPrefix = version ? `v${version} · ` : ''
  const label =
    ui.kind === 'working'
      ? ui.label
      : busy
        ? 'Checking for updates…'
        : ui.checkedAt
          ? `${vPrefix}checked ${formatAge(ui.checkedAt, now)}`
          : `${vPrefix}not checked yet`

  // Errors stay INVISIBLE here (same muted line) — only the tooltip admits it,
  // and Preferences > Updates carries the detail.
  const tip =
    ui.kind === 'quiet' && ui.failed
      ? `Last check didn't complete${ui.message ? ` — ${ui.message}` : ''}. Click to try again.`
      : 'Click to check for updates'

  return (
    <Box sx={{ px: 2, pt: 0.75, pb: 1 }}>
      <Tooltip title={tip} placement="top">
        <Box
          component="button"
          type="button"
          data-testid="update-chip-quiet"
          disabled={busy || ui.kind === 'working'}
          onClick={() => {
            setBusy(true)
            void window.eq.checkForUpdates().finally(() => setBusy(false))
          }}
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

export default UpdateChip
