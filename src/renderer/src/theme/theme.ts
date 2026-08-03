import { createTheme, alpha } from '@mui/material/styles'

// Dark theme with an EQ-ish parchment/gold accent.
//
// Built in TWO steps on purpose: the scrollbar overrides below are expressed in
// PALETTE TOKENS (primary.main, common.white), so the palette has to exist as a
// resolved object before the components block can read it. `base` is that
// palette; `theme` is `base` + component overrides.
const base = createTheme({
  palette: {
    mode: 'dark',
    background: { default: '#0f1115', paper: '#171a21' },
    primary: { main: '#d9b25f' }, // muted gold
    secondary: { main: '#6fb3d2' },
    success: { main: '#5fbf72' },
    warning: { main: '#e0a94a' }
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: 'Inter, Segoe UI, Roboto, system-ui, sans-serif',
    h6: { fontWeight: 700 }
  }
})

/**
 * App-wide scrollbars. Applied through CssBaseline (mounted in main.tsx).
 *
 * WHY THIS IS `::-webkit-scrollbar` ONLY, with NO `scrollbar-width` /
 * `scrollbar-color` — this is the whole fix, and it looks like a regression if
 * you don't know the rule:
 *
 *   In Blink, the standard properties and the legacy pseudo-elements are
 *   MUTUALLY EXCLUSIVE. The moment an element carries a non-initial
 *   `scrollbar-width` or `scrollbar-color`, Chromium switches that scroller to
 *   the native (Fluent, on Windows) scrollbar and IGNORES every
 *   `::-webkit-scrollbar-*` rule targeting it.
 *
 * This theme used to set BOTH on `*`, so the entire webkit block below was dead
 * code and every scroller got Chromium's native thin scrollbar instead.
 * MEASURED in Electron 33.4.11 / Chromium 130 (`offsetWidth - clientWidth` on a
 * 200px `overflow:auto` box): both properties set => 11px gutter and a gold
 * thumb (the `scrollbar-color` value); webkit-only => 10px, i.e. exactly the
 * width the rule asks for. Confirmed visually too: the native thin scrollbar
 * paints its thumb edge-to-edge across the gutter, with hover arrow buttons, so
 * a right-aligned value (the Leveling feed's dates) ends up flush against it —
 * the "scrollbar overlaps content" report.
 *
 * A custom webkit scrollbar is CLASSIC: it consumes layout width, so it can
 * never paint over content. The transparent border + `background-clip:
 * content-box` then insets the visible thumb inside that reserved gutter, which
 * is what puts real air between the content edge and the bar.
 *
 * Losing the standard properties costs nothing here: this renderer only ever
 * runs in Electron/Chromium. Do not "restore" them for Firefox parity — doing so
 * silently disables everything below.
 */
const SCROLLBAR_SIZE = 12
const THUMB_INSET = 3 // 12 - 2*3 => a 6px visible thumb, 3px clear on each side

const scrollbars = {
  // Same size on both axes, so the timeline chart's horizontal bar is treated
  // identically to a vertical list scrollbar.
  '*::-webkit-scrollbar': {
    width: SCROLLBAR_SIZE,
    height: SCROLLBAR_SIZE
  },
  '*::-webkit-scrollbar-track': {
    background: 'transparent'
  },
  '*::-webkit-scrollbar-thumb': {
    backgroundColor: alpha(base.palette.common.white, 0.22),
    borderRadius: SCROLLBAR_SIZE,
    border: `${String(THUMB_INSET)}px solid transparent`,
    backgroundClip: 'content-box'
  },
  '*::-webkit-scrollbar-thumb:hover': {
    backgroundColor: alpha(base.palette.primary.main, 0.55)
  },
  '*::-webkit-scrollbar-corner': {
    background: 'transparent'
  },
  // Styling ::-webkit-scrollbar re-enables the stepper arrows on some builds;
  // this app never wants them (they eat the gutter and look nothing like the rest
  // of the UI).
  '*::-webkit-scrollbar-button': {
    display: 'none'
  },
  // Only the document scroller reserves a gutter unconditionally. Applying
  // `scrollbar-gutter: stable` via `*` was considered and REJECTED: it makes
  // every `overflow:auto` box reserve 12px even when nothing overflows, which
  // silently steals width from panels that never scroll. The classic scrollbar
  // above already reserves its own gutter the moment it appears, which is the
  // property that actually fixes the overlap.
  'html, body': {
    scrollbarGutter: 'stable'
  }
}

export const theme = createTheme(base, {
  components: {
    MuiCssBaseline: {
      styleOverrides: scrollbars
    }
  }
})
