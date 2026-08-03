import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // Inlined data JSONs (spells/mobs/items/classes) emit as JSON.parse("...") instead of
    // pretty-printed object literals — measured 4.66 MB smaller main bundle and a faster
    // startup parse the day items.json (6.8 MB raw) landed.
    json: { stringify: true },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Two preloads: the full app bridge (index) and a minimal overlay bridge
        // (overlay) that exposes only the combat snapshot + overlay window controls
        // (Task #52). electron-vite emits both to out/preload/{index,overlay}.js.
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          overlay: resolve(__dirname, 'src/preload/overlay.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        // Two HTML entries: the main app (index) and the floating overlay meter
        // (overlay, Task #52). electron-vite emits out/renderer/{index,overlay}.html.
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html')
        }
      }
    }
  }
})
