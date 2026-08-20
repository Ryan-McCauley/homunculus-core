import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') }
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules', 'out', '.claude'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // src/** (not just src/lib/**) so the panels are MEASURED rather than
      // silently omitted. They were outside `include` before, which meant
      // ~18.7k lines of UI — CryptoDashboard, the market panels, every hook —
      // contributed nothing to the reported percentage. The number looked like
      // 43% because two thirds of the app wasn't on the scale.
      include: ['shared/**', 'server/**', 'src/**'],
      exclude: [
        '**/*.test.ts', '**/*.test.tsx',
        // Type-only barrels and generated data: no statements to exercise, and
        // counting them just dilutes the signal either way.
        'src/main.tsx', 'src/vite-env.d.ts',
        'server/country-centroids.ts'
      ],
      // Ratchet, not a goal. These are set just under the CURRENT measured
      // numbers so the suite fails the moment coverage regresses, and get
      // raised as gaps close — never lowered to make a red run green.
      thresholds: {
        lines: 33.5,
        functions: 29,
        branches: 23.5,
        statements: 32.4
      }
    }
  }
})
