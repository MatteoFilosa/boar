import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }

export default defineConfig(({ command }) => ({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    define: { __APP_VERSION__: JSON.stringify(version) },
    // Demo media (npm run samples) is served by the dev server only, never bundled.
    publicDir: command === 'serve' ? resolve(__dirname, 'dev-samples') : false,
    resolve: {
      alias: { '@': resolve(__dirname, 'src/renderer/src') }
    },
    build: {
      // Noise reduction models are fetched by URL; as data URLs they also load
      // in the packaged app, where pages come from file:// (no fetch support).
      // MediaPipe's large wasm stays a file and is read through IPC (media/assets.ts).
      assetsInlineLimit: (file: string) => (file.endsWith('.wasm') && !file.includes('vision_wasm') ? true : undefined)
    },
    plugins: [react()]
  }
}))
