import { createTheme } from '@mui/material/styles'

// Dark theme with an EQ-ish parchment/gold accent.
export const theme = createTheme({
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
  },
  components: {
    // App-wide themed scrollbars (dark MUI). Applies to every scrollable
    // container via CssBaseline (mounted in App.tsx). WebKit + Firefox fallback.
    MuiCssBaseline: {
      styleOverrides: {
        '*': {
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(217, 178, 95, 0.35) transparent'
        },
        '*::-webkit-scrollbar': {
          width: 10,
          height: 10
        },
        '*::-webkit-scrollbar-track': {
          background: 'transparent'
        },
        '*::-webkit-scrollbar-thumb': {
          backgroundColor: 'rgba(255, 255, 255, 0.16)',
          borderRadius: 8,
          border: '2px solid transparent',
          backgroundClip: 'padding-box'
        },
        '*::-webkit-scrollbar-thumb:hover': {
          backgroundColor: 'rgba(255, 255, 255, 0.3)'
        },
        '*::-webkit-scrollbar-corner': {
          background: 'transparent'
        },
        // Keep layout stable when a scrollbar appears/disappears.
        'html, body': {
          scrollbarGutter: 'stable'
        }
      }
    }
  }
})
