import type { EqOverlayApi } from './overlay'

declare global {
  interface Window {
    eqOverlay: EqOverlayApi
  }
}

export {}
