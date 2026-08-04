// AudioPicker — the alert row's TWO dropdowns: what this alert plays, and which one.
//
// Owner: "the voice vs sound should be integrated into this dropdown instead of having to drill
// into edit." Before this, the row showed a pack picker and a sound picker, and the fact that an
// alert could SPEAK instead lived two clicks away in the editor's Speech block — so the single
// most interesting thing about an alert ("does this one talk?") was invisible in the list where
// every other property of it is visible.
//
// THE TWO SELECTS, EXACTLY:
//   1. OUTPUT — every installed sound pack (as before), a divider, then "Voice (spoken)" and
//      "Sound + voice". Choosing a pack means `audio:'sound'`; the two voice entries mean
//      'speech' and 'both' and keep the pack/sound the def already had. The select DISPLAYS the
//      def's actual state, so a def with `audio:'speech'` reads "Voice (spoken)" — there is no
//      hidden mode a row can be in without saying so.
//   2. CONTEXTUAL — the pack's sound list for 'sound' and 'both'; for 'speech' the speak-what
//      modes as plain sentences ("Speak: alert name", "Speak: custom…"). Custom opens a small
//      popover anchored on the select itself, never a navigation: the whole point of this change
//      is that the row is where you configure an alert.
//
// WHY 'both' KEEPS ITS FINE-TUNING IN THE EDITOR. An alert has three audio dimensions (channel,
// which sound, what it says) and this row has two selects. For 'sound' and 'speech' two is
// enough — the third dimension does not exist. For 'both' it is not, so the row shows the sound
// (the thing you are most likely to change) and the editor's SpeechBlock stays the place to
// change what a 'both' alert says. The row owns the 90% case; the editor stays complete.
// The editor is also authoritative for the per-alert VOICE override, which this row preserves
// without ever authoring (audioChoice.ts) — two selects cannot show three dimensions, and
// silently dropping a voice the user chose would be the worst way to admit it.
//
// PREVIEW IS NOT REBUILT HERE. The row's ▶ already routes through `playAlertNow`, whose
// `speechPlan` decides sound vs speech from the very fields these selects write — so a def
// switched to "Voice (spoken)" SPEAKS when previewed, through the same seam that fires it for
// real. There is no second preview path and there must not be one.
//
// LAYOUT CONTRACT (inherited from SoundPicker, unchanged): in the alert list the two Selects
// must be columns of the ROW's shared grid template (see the grid comment in AlertList), so the
// wrapper is `display: contents` and each Select takes its width from the shared template
// instead of from whichever pack/line/phrase happens to be selected — every row lands its
// selects at the same x, and each one ellipsizes its displayed value rather than growing.

import { type JSX, useRef, useState } from 'react'
import {
  Box,
  Button,
  Divider,
  MenuItem,
  Popover,
  Select,
  Stack,
  TextField
} from '@mui/material'
import type { AlertDef, SoundPack, SpeechMode } from '@shared/types'
import { MAX_SPEECH_CHARS, SPEECH_MODES } from '@shared/speechText'
import { currentVoicePrefs } from '../../lib/speech'
import {
  OUTPUT_BOTH,
  OUTPUT_SPEECH,
  applyAudioChoice,
  audioChoiceOf,
  displayedChoice,
  outputValueOf,
  withOutput,
  writeBase,
  withPhrase,
  withSoundId,
  withSpeechMode
} from './audioChoice'
import { fallbackPack } from './SoundPicker'

/**
 * The annotation the voice entries carry while the master switch is off.
 *
 * They stay SELECTABLE: a def outlives the setting (an imported alert set, a profile switch, a
 * user who turns voice off for an evening), and `speechPlan` degrades a spoken alert to its
 * sound rather than to silence — so choosing one is a legitimate thing to do. What it must not
 * do is pretend. This is the same shape of honesty, and the same in-item wording style, that
 * VoiceSetting's engine picker uses for a tier that is not downloaded.
 */
const VOICE_OFF_NOTE = ' (voice is off — Preferences → Voice)'

/** The speak-what entries, as sentences rather than the def's field names. */
const SAY_LABELS: Record<SpeechMode, string> = {
  alertName: 'Speak: alert name',
  spellName: 'Speak: spell name',
  spellFirstWord: 'Speak: first word',
  custom: 'Speak: custom…'
}

/** A grid item must be allowed to shrink below its content for text-overflow to ever kick in. */
const GRID_SX = {
  minWidth: 0,
  width: '100%',
  '& .MuiSelect-select': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
} as const

