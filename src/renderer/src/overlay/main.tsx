import React from 'react'
import ReactDOM from 'react-dom/client'
import OverlayMeter from './OverlayMeter'
import EventLogOverlay from './EventLogOverlay'
import HealMeter from './HealMeter'
import { isHealOverlayKind } from '@shared/types'

// The overlay renders in its OWN transparent BrowserWindow (Task #52). It is a
// standalone React root — deliberately NOT wrapped in the app's MUI ThemeProvider
// or ErrorBoundary. Every surface here is a tiny, dependency-light component (plain
// divs + inline styles) so it stays cheap to paint on top of the game and has no
// reason to pull the whole MUI/theme surface into a second window bundle.
//
// ONE bundle serves every overlay KIND; which component mounts is decided by the
// `?kind=` query the window was opened with (read + validated by the preload):
//   'events'                          → the event log (alerts / notable loot / quests)
//   'heal-fight' | 'heal-overall'     → the healing meter (Task #59)
//   everything else                   → the damage meter (fight / zone selection lives inside)
const kind = window.eqOverlay?.kind ?? 'fight'

function Surface(): React.JSX.Element {
  if (kind === 'events') return <EventLogOverlay />
  if (isHealOverlayKind(kind)) return <HealMeter />
  return <OverlayMeter />
}

// overlay.html always carries #overlay-root; fail loudly rather than letting
// createRoot throw a container error nobody can trace back.
const container = document.getElementById('overlay-root')
if (!container) throw new Error('overlay: #overlay-root container missing from overlay.html')

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <Surface />
  </React.StrictMode>
)
