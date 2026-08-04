// AlertDialog — the add/EDIT dialog for one alert. Extracted from AlertsView.tsx
// (Wave D factoring); the form's behavior, validation and saved shape are unchanged.
//
// `initial` is null for "add", or an existing def for "edit" (including a seeded
// built-in — no special casing beyond keeping its id stable).

import {
  type Dispatch,
  type JSX,
  type SetStateAction,
  useEffect,
  useState
} from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Paper,
  Select,
  Slider,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import type { AlertDef, AlertTrigger, SoundPack } from '@shared/types'
import {
  blankCondition,
  type CombineMode,
  type ConditionDraft,
  conditionFieldValErr,
  conditionRawErr,
  draftFromPrimitive,
  primitiveFromDraft
} from './conditionDraft'
import ConditionEditor from './ConditionEditor'
import SoundPicker, { fallbackPack, firstSoundId } from './SoundPicker'
import SpeechBlock, { type SpeechForm, speechFieldsFor, useSpeechForm } from './SpeechBlock'
import { DEFAULT_PACK_ID } from './suggestions'

const DEFAULT_COOLDOWN_MS = 2000

function newId(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'alert'
  return `${base}-${Math.random().toString(36).slice(2, 6)}`
}

/** Everything the dialog's form owns; `useAlertForm` hydrates it from `initial`. */
interface AlertForm {
  name: string
  setName: (v: string) => void
  mode: CombineMode
  changeMode: (next: CombineMode) => void
  conditions: ConditionDraft[]
  setConditions: Dispatch<SetStateAction<ConditionDraft[]>>
  packId: string
  soundId: string
  setSound: (packId: string, soundId: string) => void
  volume: number
  setVolume: (v: number) => void
  cooldownMs: number
  setCooldownMs: (v: number) => void
  /** The Speech block's own sub-form (voice-alerts §4) — see SpeechBlock.tsx. */
  speech: SpeechForm
}

function useAlertForm(open: boolean, initial: AlertDef | null, packs: SoundPack[]): AlertForm {
  const [name, setName] = useState('')
  const [mode, setMode] = useState<CombineMode>('single')
  const [conditions, setConditions] = useState<ConditionDraft[]>([blankCondition()])
  const [packId, setPackId] = useState(fallbackPack(packs)?.id ?? DEFAULT_PACK_ID)
  const [soundId, setSoundId] = useState(firstSoundId(fallbackPack(packs)))
  const [volume, setVolume] = useState(1)
  const [cooldownMs, setCooldownMs] = useState(DEFAULT_COOLDOWN_MS)
  // The Speech block hydrates itself from the same `open`/`initial` pair.
  const speech = useSpeechForm(open, initial)

  // Hydrate the form from `initial` (edit) or blanks (add) whenever it opens.
  useEffect(() => {
    if (!open) return
    if (initial) {
      setName(initial.name)
      const t = initial.trigger
      if ('conditions' in t) {
        setMode(t.type)
        setConditions(t.conditions.length ? t.conditions.map(draftFromPrimitive) : [blankCondition()])
      } else {
        setMode('single')
        setConditions([draftFromPrimitive(t)])
      }
      setPackId(initial.sound.packId)
      setSoundId(initial.sound.soundId)
      setVolume(initial.volume ?? 1)
      setCooldownMs(initial.cooldownMs ?? DEFAULT_COOLDOWN_MS)
    } else {
      setName('')
      setMode('single')
      setConditions([blankCondition()])
      const preset = fallbackPack(packs)
      setPackId(preset?.id ?? DEFAULT_PACK_ID)
      setSoundId(firstSoundId(preset))
      setVolume(1)
      setCooldownMs(DEFAULT_COOLDOWN_MS)
    }
  }, [open, initial, packs])

  // Switching INTO a composite from single keeps the existing condition and adds a second so
  // the OR/AND is meaningful; switching back to single collapses to the first condition.
  const changeMode = (next: CombineMode): void => {
    setMode(next)
    if (next === 'single') setConditions((prev) => prev.slice(0, 1))
    else setConditions((prev) => (prev.length >= 2 ? prev : [...prev, blankCondition()]))
  }

  const setSound = (p: string, s: string): void => {
    setPackId(p)
    setSoundId(s)
  }

  return {
    name,
    setName,
    mode,
    changeMode,
    conditions,
    setConditions,
    packId,
    soundId,
    setSound,
    volume,
    setVolume,
    cooldownMs,
    setCooldownMs,
    speech
  }
}

function triggerFromForm(mode: CombineMode, conditions: ConditionDraft[]): AlertTrigger {
  if (mode === 'single') return primitiveFromDraft(conditions[0])
  return { type: mode, conditions: conditions.map(primitiveFromDraft) }
}

function formCanSave(f: AlertForm): boolean {
  const conditionsValid = f.conditions.every(
    (c) => conditionRawErr(c) == null && conditionFieldValErr(c) == null
  )
  return (
    f.name.trim().length > 0 &&
    f.conditions.length > 0 &&
    conditionsValid &&
    f.packId.length > 0 &&
    f.soundId.length > 0
  )
}

function defFromForm(f: AlertForm, initial: AlertDef | null): AlertDef {
  return {
    // Preserve id + note on edit (stable ids for built-ins); mint on add.
    id: initial?.id ?? newId(f.name),
    name: f.name.trim(),
    enabled: initial?.enabled ?? true,
    trigger: triggerFromForm(f.mode, f.conditions),
    sound: { packId: f.packId, soundId: f.soundId },
    volume: f.volume,
    cooldownMs: f.cooldownMs,
    note: initial?.note,
    // audio / speech / alwaysPlay, each omitted at its default so a sound-only alert saves
    // byte-identically to how it always did (SpeechBlock.speechFieldsFor).
    ...speechFieldsFor(f.speech)
  }
}