/** The custom-phrase popover: capped, confirmable, and anchored on the select that opened it. */
function PhrasePopover({
  anchorEl,
  initial,
  onCancel,
  onCommit
}: {
  anchorEl: HTMLElement | null
  initial: string
  onCancel: () => void
  onCommit: (phrase: string) => void
}): JSX.Element {
  const [text, setText] = useState(initial)
  return (
    <Popover
      open={anchorEl != null}
      anchorEl={anchorEl}
      onClose={onCancel}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      slotProps={{ paper: { sx: { p: 1.25, width: 320 } } }}
    >
      <Stack spacing={1}>
        <TextField
          size="small"
          autoFocus
          fullWidth
          label="Say this"
          data-testid="alert-row-phrase"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommit(text)
          }}
          slotProps={{ htmlInput: { maxLength: MAX_SPEECH_CHARS } }}
          helperText={`${String(text.length)} / ${String(MAX_SPEECH_CHARS)}`}
        />
        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button size="small" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="small" variant="contained" onClick={() => onCommit(text)}>
            OK
          </Button>
        </Stack>
      </Stack>
    </Popover>
  )
}

export default function AudioPicker({
  packs,
  def,
  onChange
}: {
  packs: SoundPack[]
  def: AlertDef
  /** persist the whole def (the row's own upsert) — this writes four of its fields. */
  onChange: (next: AlertDef) => void
}): JSX.Element {
  // The popover is keyed so each opening starts from the def's CURRENT phrase: a cancelled edit
  // must not be what the next opening shows.
  const [phraseOpen, setPhraseOpen] = useState(0)
  const sayRef = useRef<HTMLDivElement>(null)

  const choice = audioChoiceOf(def)
  // The pack the def points at, or the shipped default when it points at an uninstalled one —
  // a Select whose value is not among its items renders empty and warns.
  const pack = packs.find((p) => p.id === choice.packId) ?? fallbackPack(packs)
  const soundIds = pack ? Object.keys(pack.sounds) : []
  // What the selects show, and what an edit is applied to — NOT always the same thing when no
  // pack has resolved yet (audioChoice.ts: `writeBase`).
  const view = displayedChoice(choice, pack)
  const base = writeBase(choice, pack)
  const speaksOnly = choice.audio === 'speech'
  const voiceNote = currentVoicePrefs().enabled ? '' : VOICE_OFF_NOTE
  const commit = (next: typeof choice): void => onChange(applyAudioChoice(def, next))

  return (
    <Box sx={{ display: 'contents' }}>
      <Select
        size="small"
        data-testid="alert-output"
        value={outputValueOf(view)}
        onChange={(e) => commit(withOutput(base, e.target.value, packs))}
        sx={{ gridArea: 'voice', ...GRID_SX }}
      >
        {packs.map((p) => (
          <MenuItem key={p.id} value={p.id}>
            {p.name}
            {p.source === 'user' ? ' (user)' : ''}
          </MenuItem>
        ))}
        <Divider />
        <MenuItem value={OUTPUT_SPEECH}>Voice (spoken){voiceNote}</MenuItem>
        <MenuItem value={OUTPUT_BOTH}>Sound + voice{voiceNote}</MenuItem>
      </Select>

      {speaksOnly ? (
        <Select
          size="small"
          ref={sayRef}
          data-testid="alert-say"
          value={view.mode}
          onChange={(e) => {
            const mode = e.target.value as SpeechMode
            // Custom is the one mode that needs a value from the user, so it asks for it right
            // here instead of sending them to the editor.
            if (mode === 'custom') setPhraseOpen((n) => n + 1)
            else commit(withSpeechMode(base, mode))
          }}
          sx={{ gridArea: 'line', ...GRID_SX }}
        >
          {SPEECH_MODES.map((m) => (
            <MenuItem key={m} value={m}>
              {m === 'custom' && view.phrase ? `Speak: “${view.phrase}”` : SAY_LABELS[m]}
            </MenuItem>
          ))}
        </Select>
      ) : (
        <Select
          size="small"
          data-testid="alert-sound"
          value={view.soundId}
          onChange={(e) => commit(withSoundId(base, e.target.value))}
          sx={{ gridArea: 'line', ...GRID_SX }}
        >
          {soundIds.map((sid) => (
            <MenuItem key={sid} value={sid}>
              {pack?.sounds[sid]?.label ?? sid}
            </MenuItem>
          ))}
        </Select>
      )}

      {phraseOpen > 0 && (
        <PhrasePopover
          key={phraseOpen}
          anchorEl={sayRef.current}
          initial={view.phrase}
          onCancel={() => setPhraseOpen(0)}
          onCommit={(phrase) => {
            commit(withPhrase(base, phrase))
            setPhraseOpen(0)
          }}
        />
      )}
    </Box>
  )
}
