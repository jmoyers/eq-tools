// ============================================================================
// SliceBox — the attached log slice, on screen, and NOWHERE ELSE.
// ============================================================================
//
// THE LAW (docs/plans/feedback-triage.md §10.3): a log slice never reaches anything public.
// These bytes came out of S3 into main, were cached under `.triage/slices/` (gitignored twice
// over) and crossed IPC as capped TEXT. They are rendered here, in a local window, on the
// operator's own machine. There is deliberately no copy button, no export, and no path from
// this component into an issue body — `triage-feedback issue` is the only publisher and it
// runs `assertNoLogSlice` over everything it posts.
//
// FIXED HEIGHT, ITS OWN SCROLL, WINDOWED — the AGENTS.md law for any long list, and here it is
// load-bearing twice over: a 5,000-line slice sized to its content would push the whole detail
// pane off the screen, and 5,000 mounted rows would stall the tab on every keystroke in the
// search box.

import { type JSX, useDeferredValue, useMemo, useRef, useState } from 'react'
import { Box, InputAdornment, Stack, TextField, Typography } from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import { useWindowedRows } from '../../lib/useWindowedRows'
import type { TriageSlice } from '@shared/triage'

/** Monospace line height. Fixed, because windowing needs one number it can trust. */
const LINE_HEIGHT = 17
const BOX_HEIGHT = 280

export default function SliceBox({ slice }: { slice: TriageSlice }): JSX.Element {
  const [query, setQuery] = useState('')
  // The input echoes instantly; the filter runs on the deferred value — the app's search law.
  const deferred = useDeferredValue(query)
  const scrollRef = useRef<HTMLDivElement>(null)

  const lines = useMemo(() => {
    const needle = deferred.trim().toLowerCase()
    if (needle.length === 0) return slice.lines
    return slice.lines.filter((l) => l.toLowerCase().includes(needle))
  }, [slice.lines, deferred])

  const win = useWindowedRows({ count: lines.length, rowHeight: LINE_HEIGHT, scrollRef })
  const filtering = deferred.trim().length > 0

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={2} alignItems="center" useFlexGap flexWrap="wrap">
        <TextField
          size="small"
          placeholder="Search in slice"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              )
            }
          }}
          sx={{ minWidth: 260 }}
          data-testid="triage-slice-search"
        />
        {/* Counts, in the app's own units. `totalLines` is the slice; `lines.length` is what
            the filter kept; `truncated` says the bridge capped it — never a silent shortfall. */}
        <Typography variant="caption" color="text.secondary">
          {filtering
            ? `${lines.length.toLocaleString()} of ${slice.lines.length.toLocaleString()} lines match`
            : `${slice.lines.length.toLocaleString()} lines shown`}
          {slice.truncated
            ? ` · capped from ${slice.totalLines.toLocaleString()} — the full slice is cached at ${slice.path}`
            : ''}
        </Typography>
      </Stack>

      <Box
        ref={scrollRef}
        data-testid="triage-slice"
        sx={{
          height: BOX_HEIGHT,
          overflow: 'auto',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          bgcolor: 'background.default',
          fontFamily: 'monospace',
          fontSize: 11,
          lineHeight: `${String(LINE_HEIGHT)}px`,
          px: 1,
          py: 0.5,
          whiteSpace: 'pre'
        }}
      >
        <div style={{ height: win.topPad }} />
        {lines.slice(win.start, win.end).map((line, i) => (
          <div key={win.start + i}>{line}</div>
        ))}
        <div style={{ height: win.bottomPad }} />
        {lines.length === 0 && (
          <Typography variant="caption" color="text.secondary">
            No line in this slice matches.
          </Typography>
        )}
      </Box>
    </Stack>
  )
}
