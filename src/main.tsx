import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installTransport } from './transport'
import '@tabler/icons-webfont/dist/tabler-icons.min.css'
import './styles/global.css'

// Connect to the backend and install window.homunculus before rendering.
installTransport()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
