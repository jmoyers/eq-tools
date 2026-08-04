// VoiceSetting — Preferences → Voice (docs/plans/voice-alerts.md §2).
//
// The GLOBAL half of voice alerts: the master switch, which engine tier speaks, the default
// voice, and how fast/loud. Per-alert choices (what an alert says, and a voice override for that
// one alert) live in the alert editor's Speech block — this panel is what those defer to.
//
// OFF BY DEFAULT AND IT STAYS THAT WAY (decision D4). The toggle is the only thing that makes the
// app start talking, and the ONE download this panel can start (~115 MB of Kokoro model) happens
// only when the user clicks the button that says so. Every control below the switch
// stays mounted and enabled while it is off — they configure a thing that is switched off, which
// is a normal state, and disabling them would make the panel read as broken rather than as idle.
//
// ONE BORDER: PreferencesView already wraps each item in an outlined Paper, so this renders bare
// Stacks — a Paper here would draw a second frame inside the first (the repo's one-border law).
//
// TRUTH ABOUT THE TIERS, not marketing. The kokoro row states "not installed" whenever
// `speech:voices` answers with an empty inventory — which for that tier is not a proxy for the
// install state but IS it: a Kokoro voice is a style vector inside the downloaded pack, so no
// file means genuinely zero voices. W3 shipped the engine and the provisioner, so that row now
// carries the DOWNLOAD itself: one button stating the real byte count (read from main's pinned
// asset table, never a copied number), live progress while it runs, the failure reason spelled
// out when it fails, and a voice picker that repopulates in place when it lands. Picking the tier
// before downloading is still allowed and still saves — `lib/speech.ts` falls back to the system
// voice and warns once — because a preference the user set must not be silently rewritten.

import { type JSX, useCallback, useEffect, useState } from 'react'
import {
  Box,
  Button,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Select,
  Slider,
  Stack,
  Switch,
  Typography
} from '@mui/material'
import DownloadIcon from '@mui/icons-material/Download'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import type { SpeechEngine, SpeechInstallProgress, VoicePrefs } from '@shared/types'
import {
  MAX_SPEECH_RATE,
  MIN_SPEECH_RATE,
  SPEECH_ENGINES,
  normalizeVoicePrefs
} from '@shared/speechText'
import { applyVoicePrefs, currentVoicePrefs, forgetSystemVoices, speak } from '../../lib/speech'
import { useVoiceOptions } from '../../lib/useVoices'

/** What each tier is, in one line. The size lives on the download button, where it is actionable. */
const ENGINE_LABELS: Record<SpeechEngine, string> = {
  system: 'Windows voices (built in)',
  kokoro: 'Natural voice (downloaded)'
}

/** The sentence the ▶ preview speaks. Fixed on purpose: it is an ALERT-shaped utterance. */
const PREVIEW_TEXT = 'Charm break'

/**
 * The prefs blob, hydrated once from main and written back on every change.
 *
 * Writes go through main (the store is main-owned) and the REPLY is what we adopt: the handler
 * re-clamps every field through the same normalizer the file and the migration use, so what the
 * UI shows is always what was actually stored, never what we hoped to store. The engine seam's
 * cache is updated with the same value so the very next alert speaks with the new settings —
 * no reload, no focus round-trip.
 */
function useVoicePrefs(): [VoicePrefs, (next: VoicePrefs) => void] {
  const [prefs, setPrefs] = useState<VoicePrefs>(currentVoicePrefs)

  useEffect(() => {
    let alive = true
    void window.eq.getVoicePrefs().then((stored) => {
      if (!alive) return
      applyVoicePrefs(stored)
      setPrefs(stored)
    })
    return () => {
      alive = false
    }
  }, [])

  const update = useCallback((next: VoicePrefs) => {
    // Optimistic locally (a slider must not lag an IPC round trip), authoritative from main.
    const normalized = normalizeVoicePrefs(next)
    applyVoicePrefs(normalized)
    setPrefs(normalized)
    void window.eq.setVoicePrefs(normalized).then((stored) => {
      applyVoicePrefs(stored)
      setPrefs(stored)
    })
  }, [])

  return [prefs, update]
}

/** Bytes as whole megabytes — the unit a download is judged in. */
function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

/** What the panel knows about the downloadable tier, and the one action that changes it. */
interface KokoroInstallState {
  /** Bytes `speechInstall` would fetch, straight from main's pinned table. 0 until it answers. */
  totalBytes: number
  /** The latest push from a running install, or the terminal verdict of the last one. */
  progress: SpeechInstallProgress | null
  /** True between clicking Download and the invoke resolving. */
  busy: boolean
  /** Completed installs this session — the seam that re-asks `speech:voices` (see useVoices). */
  installs: number
  start: () => void
}

