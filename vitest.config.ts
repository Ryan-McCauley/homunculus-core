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
      include: ['shared/**', 'server/**', 'src/lib/**'],
      exclude: ['**/*.test.ts', '**/*.test.tsx']
    }
  }
})
