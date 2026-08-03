// AlertsView — manage triggered-sound alerts + global sound preferences.
//
// Layout (dense, dark, matches the app):
//   - a top bar with the global volume slider + mute toggle, "Sound packs…"
//     (opens the openpeon.com registry browser — Task #29), "Add alert", and a
//     "Reset to defaults" button (restores the seeded built-in set, confirmed),
//   - a list of alerts, each with an enable switch, per-alert volume, a
//     pack→sound picker, a compact trigger chip, Test / Edit / Delete, and an
//     expandable "recent fires" panel (time + the actual matched log line),
//   - an add/EDIT dialog: every alert — including the seeded built-ins — opens in
//     it (name, trigger type/kind/where, raw regex with live validation, sound,
//     volume, cooldown). Built-ins are just stored defs with stable ids.
//
// Recent fires come from the alerts module's per-alert ring buffer (the single
// source of truth), hydrated + kept live via useModule: event/raw fires arrive as
// module deltas, and renderer 'app' fires are routed back through main (appFired)
// so they land in the same history.
//
// Everything else is persisted via IPC (alerts:save / alerts:reset /
// alertPrefs:set); after any write we call refreshAlertStore() so the always-
// mounted AlertPlayer picks up the change immediately (it shares def/pref state).

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Select,
  Slider,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import EditIcon from '@mui/icons-material/Edit'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import VolumeUpIcon from '@mui/icons-material/VolumeUp'
import VolumeOffIcon from '@mui/icons-material/VolumeOff'
import HistoryIcon from '@mui/icons-material/History'
import LibraryMusicIcon from '@mui/icons-material/LibraryMusic'
import IosShareIcon from '@mui/icons-material/IosShare'
import FileUploadIcon from '@mui/icons-material/FileUpload'
import Snackbar from '@mui/material/Snackbar'
import MuiAlert from '@mui/material/Alert'
import type {
  AlertDef,
  AlertFireRecord,
  AlertPrefs,
  AlertsDelta,
  AlertsSnap,
  AlertTrigger,
  AlertTriggerPrimitive,
  AppSignal,
  LogEventKind,
  SoundPack
} from '@shared/types'
import { ALL_LOG_EVENT_KINDS } from '@shared/logEventKinds'
import { useModule } from '../../lib/useModule'
import { formatTime } from '../../lib/formatDate'
import { onAlertStoreChange, playAlertNow, refreshAlertStore } from './player'
import SoundPacksDialog from './SoundPacksDialog'
import SuggestAlertsDialog from './SuggestAlertsDialog'
import { invalidateSoundCaches } from './soundCache'
import { DEFAULT_PACK_ID } from './suggestions'
import ShareImportDialog from '../profiles/ShareImportDialog'
import { copyText } from '../../lib/clipboard'

// The LogEvent kinds an 'event' trigger can select. Derived from the LogEventKind union
// (ALL_LOG_EVENT_KINDS is exhaustiveness-checked) so the picker can NEVER drift from the real
// set of events a trigger can match (Task #47 — this absorbs the previously hand-maintained,
// already-stale list which was missing buff/cast/cc kinds entirely).
const EVENT_KINDS: readonly LogEventKind[] = ALL_LOG_EVENT_KINDS
const APP_SIGNALS: AppSignal[] = ['bossDefeat', 'questComplete']

const APP_SIGNAL_LABEL: Record<AppSignal, string> = {
  bossDefeat: 'Raid target defeated',
  questComplete: 'Quest completed'
}

const DEFAULT_COOLDOWN_MS = 2000

/** Compact badge for ONE primitive condition: `event:uncharm`, `raw:/regex/i`, `app:bossDefeat`. */
function primitiveBadge(t: AlertTriggerPrimitive): string {
  if (t.type === 'event') {
    const where = t.where && Object.keys(t.where).length
      ? ` {${Object.entries(t.where).map(([k, v]) => `${k}=${v}`).join(', ')}}`
      : ''
    return `event:${t.kind}${where}`
  }
  if (t.type === 'raw') return `raw:/${t.regex}/i`
  return `app:${t.signal}`
}

/** Compact trigger badge; a composite renders `any(…, …)` / `all(…, …)` (Task #47). */
function triggerBadge(t: AlertTrigger): string {
  if ('conditions' in t) {
    return `${t.type}(${t.conditions.map(primitiveBadge).join(', ')})`
  }
  return primitiveBadge(t)
}

