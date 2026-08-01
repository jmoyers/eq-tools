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
  }
})
