import { defineConfig } from 'vitest/config'

// separate from vite.config.ts, whose root is web/
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
