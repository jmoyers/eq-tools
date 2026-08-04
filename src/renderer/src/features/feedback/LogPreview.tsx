// LogPreview — the "read exactly what you are about to send" box (Task #65, §5.4).
//
// The log slice is the sensitive artifact in a feedback report, so it is never attached
// sight-unseen: main builds it, scrubs it (src/shared/logScrub.ts — the SAME drop list that
// governs committed fixtures) and hands the renderer a CAPPED preview plus the true counts.
// This renders that, honestly:
//
//   - the meta line states the slice AS STATE, never as process:
//     `4,812 lines · 14:02–14:32 · 91 lines removed · 128 KB compressed`
//   - the lines themselves live in a FIXED-height, own-`overflow:auto` box (AGENTS.md UI law:
//     a growing list lives in a fixed-height scroll box) and are WINDOWED through
//     lib/useWindowedRows, so a 5,000-line preview mounts ~20 DOM nodes, not 5,000.
//   - when the preview is capped, it SAYS so and points at "Save a copy…", which writes the
//     COMPLETE slice to disk. That is what makes "you can see exactly what is sent" literally
//     true rather than a claim about a truncated view.
//
// De-nesting: the box is a tonal FILL (`action.hover`), not a second border — the dialog's own
// surface is the one border level here (no boxes in boxes).

import { type JSX, useRef } from 'react'
import { Box, Button, Stack, Typography } from '@mui/material'
import SaveAltIcon from '@mui/icons-material/SaveAlt'
import type { FeedbackSlicePreview } from './useFeedback'
import { useWindowedRows } from '../../lib/useWindowedRows'
import { formatTime } from '../../lib/formatDate'

/** The scroll box's fixed height. Tall enough to read a burst of combat, short enough that the
 *  dialog's own actions stay on screen at the app's 900px minimum window. */
const BOX_HEIGHT = 220
/** One monospace line at 11px/16px — the windowing hook needs a fixed row height. */
const ROW_HEIGHT = 16

/** `128 KB` / `1.4 MB` — the compressed size the upload would actually be. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024)).toString()} KB`
}

/** Thousands-separated counts — these are LINE counts, not damage totals, so they are never
 *  k/M-scaled (`formatNum` would render 4,812 lines as '4.8k'). */
function count(n: number): string {
  return n.toLocaleString()
}

/**
 * The state line. Times go through lib/formatDate (user-local, never UTC), and the removed
 * count is stated even when it is zero — "nothing was removed" is itself information about
 * what is leaving the machine.
 */
export function sliceMetaText(slice: FeedbackSlicePreview, requestedMinutes: number): string {
  const hm: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
  const span = `${formatTime(slice.fromMs, hm)}–${formatTime(slice.toMs, hm)}`
  const parts = [
    `${count(slice.lines)} lines`,
    span,
    `${count(slice.dropped)} lines removed`,
    `${formatBytes(slice.bytes)} compressed`
  ]
  // The window is a REQUEST, not a promise: main halves it (up to three times) to fit the 2 MB
  // upload cap. Say so, rather than letting a "60 min" button sit above a 15-minute span.
  if (slice.windowMinutes < requestedMinutes) {
    parts.push(`shortened to ${slice.windowMinutes.toString()} min to fit`)
  }
  return parts.join(' · ')
}

/** The windowed body. Split out so the scroll container owns exactly one concern. */
function PreviewLines({ lines }: { lines: readonly string[] }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const win = useWindowedRows({ count: lines.length, rowHeight: ROW_HEIGHT, scrollRef })
  return (
    <Box
      ref={scrollRef}
      data-testid="feedback-preview"
      sx={{
        height: BOX_HEIGHT,
        overflow: 'auto',
        borderRadius: 1,
        bgcolor: 'action.hover',
        p: 1,
        fontFamily: 'ui-monospace, monospace',
        fontSize: 11,
        lineHeight: `${ROW_HEIGHT.toString()}px`,
        whiteSpace: 'pre',
        color: 'text.secondary'
      }}
    >
      <div style={{ height: win.topPad }} />
      {lines.slice(win.start, win.end).map((line, i) => (
        <div key={win.start + i}>{line}</div>
      ))}
      <div style={{ height: win.bottomPad }} />
    </Box>
  )
}

export interface LogPreviewProps {
  /** null while main is still building it, or when no character log resolved. */
  slice: FeedbackSlicePreview | null
  /** The window the user ASKED for — main may have shortened it to fit the upload cap. */
  requestedMinutes: number
  loading: boolean
  /** Write the COMPLETE slice to a user-chosen path (the OS save dialog lives in main). */
  onSaveCopy: () => void
  saving: boolean
  /** Where the last "Save a copy…" landed, so the action reports its own result. */
  savedPath: string | null
}

export default function LogPreview({
  slice,
  requestedMinutes,
  loading,
  onSaveCopy,
  saving,
  savedPath
}: LogPreviewProps): JSX.Element {
  if (loading && !slice) {
    return (
      <Typography variant="caption" color="text.secondary">
        Reading your log…
      </Typography>
    )
  }
  if (!slice) {
    return (
      <Typography variant="caption" color="text.secondary" data-testid="feedback-preview-empty">
        No log lines in this window — nothing would be attached.
      </Typography>
    )
  }
  return (
    <Stack spacing={0.75}>
      <Typography
        variant="caption"
        color="text.secondary"
        data-testid="feedback-preview-meta"
        sx={{ fontFamily: 'ui-monospace, monospace' }}
      >
        {sliceMetaText(slice, requestedMinutes)}
      </Typography>

      <PreviewLines lines={slice.previewLines} />

      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <Button
          size="small"
          variant="outlined"
          startIcon={<SaveAltIcon />}
          disabled={saving}
          data-testid="feedback-save-copy"
          onClick={onSaveCopy}
        >
          Save a copy…
        </Button>
        <Typography variant="caption" color="text.secondary" sx={{ minWidth: 0 }}>
          {savedPath
            ? `Saved to ${savedPath}`
            : slice.truncatedPreview
              ? 'This preview is shortened. Save a copy to read every line that would be sent.'
              : 'This is the whole slice.'}
        </Typography>
      </Stack>
    </Stack>
  )
}