/**
 * The Kokoro download, driven from the panel that starts it.
 *
 * `speech:install` resolves only when a ~120 MB download has FINISHED, so the progress channel is
 * the only thing that can say anything meanwhile; this subscribes for the panel's whole life
 * rather than only while busy, so an install started before this render (the handler joins a
 * single in-flight run) is still rendered honestly.
 *
 * A REFUSAL THAT NEVER PUSHES PROGRESS becomes a 'failed' phase here — the e2e channel declines
 * outright, and a bar left running against a download that was never started would be a lie.
 */
function useKokoroInstall(): KokoroInstallState {
  const [totalBytes, setTotalBytes] = useState(0)
  const [progress, setProgress] = useState<SpeechInstallProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [installs, setInstalls] = useState(0)

  useEffect(() => {
    let alive = true
    void window.eq.speechInstallSize('kokoro').then((bytes) => {
      if (alive) setTotalBytes(bytes)
    })
    const off = window.eq.onSpeechInstallProgress((p) => {
      if (p.engine !== 'kokoro') return
      setProgress(p)
      if (p.phase === 'done') setInstalls((n) => n + 1)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const start = useCallback(() => {
    setBusy(true)
    setProgress({ engine: 'kokoro', phase: 'checking', received: 0, total: 0 })
    void (async () => {
      let failure: string | null = null
      try {
        const result = await window.eq.speechInstall('kokoro')
        if (!result.ok) failure = result.message ?? result.reason
      } catch (err) {
        failure = String(err)
      }
      setBusy(false)
      if (failure !== null) {
        setProgress({ engine: 'kokoro', phase: 'failed', received: 0, total: 0, message: failure })
      }
    })()
  }, [])

  return { totalBytes, progress, busy, installs, start }
}

/** Master switch. Everything else configures what happens once this is on. */
function EnableRow({ prefs, onChange }: { prefs: VoicePrefs; onChange: (p: VoicePrefs) => void }): JSX.Element {
  return (
    <Stack spacing={0.5}>
      <FormControlLabel
        control={
          <Switch
            size="small"
            data-testid="pref-voice-enabled"
            checked={prefs.enabled}
            onChange={(e) => onChange({ ...prefs, enabled: e.target.checked })}
          />
        }
        label={<Typography variant="body2">Speak alerts out loud</Typography>}
      />
      <Typography variant="caption" color="text.secondary">
        {prefs.enabled
          ? 'Alerts set to speak will say their phrase. Muting alerts silences speech too.'
          : 'Off. Alerts set to speak fall back to their sound until you turn this on.'}
      </Typography>
    </Stack>
  )
}

/** Where a running install has got to, in one line. 'failed' is rendered separately. */
function phaseLabel(prog: SpeechInstallProgress, percent: number | null): string {
  switch (prog.phase) {
    case 'checking':
      return 'Checking what is already downloaded…'
    case 'downloading':
      return `Downloading ${mb(prog.received)} of ${mb(prog.total)}${percent === null ? '' : ` (${percent}%)`}`
    case 'verifying':
      return 'Verifying the download…'
    case 'done':
      return 'Installed.'
    default:
      return ''
  }
}

/** The live phase line + bar, or the failure spelled out — whichever the last push says. */
function InstallProgress({ prog }: { prog: SpeechInstallProgress }): JSX.Element {
  if (prog.phase === 'failed') {
    // The reason is the whole value of this line: a sha256 mismatch and a short read mean
    // different things to a user deciding whether to retry.
    return (
      <Typography
        variant="caption"
        color="error"
        display="block"
        sx={{ mt: 0.5 }}
        data-testid="pref-voice-install-error"
      >
        Download failed — {prog.message ?? 'no detail given'}. Nothing was installed.
      </Typography>
    )
  }
  const percent = prog.total > 0 ? Math.round((prog.received / prog.total) * 100) : null
  return (
    <Box sx={{ mt: 0.5 }} data-testid="pref-voice-install-progress">
      <Typography variant="caption" color="text.secondary">
        {phaseLabel(prog, percent)}
      </Typography>
      <LinearProgress
        variant={percent === null ? 'indeterminate' : 'determinate'}
        value={percent ?? undefined}
        sx={{ mt: 0.25 }}
      />
    </Box>
  )
}

/**
 * The downloadable tier when it is not downloaded: what that means today, what it costs, and how
 * far a running download has got. The button comes back after a failure — a retry is the only
 * sensible next move, and the reason above it says whether it is worth making.
 */
function KokoroInstall({ install }: { install: KokoroInstallState }): JSX.Element {
  const { totalBytes, progress, busy, start } = install
  const running = busy || (progress !== null && progress.phase !== 'failed')
  return (
    <Box sx={{ mt: 0.5 }}>
      <Typography variant="caption" color="warning.main" display="block" data-testid="pref-voice-not-installed">
        Not installed yet — alerts speak with a Windows voice until it is.
      </Typography>
      {progress && <InstallProgress prog={progress} />}
      {!running && (
        <Button
          size="small"
          variant="outlined"
          startIcon={<DownloadIcon />}
          sx={{ mt: 0.75 }}
          data-testid="pref-voice-install"
          onClick={start}
        >
          Download natural voice{totalBytes > 0 ? ` (~${mb(totalBytes)})` : ''}
        </Button>
      )}
    </Box>
  )
}

/** Engine tier picker; the downloaded tier states its install state rather than hiding. */
function EngineRow({
  prefs,
  installed,
  install,
  onChange
}: {
  prefs: VoicePrefs
  installed: boolean
  install: KokoroInstallState
  onChange: (p: VoicePrefs) => void
}): JSX.Element {
  return (
    <Box sx={{ maxWidth: 360 }}>
      <Typography variant="caption" color="text.secondary">
        Voice engine
      </Typography>
      <Select
        size="small"
        fullWidth
        data-testid="pref-voice-engine"
        value={prefs.engine}
        onChange={(e) => onChange({ ...prefs, engine: e.target.value as SpeechEngine, voiceId: null })}
      >
        {SPEECH_ENGINES.map((engine) => (
          <MenuItem key={engine} value={engine}>
            {ENGINE_LABELS[engine]}
            {engine === 'kokoro' && !installed ? ' — not installed' : ''}
          </MenuItem>
        ))}
      </Select>
      {prefs.engine === 'kokoro' && !installed && <KokoroInstall install={install} />}
    </Box>
  )
}

/** Default voice + the ▶ that speaks an alert-shaped preview through the real engine. */
function VoicePickerRow({
  prefs,
  voices,
  onChange
}: {
  prefs: VoicePrefs
  voices: { id: string; label: string }[]
  onChange: (p: VoicePrefs) => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-end" flexWrap="wrap" useFlexGap>
      <Box sx={{ minWidth: 260, flexGrow: 1, maxWidth: 360 }}>
        <Typography variant="caption" color="text.secondary">
          Voice
        </Typography>
        <Select
          size="small"
          fullWidth
          displayEmpty
          data-testid="pref-voice-picker"
          value={voices.some((v) => v.id === prefs.voiceId) ? prefs.voiceId ?? '' : ''}
          onChange={(e) => onChange({ ...prefs, voiceId: e.target.value || null })}
        >
          <MenuItem value="">
            {voices.length ? 'Default voice' : 'No voices available'}
          </MenuItem>
          {voices.map((v) => (
            <MenuItem key={v.id} value={v.id}>
              {v.label}
            </MenuItem>
          ))}
        </Select>
      </Box>
      <Button
        size="small"
        startIcon={<PlayArrowIcon />}
        data-testid="pref-voice-preview"
        onClick={() => void speak(PREVIEW_TEXT, prefs)}
      >
        Preview
      </Button>
    </Stack>
  )
}

/** Rate + volume. Both are applied on top of the alerts module's own master volume. */
function RateVolumeRow({ prefs, onChange }: { prefs: VoicePrefs; onChange: (p: VoicePrefs) => void }): JSX.Element {
  return (
    <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap" useFlexGap>
      <Stack sx={{ minWidth: 180 }}>
        <Typography variant="caption" color="text.secondary">
          Speed ({prefs.rate.toFixed(2)}×)
        </Typography>
        <Slider
          size="small"
          data-testid="pref-voice-rate"
          min={MIN_SPEECH_RATE}
          max={MAX_SPEECH_RATE}
          step={0.05}
          value={prefs.rate}
          onChange={(_e, v) => onChange({ ...prefs, rate: v as number })}
          sx={{ width: 160 }}
        />
      </Stack>
      <Stack sx={{ minWidth: 180 }}>
        <Typography variant="caption" color="text.secondary">
          Volume ({Math.round(prefs.volume * 100)}%)
        </Typography>
        <Slider
          size="small"
          data-testid="pref-voice-volume"
          min={0}
          max={1}
          step={0.05}
          value={prefs.volume}
          onChange={(_e, v) => onChange({ ...prefs, volume: v as number })}
          sx={{ width: 160 }}
        />
      </Stack>
    </Stack>
  )
}

export function VoiceSetting(): JSX.Element {
  const [prefs, update] = useVoicePrefs()
  const install = useKokoroInstall()
  // A finished download changes the kokoro tier's inventory without changing the tier, so the
  // completed-install count is what re-asks — otherwise the picker would stay empty until the
  // panel remounted.
  const voices = useVoiceOptions(prefs.engine, install.installs)
  // The system list is cached for the app's lifetime (it is stable); re-entering this panel
  // after a Windows voice was installed should still see it.
  useEffect(() => forgetSystemVoices, [])
  return (
    <Stack spacing={2} data-testid="pref-voice">
      <EnableRow prefs={prefs} onChange={update} />
      <EngineRow
        prefs={prefs}
        installed={prefs.engine === 'kokoro' ? voices.length > 0 : true}
        install={install}
        onChange={update}
      />
      <VoicePickerRow prefs={prefs} voices={voices} onChange={update} />
      <RateVolumeRow prefs={prefs} onChange={update} />
    </Stack>
  )
}
