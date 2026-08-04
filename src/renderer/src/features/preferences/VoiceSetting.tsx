// VoiceSetting — Preferences → Voice (docs/plans/voice-alerts.md §2).
//
// The GLOBAL half of voice alerts: the master switch, which engine tier speaks, the default
// voice, and how fast/loud. Per-alert choices (what an alert says, and a voice override for that
// one alert) live in the alert editor's Speech block — this panel is what those defer to.
//
// OFF BY DEFAULT AND IT STAYS THAT WAY (decision D4). Nothing here downloads anything, and the
// toggle is the only thing that makes the app start talking. Every control below the switch
// stays mounted and enabled while it is off — they configure a thing that is switched off, which
// is a normal state, and disabling them would make the panel read as broken rather than as idle.
//
// ONE BORDER: PreferencesView already wraps each item in an outlined Paper, so this renders bare
// Stacks — a Paper here would draw a second frame inside the first (the repo's one-border law).
//
// TRUTH ABOUT THE TIERS, not marketing. The kokoro row states "not installed" whenever
// `speech:voices` answers with an empty inventory, which in every build through wave 2 it always
// does (main ships the channel as an honest stub). Picking it is still allowed and still saves —
// `lib/speech.ts` falls back to the system voice and warns once — because a preference the user
// set must not be silently rewritten, and W3 turns that row live without them having to come
// back.

import { type JSX, useCallback, useEffect, useState } from 'react'
import {
  Box,
  Button,
  FormControlLabel,
  MenuItem,
  Select,
  Slider,
  Stack,
  Switch,
  Typography
} from '@mui/material'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import type { SpeechEngine, VoicePrefs } from '@shared/types'
import {
  MAX_SPEECH_RATE,
  MIN_SPEECH_RATE,
  SPEECH_ENGINES,
  normalizeVoicePrefs
} from '@shared/speechText'
import { applyVoicePrefs, currentVoicePrefs, forgetSystemVoices, speak } from '../../lib/speech'
import { useVoiceOptions } from '../../lib/useVoices'

/** What each tier is, in one line. State, never process — no download sizes we can't honor yet. */
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

/** Engine tier picker; the downloaded tier states its install state rather than hiding. */
function EngineRow({
  prefs,
  installed,
  onChange
}: {
  prefs: VoicePrefs
  installed: boolean
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
      {prefs.engine === 'kokoro' && !installed && (
        <Typography variant="caption" color="warning.main" display="block" data-testid="pref-voice-not-installed">
          Not installed yet — alerts speak with a Windows voice until it is.
        </Typography>
      )}
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
  const voices = useVoiceOptions(prefs.engine)
  // The system list is cached for the app's lifetime (it is stable); re-entering this panel
  // after a Windows voice was installed should still see it.
  useEffect(() => forgetSystemVoices, [])
  return (
    <Stack spacing={2} data-testid="pref-voice">
      <EnableRow prefs={prefs} onChange={update} />
      <EngineRow
        prefs={prefs}
        installed={prefs.engine === 'kokoro' ? voices.length > 0 : true}
        onChange={update}
      />
      <VoicePickerRow prefs={prefs} voices={voices} onChange={update} />
      <RateVolumeRow prefs={prefs} onChange={update} />
    </Stack>
  )
}
