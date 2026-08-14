// Thin Electron shell. It is just a desktop window that loads the Homunculus
// web UI and connects to the backend over WebSocket — the same way a browser
// would. All real work (telemetry, Computer Core, terminal) lives in the
// standalone server, so nothing heavy runs in this process.

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as vault from './vault'

let mainWindow: BrowserWindow | null = null

// The window/taskbar icon, generated from the brand SVGs by `npm run icons`.
// Windows prefers .ico (it carries every size from 16 to 256, so the taskbar
// and the Alt-Tab card each pick their own); everywhere else takes the 256 PNG.
// macOS ignores this entirely — the dock reads the .icns from the app bundle —
// so we set the dock icon explicitly below when running unpackaged.
const ICON_DIR = join(__dirname, '..', '..', 'build', 'icons')
const ICON_PATH = join(ICON_DIR, process.platform === 'win32' ? 'icon.ico' : 'icon.png')

/** Absent in a packaged build that did not bundle build/, so never assume it. */
function windowIcon(): { icon: string } | Record<string, never> {
  return existsSync(ICON_PATH) ? { icon: ICON_PATH } : {}
}

// Where to load the UI from. In dev, electron-vite serves the renderer; in
// production the backend serves it (override with HOMUNCULUS_URL for a remote
// backend, e.g. a Docker host on your Tailscale network).
const DEV_URL = process.env['ELECTRON_RENDERER_URL']
const PROD_URL = process.env['HOMUNCULUS_URL'] || 'http://localhost:8787'

// The backend that actually consumes the keys. In dev the renderer is on vite
// :5173 but the API is still the standalone server on :8787.
const API_URL = process.env['HOMUNCULUS_URL'] || 'http://localhost:8787'

// ── Vault gating ────────────────────────────────────────────────────────
// The vault bridge is only installed when the backend is on this machine.
// Two reasons, both load-bearing:
//   1. Keys are pushed to the backend to be used. Pushing them to a remote
//      host would put plaintext credentials on the wire.
//   2. With a remote HOMUNCULUS_URL the loaded page is controlled by that
//      host; it has no business holding a handle to our keychain.
function isLocalBackend(): boolean {
  try {
    const h = new URL(API_URL).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '::1'
  } catch {
    return false
  }
}

/** Push the decrypted vault into the local backend, which keeps it in memory
 *  only. Called after every mutation and on every page load, since a backend
 *  restart wipes its copy. */
async function syncVaultToBackend(): Promise<void> {
  if (!isLocalBackend() || !vault.isAvailable()) return
  const secrets = vault.secrets()
  if (Object.keys(secrets).length === 0) return
  try {
    const res = await fetch(`${API_URL}/api/secrets/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secrets }),
    })
    if (!res.ok) console.warn('[vault] backend rejected unlock:', res.status)
  } catch (err) {
    // Backend not up yet — the next page load retries.
    console.warn('[vault] backend unreachable for sync:', (err as Error).message)
  }
}

function registerVaultIpc(): void {
  const guard = <T>(fn: () => T) => {
    if (!isLocalBackend()) return { ok: false, error: 'vault disabled for remote backends' }
    try {
      fn()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  ipcMain.handle('vault:available', () => isLocalBackend() && vault.isAvailable())
  ipcMain.handle('vault:list', () => (isLocalBackend() ? vault.summary() : []))
  ipcMain.handle('vault:set', async (_e, key: string, value: string) => {
    const r = guard(() => vault.setSecret(String(key), String(value)))
    if (r.ok) await syncVaultToBackend()
    return r
  })
  ipcMain.handle('vault:remove', async (_e, key: string) => {
    const r = guard(() => vault.removeSecret(String(key)))
    if (r.ok) await syncVaultToBackend()
    return r
  })
  ipcMain.handle('vault:clear', async () => {
    const r = guard(() => vault.clearAll())
    if (r.ok) await syncVaultToBackend()
    return r
  })
  ipcMain.handle('vault:sync', async () => {
    await syncVaultToBackend()
    return { ok: true }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#03060a',
    show: false,
    autoHideMenuBar: true,
    title: 'Homunculus',
    ...windowIcon(),
    webPreferences: {
      // Still a pure web client for everything except the key vault, which
      // needs main-process privileges to reach the OS keychain. The preload
      // exposes nothing else, and refuses to work against a remote backend.
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/index.cjs')
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // target="_blank" links (e.g. the BRIDGE tab's Home Assistant link) open in the
  // system browser, never as a child Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // The backend keeps keys in memory only, so every load is a chance to
  // re-supply them after a backend restart.
  mainWindow.webContents.on('did-finish-load', () => { void syncVaultToBackend() })

  mainWindow.loadURL(DEV_URL || PROD_URL)
  // Opt-in, not automatic. DevTools keeps every recorded network response body for the
  // life of the session, and the UI polls continuously — leaving it open across a long
  // dev session retained GBs in the (separate, unsandboxed) DevTools renderer. Set
  // HOMUNCULUS_DEVTOOLS=1 when you actually want it, or hit ⌥⌘I.
  if (DEV_URL && process.env['HOMUNCULUS_DEVTOOLS'] === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

app.whenReady().then(() => {
  // Unpackaged on macOS the dock shows the generic Electron icon, since there
  // is no .icns bundle to read. Packaged builds get it from the bundle instead.
  if (process.platform === 'darwin' && !app.isPackaged && existsSync(ICON_PATH)) {
    app.dock?.setIcon(ICON_PATH)
  }
  registerVaultIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
