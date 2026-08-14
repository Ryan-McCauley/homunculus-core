import type { HomunculusApi } from '../../shared/api'

declare global {
  interface Window {
    homunculus: HomunculusApi
  }

  // Build-time constants injected by Vite/electron-vite `define` (see the vite
  // configs + shared/version.ts). Present in every build; `src/lib/version.ts`
  // guards against them being undefined in edge cases.
  const __APP_VERSION__: string
  const __GIT_COMMIT__: string
  const __BUILD_DATE__: string
}

export {}
