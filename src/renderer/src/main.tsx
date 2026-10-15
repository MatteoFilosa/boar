// First: nothing may reach other hosts, not even while modules load.
import './noExternalRequests'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startThemes } from './ui/themes'
import { startInterfaceScale } from './ui/interfaceScale'
import './styles.css'

startThemes()
startInterfaceScale()

if (import.meta.env.DEV) void import('./devtools')
// Render check of the smoke test (src/main/index.ts): loaded only when called.
window.__boarRenderCheck = (codec, audioCodec) => import('./renderCheck').then((m) => m.runRenderCheck(codec, audioCodec))

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
