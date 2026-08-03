// ConditionEditor — the editor for ONE primitive alert condition (reused for the
// dialog's single-condition mode and for each row of a composite any/all trigger).
//
// Extracted from AlertsView.tsx (Wave D factoring). The three type-specific field
// groups are separate components that render nothing for the other types, which is
// exactly what the `{draft.ttype === 'x' && (…)}` blocks did before.

import type { JSX } from 'react'
import { Box, MenuItem, Select, Stack, TextField, Typography } from '@mui/material'
import type { AlertTriggerPrimitive, AppSignal, LogEventKind } from '@shared/types'
import { ALL_LOG_EVENT_KINDS } from '@shared/logEventKinds'
import { type ConditionDraft, conditionFieldValErr, conditionRawErr } from './conditionDraft'

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

interface ConditionFieldProps {
  draft: ConditionDraft
  onChange: (next: ConditionDraft) => void
}

/** The typed-log-event fields (kind + optional where-clause); null for other types. */
function EventConditionFields({ draft, onChange }: ConditionFieldProps): JSX.Element | null {
  if (draft.ttype !== 'event') return null
  const set = (patch: Partial<ConditionDraft>): void => onChange({ ...draft, ...patch })
  const fieldValErr = conditionFieldValErr(draft)
  return (
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
  )
}

/** The raw-line regex field + its help text; null for other types. */
function RawConditionFields({ draft, onChange }: ConditionFieldProps): JSX.Element | null {
  if (draft.ttype !== 'raw') return null
  const rawErr = conditionRawErr(draft)
  return (
    <>
      <TextField
        size="small"
        label="Regex (matched against the raw log line, case-insensitive)"
        value={draft.regex}
        onChange={(e) => onChange({ ...draft, regex: e.target.value })}
        error={rawErr != null}
        helperText={rawErr ?? 'Valid pattern'}
      />
      <Typography variant="caption" color="text.secondary">
        Matches anywhere in the line. Escape regex metacharacters
        (e.g. <code>\.</code>, <code>\(</code>) with a backslash.
      </Typography>
    </>
  )
}

/** The app-signal picker; null for other types. */
function AppSignalField({ draft, onChange }: ConditionFieldProps): JSX.Element | null {
  if (draft.ttype !== 'app') return null
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        Signal
      </Typography>
      <Select
        size="small"
        fullWidth
        value={draft.signal}
        onChange={(e) => onChange({ ...draft, signal: e.target.value as AppSignal })}
      >
        {APP_SIGNALS.map((s) => (
          <MenuItem key={s} value={s}>
            {APP_SIGNAL_LABEL[s]}
          </MenuItem>
        ))}
      </Select>
    </Box>
  )
}

/** Editor for ONE primitive condition (reused for single + each composite row). */
export default function ConditionEditor({ draft, onChange }: ConditionFieldProps): JSX.Element {
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
          onChange={(e) =>
            onChange({ ...draft, ttype: e.target.value as AlertTriggerPrimitive['type'] })
          }
        >
          <MenuItem value="event">Log event (typed)</MenuItem>
          <MenuItem value="raw">Raw line (regex)</MenuItem>
          <MenuItem value="app">App signal</MenuItem>
        </Select>
      </Box>

      <EventConditionFields draft={draft} onChange={onChange} />
      <RawConditionFields draft={draft} onChange={onChange} />
      <AppSignalField draft={draft} onChange={onChange} />
    </Stack>
  )
}
