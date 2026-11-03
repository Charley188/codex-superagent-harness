import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({ resolve: { alias: [
  { find: '../src/app/store.ts', replacement: fileURLToPath(new URL('./adapted/store.ts', import.meta.url)) },
] }, test: {
  include: ['vendor/dsh/tests/*.spec.ts', 'tests/*.spec.ts'],
  maxWorkers: 2,
} })
