// First: nothing may reach other hosts, not even while modules load.
import './noExternalRequests'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startThemes } from './ui/themes'
import './styles.css'

startThemes()

if (import.meta.env.DEV) void import('./devtools')

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
