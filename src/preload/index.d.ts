import type { EqApi } from './index'

declare global {
  interface Window {
    eq: EqApi
  }
}

export {}
