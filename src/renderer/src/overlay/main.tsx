import React from 'react'
import ReactDOM from 'react-dom/client'
import OverlayMeter from './OverlayMeter'

// The overlay renders in its OWN transparent BrowserWindow (Task #52). It is a
// standalone React root — deliberately NOT wrapped in the app's MUI ThemeProvider
// or ErrorBoundary. The meter is a tiny, dependency-light component (plain divs +
// inline styles) so it stays cheap to paint on top of the game and has no reason
// to pull the whole MUI/theme surface into a second window bundle.
ReactDOM.createRoot(document.getElementById('overlay-root') as HTMLElement).render(
  <React.StrictMode>
    <OverlayMeter />
  </React.StrictMode>
)
