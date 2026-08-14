import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { getBuildInfo } from './shared/version'

const build = getBuildInfo()
const versionDefine = {
  __APP_VERSION__: JSON.stringify(build.version),
  __GIT_COMMIT__: JSON.stringify(build.commit),
  __BUILD_DATE__: JSON.stringify(build.buildDate)
}

// Electron is now just a thin shell (main only). The renderer is the web UI,
// built here and also served by the standalone backend for browser clients.
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/main.ts') }
      }
    }
  },
  // The one privileged bridge in the shell: the OS-keychain key vault.
  // See electron/preload.ts for why the surface is this small.
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload.ts') },
        // Emit CommonJS. The package is `"type": "module"`, so the default
        // preload output would be index.mjs — and Electron only loads an ESM
        // preload with sandboxing disabled, which we are not about to do for
        // one keychain bridge. `.cjs` is read as CommonJS regardless of the
        // package type, and main.ts loads it by this exact filename.
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: '.',
    define: versionDefine,
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'index.html') }
      }
    },
    resolve: {
      alias: { '@': resolve(__dirname, 'src') }
    },
    plugins: [react()]
  }
})
