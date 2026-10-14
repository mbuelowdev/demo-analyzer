import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/test/**/*.test.ts', 'server/test/**/*.test.ts', 'extension/test/**/*.test.ts'],
    testTimeout: 20_000,
    pool: 'forks',
    env: { LOG_SILENT: '1' },
  },
});