/** Validate a raw regex live; returns an error string or null. */
function regexError(src: string): string | null {
  if (!src.trim()) return 'Enter a pattern'
  try {
    // eslint-disable-next-line no-new
    new RegExp(src, 'i')
    return null
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid regex'
  }
}

function newId(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'alert'
  return `${base}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * The pack a picker falls back to when the alert's own pack is missing (uninstalled) or
 * a brand-new alert has no pack yet: the SHIPPED default (Alan Rickman), never
 * "whatever happens to sort first". Only if that pack somehow isn't installed do we
 * take the first available one.
 */
function fallbackPack(packs: SoundPack[]): SoundPack | undefined {
  return packs.find((p) => p.id === DEFAULT_PACK_ID) ?? packs[0]
}

/** First selectable soundId in a pack ('' when packs haven't loaded yet). */
function firstSoundId(pack: SoundPack | undefined): string {
  return pack ? Object.keys(pack.sounds)[0] ?? '' : ''
}

/** The pack→sound picker used inline per-alert and in the add/edit dialog. */
function SoundPicker({
  packs,
  packId,
  soundId,
  onChange
}: {
  packs: SoundPack[]
  packId: string
  soundId: string
  onChange: (packId: string, soundId: string) => void
}): JSX.Element {
  const pack = packs.find((p) => p.id === packId) ?? fallbackPack(packs)
  const soundIds = pack ? Object.keys(pack.sounds) : []
  return (
    <Stack direction="row" spacing={1}>
      <Select
        size="small"
        value={pack?.id ?? ''}
        onChange={(e) => {
          const np = packs.find((p) => p.id === e.target.value)
          const firstSound = np ? Object.keys(np.sounds)[0] : ''
          onChange(e.target.value, firstSound)
        }}
        sx={{ minWidth: 130 }}
      >
        {packs.map((p) => (
          <MenuItem key={p.id} value={p.id}>
            {p.name}
            {p.source === 'user' ? ' (user)' : ''}
          </MenuItem>
        ))}
      </Select>
      <Select
        size="small"
        value={pack && pack.sounds[soundId] ? soundId : soundIds[0] ?? ''}
        onChange={(e) => onChange(pack?.id ?? packId, e.target.value)}
        sx={{ minWidth: 170 }}
      >
        {soundIds.map((sid) => (
          <MenuItem key={sid} value={sid}>
            {pack?.sounds[sid]?.label ?? sid}
          </MenuItem>
        ))}
      </Select>
    </Stack>
  )
}

// ── Composite-trigger editing (Task #47) ──────────────────────────────────────
//
// The dialog edits triggers as a "combine mode" (single / any / all) over a LIST of primitive
// CONDITION DRAFTS. A single-condition alert is `mode:'single'` (backward-compatible: renders
// exactly like before). `any`/`all` show the condition list with add/remove rows. Each draft
// holds the union of every primitive's fields; only the relevant ones are read per type.

type CombineMode = 'single' | 'any' | 'all'

interface ConditionDraft {
  ttype: AlertTriggerPrimitive['type']
  kind: LogEventKind
  fieldKey: string
  fieldVal: string
  regex: string
  signal: AppSignal
}

function blankCondition(): ConditionDraft {
  return { ttype: 'event', kind: 'uncharm', fieldKey: '', fieldVal: '', regex: '', signal: 'bossDefeat' }
}

/** Hydrate a condition draft from a stored primitive trigger. */
function draftFromPrimitive(t: AlertTriggerPrimitive): ConditionDraft {
  const d = blankCondition()
  d.ttype = t.type
  if (t.type === 'event') {
    d.kind = t.kind
    const first = t.where ? Object.entries(t.where)[0] : undefined
    d.fieldKey = first?.[0] ?? ''
    d.fieldVal = first?.[1] ?? ''
  } else if (t.type === 'raw') {
    d.regex = t.regex
  } else {
    d.signal = t.signal
  }
  return d
}

/** Build a stored primitive trigger from a condition draft. */
function primitiveFromDraft(d: ConditionDraft): AlertTriggerPrimitive {
  if (d.ttype === 'raw') return { type: 'raw', regex: d.regex }
  if (d.ttype === 'app') return { type: 'app', signal: d.signal }
  const where =
    d.fieldKey.trim() && d.fieldVal.trim() ? { [d.fieldKey.trim()]: d.fieldVal.trim() } : undefined
  return { type: 'event', kind: d.kind, where }
}

/** The /regex/ validation error for a condition draft's field value, or null. */
function conditionFieldValErr(d: ConditionDraft): string | null {
  if (d.ttype !== 'event') return null
  const v = d.fieldVal.trim()
  return v.startsWith('/') && v.endsWith('/') ? regexError(v.slice(1, -1)) : null
}

/** The raw-regex validation error for a condition draft, or null. */
function conditionRawErr(d: ConditionDraft): string | null {
  return d.ttype === 'raw' ? regexError(d.regex) : null
}

/** Editor for ONE primitive condition (reused for single + each composite row). */
function ConditionEditor({
  draft,
  onChange
}: {
  draft: ConditionDraft
  onChange: (next: ConditionDraft) => void
}): JSX.Element {
  const set = (patch: Partial<ConditionDraft>): void => onChange({ ...draft, ...patch })
  const rawErr = conditionRawErr(draft)
  const fieldValErr = conditionFieldValErr(draft)
  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography variant="caption" color="text.secondary">
          Trigger type
        </Typography>
        <Select
          size="small"
          fullWidth
          value={draft.ttype}
          onChange={(e) => set({ ttype: e.target.value as AlertTriggerPrimitive['type'] })}
        >
          <MenuItem value="event">Log event (typed)</MenuItem>
          <MenuItem value="raw">Raw line (regex)</MenuItem>
          <MenuItem value="app">App signal</MenuItem>
        </Select>
      </Box>

      {draft.ttype === 'event' && (
        <>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Event kind
            </Typography>
            <Select
              size="small"
              fullWidth
              value={draft.kind}
              onChange={(e) => set({ kind: e.target.value as LogEventKind })}
            >
              {EVENT_KINDS.map((k) => (
                <MenuItem key={k} value={k}>
                  {k}
                </MenuItem>
              ))}
            </Select>
          </Box>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              label="Field (optional)"
              placeholder="e.g. spell, target"
              value={draft.fieldKey}
              onChange={(e) => set({ fieldKey: e.target.value })}
              fullWidth
            />
            <TextField
              size="small"
              label="Equals or /regex/"
              value={draft.fieldVal}
              onChange={(e) => set({ fieldVal: e.target.value })}
              error={fieldValErr != null}
              helperText={fieldValErr ?? ' '}
              fullWidth
            />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Leave the field blank to fire on every {draft.kind} event. A value in /slashes/ is a
            case-insensitive regex. For <code>buffExpired</code>, use <code>target</code>=
            <code>self</code> for your own buffs, or omit <code>target</code> to match a buff
            wearing off you OR your pet/target.
          </Typography>
        </>
      )}

      {draft.ttype === 'raw' && (
        <>
          <TextField
            size="small"
            label="Regex (matched against the raw log line, case-insensitive)"
            value={draft.regex}
            onChange={(e) => set({ regex: e.target.value })}
            error={rawErr != null}
            helperText={rawErr ?? 'Valid pattern'}
          />
          <Typography variant="caption" color="text.secondary">
            Matches anywhere in the line. Escape regex metacharacters
            (e.g. <code>\.</code>, <code>\(</code>) with a backslash.
          </Typography>
        </>
      )}

      {draft.ttype === 'app' && (
        <Box>
          <Typography variant="caption" color="text.secondary">
            Signal
          </Typography>
          <Select
            size="small"
            fullWidth
            value={draft.signal}
            onChange={(e) => set({ signal: e.target.value as AppSignal })}
          >
            {APP_SIGNALS.map((s) => (
              <MenuItem key={s} value={s}>
                {APP_SIGNAL_LABEL[s]}
              </MenuItem>
            ))}
          </Select>
        </Box>
      )}
    </Stack>
  )
}

/**
 * The add/edit dialog. `initial` is null for "add", or an existing def for "edit"
 * (including a seeded built-in — no special casing beyond keeping its id stable).
 */
function AlertDialog({
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
  const [name, setName] = useState('')
  const [mode, setMode] = useState<CombineMode>('single')
  const [conditions, setConditions] = useState<ConditionDraft[]>([blankCondition()])
  const [packId, setPackId] = useState(fallbackPack(packs)?.id ?? DEFAULT_PACK_ID)
  const [soundId, setSoundId] = useState(firstSoundId(fallbackPack(packs)))
  const [volume, setVolume] = useState(1)
  const [cooldownMs, setCooldownMs] = useState(DEFAULT_COOLDOWN_MS)

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

  const setCondition = (i: number, next: ConditionDraft): void =>
    setConditions((prev) => prev.map((c, j) => (j === i ? next : c)))
  const addCondition = (): void => setConditions((prev) => [...prev, blankCondition()])
  const removeCondition = (i: number): void =>
    setConditions((prev) => (prev.length <= 1 ? prev : prev.filter((_, j) => j !== i)))

  // Switching INTO a composite from single keeps the existing condition and adds a second so
  // the OR/AND is meaningful; switching back to single collapses to the first condition.
  const changeMode = (next: CombineMode): void => {
    setMode(next)
    if (next === 'single') setConditions((prev) => prev.slice(0, 1))
    else setConditions((prev) => (prev.length >= 2 ? prev : [...prev, blankCondition()]))
  }

  const buildTrigger = (): AlertTrigger => {
    if (mode === 'single') return primitiveFromDraft(conditions[0])
    return { type: mode, conditions: conditions.map(primitiveFromDraft) }
  }

  const conditionsValid = conditions.every(
    (c) => conditionRawErr(c) == null && conditionFieldValErr(c) == null
  )

  const canSave =
    name.trim().length > 0 &&
    conditions.length > 0 &&
    conditionsValid &&
    packId.length > 0 &&
    soundId.length > 0

  const editing = initial != null

  const submit = (): void => {
    onSave({
      // Preserve id + note on edit (stable ids for built-ins); mint on add.
      id: initial?.id ?? newId(name),
      name: name.trim(),
      enabled: initial?.enabled ?? true,
      trigger: buildTrigger(),
      sound: { packId, soundId },
      volume,
      cooldownMs,
      note: initial?.note
    })
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{editing ? `Edit alert — ${initial?.name}` : 'Add alert'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            size="small"
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <Box>
            <Typography variant="caption" color="text.secondary">
              Fire when…
            </Typography>
            <Select
              size="small"
              fullWidth
              value={mode}
              onChange={(e) => changeMode(e.target.value as CombineMode)}
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

          {mode === 'single' ? (
            <ConditionEditor draft={conditions[0]} onChange={(next) => setCondition(0, next)} />
          ) : (
            <Stack spacing={1.5}>
              {conditions.map((c, i) => (
                <Paper key={i} variant="outlined" sx={{ p: 1.25, position: 'relative' }}>
                  <Stack direction="row" alignItems="center" sx={{ mb: 0.5 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                      Condition {i + 1}
                    </Typography>
                    <Box sx={{ flexGrow: 1 }} />
                    <Tooltip title="Remove condition">
                      <span>
                        <IconButton
                          size="small"
                          color="error"
                          disabled={conditions.length <= 1}
                          onClick={() => removeCondition(i)}
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Stack>
                  <ConditionEditor draft={c} onChange={(next) => setCondition(i, next)} />
                </Paper>
              ))}
              <Button startIcon={<AddIcon />} size="small" onClick={addCondition} sx={{ alignSelf: 'flex-start' }}>
                Add condition
              </Button>
            </Stack>
          )}

          <Divider />
          <Box>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
              Sound
            </Typography>
            <SoundPicker
              packs={packs}
              packId={packId}
              soundId={soundId}
              onChange={(p, s) => {
                setPackId(p)
                setSoundId(s)
              }}
            />
          </Box>

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
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!canSave} onClick={submit}>
          {editing ? 'Save' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** The expandable "recent fires" panel for one alert. */
function RecentFires({ fires }: { fires: AlertFireRecord[] }): JSX.Element {
  if (fires.length === 0) {
    return (
      <Typography variant="caption" color="text.disabled" sx={{ pl: 1 }}>
        No fires recorded yet.
      </Typography>
    )
  }
  // Newest first for reading.
  const rows = [...fires].reverse()
  return (
    <Box sx={{ pl: 1, py: 0.5 }}>
      {rows.map((f, i) => (
        <Box
          key={`${f.ts}-${i}`}
          sx={{
            display: 'flex',
            gap: 1,
            fontFamily: 'monospace',
            fontSize: 11,
            lineHeight: 1.5,
            color: 'text.secondary'
          }}
        >
          <Box component="span" sx={{ color: 'text.disabled', whiteSpace: 'nowrap' }}>
            {formatTime(f.ts, { hour12: true })}
          </Box>
          <Box component="span" sx={{ wordBreak: 'break-all' }}>
            {f.matchedText || '(no matched text)'}
          </Box>
        </Box>
      ))}
    </Box>
  )
}

function applyAlertsDelta(state: AlertsSnap, delta: AlertsDelta): AlertsSnap {
  if (!delta.fired?.length) return state
  const history = { ...state.history }
  for (const f of delta.fired) {
    const arr = (history[f.alertId] ?? []).concat({ ts: f.ts, matchedText: f.matchedText })
    // Mirror the module's HISTORY_CAP of 20 so the renderer copy stays bounded.
    history[f.alertId] = arr.length > 20 ? arr.slice(arr.length - 20) : arr
  }
  return { ...state, history }
}

export default function AlertsView(): JSX.Element {
  const [alerts, setAlerts] = useState<AlertDef[]>([])
  const [prefs, setPrefs] = useState<AlertPrefs>({ globalVolume: 0.7, muted: false })
  const [packs, setPacks] = useState<SoundPack[]>([])
  // null = closed, undefined-initial via `editing` sentinel below.
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<AlertDef | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [packsDialogOpen, setPacksDialogOpen] = useState(false)
  const [suggestOpen, setSuggestOpen] = useState(false)
  // Sharing (src/shared/profiles.ts): copy one/all alerts as a paste-safe EQC1- string, or
  // import someone else's ADDITIVELY through the shared preview dialog.
  const [importOpen, setImportOpen] = useState(false)
  const [toast, setToast] = useState<{ severity: 'success' | 'warning'; text: string } | null>(null)

  // Live recent-fires history from the alerts module (single source of truth).
  const snap = useModule<AlertsSnap, AlertsDelta>('alerts', applyAlertsDelta)
  const history = snap?.history ?? {}

  const reload = useCallback(async () => {
    const [a, p, ps] = await Promise.all([
      window.eq.listAlerts(),
      window.eq.getAlertPrefs(),
      window.eq.listSoundPacks()
    ])
    setAlerts(a)
    setPrefs(p)
    setPacks(ps)
  }, [])

  useEffect(() => {
    void reload()
    // Keep in sync if the player refreshes the shared store (e.g. on focus).
    const off = onAlertStoreChange(() => void reload())
    // A shipped default pack may finish auto-provisioning after startup — re-list packs
    // and drop any stale sound caches so it's immediately selectable/playable (Task #39).
    const offPacks = window.eq.onSoundPacksChanged(() => {
      invalidateSoundCaches()
      void reload()
    })
    return () => {
      off()
      offPacks()
    }
  }, [reload])

  // After a registry install/uninstall, re-list packs so the inline pickers +
  // add/edit dialog surface the change immediately, and refresh the always-mounted
  // player's shared store (it caches nothing pack-related, but keeps everything in
  // sync on the same tick).
  const refreshPacks = useCallback(async () => {
    const ps = await window.eq.listSoundPacks()
    setPacks(ps)
    await refreshAlertStore()
  }, [])

  const persistAlerts = useCallback(async (def: AlertDef) => {
    const list = await window.eq.saveAlert(def)
    setAlerts(list)
    await refreshAlertStore()
  }, [])

  const removeAlert = useCallback(async (id: string) => {
    const list = await window.eq.deleteAlert(id)
    setAlerts(list)
    await refreshAlertStore()
  }, [])

  const doReset = useCallback(async () => {
    const list = await window.eq.resetAlerts()
    setAlerts(list)
    await refreshAlertStore()
    setConfirmReset(false)
  }, [])

  const persistPrefs = useCallback(async (next: AlertPrefs) => {
    setPrefs(next)
    await window.eq.setAlertPrefs(next)
    await refreshAlertStore()
  }, [])

  const test = useCallback((def: AlertDef) => {
    // Play directly at the current global × per-alert volume (ignores mute so the
    // user can hear what they're configuring).
    playAlertNow({ ...def, enabled: true })
  }, [])

  /** Copy a share string for one alert (`ids:[id]`) or every alert (`ids` omitted). */
  const copyShare = useCallback(async (ids?: string[]) => {
    const text = await window.eq.exportAlertsShare(ids)
    const ok = await copyText(text)
    const what = ids?.length === 1 ? 'Alert' : 'All alerts'
    setToast(
      ok
        ? { severity: 'success', text: `${what} copied — paste it to share (${text.length} chars).` }
        : { severity: 'warning', text: 'Could not reach the clipboard.' }
    )
  }, [])

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const sortedPacks = useMemo(
    () => [...packs].sort((a, b) => (a.source === b.source ? 0 : a.source === 'bundled' ? -1 : 1)),
    [packs]
  )

  // ids of alerts that already exist — the Suggest wizard renders those suggestions as
  // checked/disabled (match by the stable `suggest:<key>:<template>` id convention).
  const existingIds = useMemo(() => new Set(alerts.map((a) => a.id)), [alerts])

  const openAdd = (): void => {
    setEditTarget(null)
    setDialogOpen(true)
  }
  const openEdit = (def: AlertDef): void => {
    setEditTarget(def)
    setDialogOpen(true)
  }

  return (
    <Stack spacing={2} sx={{ height: '100%' }}>
      {/* Global controls */}
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap" useFlexGap>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 240 }}>
            {prefs.muted ? <VolumeOffIcon color="disabled" /> : <VolumeUpIcon color="primary" />}
            <Typography variant="body2" sx={{ width: 90 }}>
              Global volume
            </Typography>
            <Slider
              size="small"
              min={0}
              max={1}
              step={0.05}
              value={prefs.globalVolume}
              onChange={(_e, v) => setPrefs({ ...prefs, globalVolume: v as number })}
              onChangeCommitted={(_e, v) =>
                void persistPrefs({ ...prefs, globalVolume: v as number })
              }
              sx={{ width: 140 }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ width: 34 }}>
              {Math.round(prefs.globalVolume * 100)}%
            </Typography>
          </Stack>
          <FormControlLabel
            control={
              <Switch
                checked={prefs.muted}
                onChange={(e) => void persistPrefs({ ...prefs, muted: e.target.checked })}
              />
            }
            label="Mute all"
          />
          <Box sx={{ flexGrow: 1 }} />
          <Button
            startIcon={<LibraryMusicIcon />}
            variant="outlined"
            size="small"
            onClick={() => setPacksDialogOpen(true)}
          >
            Sound packs…
          </Button>
          <Tooltip title="Copy every alert as one share string">
            <span>
              <Button
                startIcon={<IosShareIcon />}
                variant="outlined"
                size="small"
                disabled={alerts.length === 0}
                onClick={() => void copyShare()}
              >
                Copy all
              </Button>
            </span>
          </Tooltip>
          <Button
            startIcon={<FileUploadIcon />}
            variant="outlined"
            size="small"
            onClick={() => setImportOpen(true)}
          >
            Import…
          </Button>
          <Button
            startIcon={<RestartAltIcon />}
            variant="outlined"
            size="small"
            color="warning"
            onClick={() => setConfirmReset(true)}
          >
            Reset to defaults
          </Button>
        </Stack>
      </Paper>

      {/* Alert list */}
      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        <Stack spacing={1}>
          {alerts.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No alerts yet. Add one to play a sound when something happens in your log.
            </Typography>
          )}
          {alerts.map((def) => {
            const fires = history[def.id] ?? []
            const isOpen = expanded.has(def.id)
            return (
              <Paper key={def.id} variant="outlined" sx={{ p: 1.25 }}>
                <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Switch
                    size="small"
                    checked={def.enabled}
                    onChange={(e) => void persistAlerts({ ...def, enabled: e.target.checked })}
                  />
                  <Box sx={{ minWidth: 200 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {def.name}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
                    >
                      {triggerBadge(def.trigger)}
                    </Typography>
                  </Box>

                  <SoundPicker
                    packs={sortedPacks}
                    packId={def.sound.packId}
                    soundId={def.sound.soundId}
                    onChange={(p, s) => void persistAlerts({ ...def, sound: { packId: p, soundId: s } })}
                  />

                  <Stack direction="row" spacing={1} alignItems="center" sx={{ width: 150 }}>
                    <Typography variant="caption" color="text.secondary">
                      vol
                    </Typography>
                    <Slider
                      size="small"
                      min={0}
                      max={1}
                      step={0.05}
                      value={def.volume ?? 1}
                      onChange={(_e, v) => setAlerts((prev) => prev.map((a) => (a.id === def.id ? { ...a, volume: v as number } : a)))}
                      onChangeCommitted={(_e, v) => void persistAlerts({ ...def, volume: v as number })}
                    />
                  </Stack>

                  <Box sx={{ flexGrow: 1 }} />
                  <Tooltip title={`Recent fires (${fires.length})`}>
                    <IconButton
                      size="small"
                      color={isOpen ? 'primary' : 'default'}
                      onClick={() => toggleExpanded(def.id)}
                    >
                      <HistoryIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Test (play now)">
                    <IconButton size="small" onClick={() => test(def)}>
                      <PlayArrowIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Copy share string for this alert">
                    <IconButton size="small" onClick={() => void copyShare([def.id])}>
                      <IosShareIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Edit">
                    <IconButton size="small" onClick={() => openEdit(def)}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete">
                    <IconButton size="small" color="error" onClick={() => void removeAlert(def.id)}>
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>

                <Collapse in={isOpen} unmountOnExit>
                  <Divider sx={{ my: 0.75 }} />
                  <Typography variant="caption" color="text.secondary" sx={{ pl: 1, fontWeight: 600 }}>
                    Recent fires
                  </Typography>
                  <RecentFires fires={fires} />
                </Collapse>
              </Paper>
            )
          })}

          {/* Single add flow (Task #54): 'Add from suggestion' sits BELOW the last alert and opens
              the suggestion picker, which itself carries a 'create manually' escape hatch. */}
          <Button
            startIcon={<AddIcon />}
            variant="outlined"
            onClick={() => setSuggestOpen(true)}
            sx={{ alignSelf: 'flex-start', mt: 0.5 }}
          >
            Add from suggestion…
          </Button>
        </Stack>
      </Box>

      <AlertDialog
        open={dialogOpen}
        initial={editTarget}
        packs={sortedPacks}
        onClose={() => setDialogOpen(false)}
        onSave={(def) => {
          void persistAlerts(def)
          setDialogOpen(false)
        }}
      />

      <SoundPacksDialog
        open={packsDialogOpen}
        onClose={() => setPacksDialogOpen(false)}
        onInstalledChange={() => void refreshPacks()}
      />

      <SuggestAlertsDialog
        open={suggestOpen}
        existingIds={existingIds}
        onClose={() => setSuggestOpen(false)}
        onCreate={persistAlerts}
        onDelete={removeAlert}
        onCreateManually={() => {
          // Escape hatch: close the picker and open the blank manual editor.
          setSuggestOpen(false)
          openAdd()
        }}
      />

      <ShareImportDialog
        open={importOpen}
        scope="alerts"
        onClose={() => setImportOpen(false)}
        onApplied={(res) => {
          void reload()
          void refreshAlertStore()
          setToast({
            severity: res.ok ? 'success' : 'warning',
            text: res.ok
              ? res.added
                ? `Added ${res.added} alert${res.added === 1 ? '' : 's'}${res.skipped ? `, skipped ${res.skipped} you already had` : ''}.`
                : 'Nothing to add — you already have every alert in that string.'
              : res.error ?? 'Import failed.'
          })
        }}
      />

      <Snackbar
        open={!!toast}
        autoHideDuration={5000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <MuiAlert severity={toast?.severity ?? 'success'} variant="filled" onClose={() => setToast(null)}>
          {toast?.text}
        </MuiAlert>
      </Snackbar>

      <Dialog open={confirmReset} onClose={() => setConfirmReset(false)} maxWidth="xs">
        <DialogTitle>Reset alerts to defaults?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            This replaces all alerts — including any you added or edited — with the
            seeded built-in set (Charm break + Raid target defeated). This can&apos;t be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmReset(false)}>Cancel</Button>
          <Button color="warning" variant="contained" onClick={() => void doReset()}>
            Reset
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
