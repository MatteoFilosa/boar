import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Renderer only, served to a normal browser. Used for fast UI iteration and
// automated UI checks; the real app runs through electron-vite.
const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  define: { __APP_VERSION__: JSON.stringify(version) },
  publicDir: resolve(__dirname, 'dev-samples'),
  resolve: {
    alias: { '@': resolve(__dirname, 'src/renderer/src') }
  },
  plugins: [react()],
  server: { port: 5180, strictPort: true }
})