/** "Fire when…" — the single/any/all combine-mode picker plus the same-event caveat. */
function CombineModeSection({
  mode,
  onChange
}: {
  mode: CombineMode
  onChange: (next: CombineMode) => void
}): JSX.Element {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        Fire when…
      </Typography>
      <Select
        size="small"
        fullWidth
        value={mode}
        onChange={(e) => onChange(e.target.value as CombineMode)}
      >
        <MenuItem value="single">a single condition matches</MenuItem>
        <MenuItem value="any">ANY of these conditions matches (or)</MenuItem>
        <MenuItem value="all">ALL of these match the same event (and)</MenuItem>
      </Select>
      {mode === 'all' && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
          “All” requires every condition to match the SAME incoming log event (same-event,
          not a correlation window).
        </Typography>
      )}
    </Box>
  )
}

/** One numbered condition card inside a composite trigger. */
function ConditionRow({
  index,
  draft,
  canRemove,
  onChange,
  onRemove
}: {
  index: number
  draft: ConditionDraft
  canRemove: boolean
  onChange: (next: ConditionDraft) => void
  onRemove: () => void
}): JSX.Element {
  return (
    <Paper variant="outlined" sx={{ p: 1.25, position: 'relative' }}>
      <Stack direction="row" alignItems="center" sx={{ mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
          Condition {index + 1}
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title="Remove condition">
          <span>
            <IconButton size="small" color="error" disabled={!canRemove} onClick={onRemove}>
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      <ConditionEditor draft={draft} onChange={onChange} />
    </Paper>
  )
}

/** Single mode renders one bare editor; composite modes render the add/remove list. */
function ConditionsSection({
  mode,
  conditions,
  setConditions
}: {
  mode: CombineMode
  conditions: ConditionDraft[]
  setConditions: Dispatch<SetStateAction<ConditionDraft[]>>
}): JSX.Element {
  const setCondition = (i: number, next: ConditionDraft): void =>
    setConditions((prev) => prev.map((c, j) => (j === i ? next : c)))
  const addCondition = (): void => setConditions((prev) => [...prev, blankCondition()])
  const removeCondition = (i: number): void =>
    setConditions((prev) => (prev.length <= 1 ? prev : prev.filter((_, j) => j !== i)))

  if (mode === 'single') {
    return <ConditionEditor draft={conditions[0]} onChange={(next) => setCondition(0, next)} />
  }
  return (
    <Stack spacing={1.5}>
      {conditions.map((c, i) => (
        <ConditionRow
          key={i}
          index={i}
          draft={c}
          canRemove={conditions.length > 1}
          onChange={(next) => setCondition(i, next)}
          onRemove={() => removeCondition(i)}
        />
      ))}
      <Button startIcon={<AddIcon />} size="small" onClick={addCondition} sx={{ alignSelf: 'flex-start' }}>
        Add condition
      </Button>
    </Stack>
  )
}

/** The per-alert volume slider + cooldown field. */
function VolumeCooldownSection({
  volume,
  setVolume,
  cooldownMs,
  setCooldownMs
}: {
  volume: number
  setVolume: (v: number) => void
  cooldownMs: number
  setCooldownMs: (v: number) => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap" useFlexGap>
      <Stack sx={{ minWidth: 180 }}>
        <Typography variant="caption" color="text.secondary">
          Volume ({Math.round(volume * 100)}%)
        </Typography>
        <Slider
          size="small"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(_e, v) => setVolume(v as number)}
          sx={{ width: 160 }}
        />
      </Stack>
      <TextField
        size="small"
        type="number"
        label="Cooldown (ms)"
        value={cooldownMs}
        onChange={(e) => setCooldownMs(Math.max(0, Number(e.target.value) || 0))}
        sx={{ width: 140 }}
      />
    </Stack>
  )
}

export default function AlertDialog({
  open,
  initial,
  packs,
  onClose,
  onSave
}: {
  open: boolean
  initial: AlertDef | null
  packs: SoundPack[]
  onClose: () => void
  onSave: (def: AlertDef) => void
}): JSX.Element {
  const f = useAlertForm(open, initial, packs)
  const editing = initial != null

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth data-testid="alert-dialog">
      <DialogTitle>{editing ? `Edit alert — ${initial?.name}` : 'Add alert'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            size="small"
            label="Name"
            value={f.name}
            onChange={(e) => f.setName(e.target.value)}
            autoFocus
          />
          <CombineModeSection mode={f.mode} onChange={f.changeMode} />

          <ConditionsSection
            mode={f.mode}
            conditions={f.conditions}
            setConditions={f.setConditions}
          />

          <Divider />
          <Box>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
              Sound
            </Typography>
            <SoundPicker
              packs={packs}
              packId={f.packId}
              soundId={f.soundId}
              onChange={f.setSound}
            />
          </Box>

          <VolumeCooldownSection
            volume={f.volume}
            setVolume={f.setVolume}
            cooldownMs={f.cooldownMs}
            setCooldownMs={f.setCooldownMs}
          />

          <Divider />
          <SpeechBlock name={f.name} form={f.speech} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          data-testid="alert-save"
          disabled={!formCanSave(f)}
          onClick={() => onSave(defFromForm(f, initial))}
        >
          {editing ? 'Save' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
