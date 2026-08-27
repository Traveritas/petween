import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    pool: 'forks',
    // C1 tooling baseline: report-only (no thresholds yet — the point is a
    // measurable number per area before Motion Pack lands, not a gate).
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      exclude: ['src/preview/**', 'src/**/*.d.ts'],
    },
  },
})
