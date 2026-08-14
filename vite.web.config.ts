import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { getBuildInfo } from './shared/version'

// Standalone web build (for the backend to serve, and for Docker). Produces the
// same artifact as the electron-vite renderer build, without needing Electron.
const build = getBuildInfo()

export default defineConfig({
  root: '.',
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(build.version),
    __GIT_COMMIT__: JSON.stringify(build.commit),
    __BUILD_DATE__: JSON.stringify(build.buildDate)
  },
  resolve: {
    alias: { '@': resolve(__dirname, 'src') }
  },
  build: {
    outDir: 'out/renderer',
    emptyOutDir: true
  }
})
