// Minimal, deliberately one-directional bridge to the encrypted vault.
//
// The shell used to have no preload at all; this is the one thing that needs
// main-process privileges, because only the main process can reach the OS
// keychain. The surface is kept as small as the feature allows:
//
//   • No method returns a secret VALUE. `list()` gives keys and last-4 only.
//   • Writes are fire-and-forget into the keychain.
//   • main.ts refuses to install this at all unless the window is pointed at a
//     LOCAL backend, so a page served from a remote host never sees it.

import { contextBridge, ipcRenderer } from 'electron'
import type { VaultBridge } from '../shared/secrets'

const bridge: VaultBridge = {
  available: () => ipcRenderer.invoke('vault:available'),
  list: () => ipcRenderer.invoke('vault:list'),
  set: (key, value) => ipcRenderer.invoke('vault:set', key, value),
  remove: (key) => ipcRenderer.invoke('vault:remove', key),
  clear: () => ipcRenderer.invoke('vault:clear'),
  sync: () => ipcRenderer.invoke('vault:sync'),
}

contextBridge.exposeInMainWorld('homunculusVault', bridge)
