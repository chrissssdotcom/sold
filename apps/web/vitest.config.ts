import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['src/**/*.test.ts'], exclude: ['src/**/*.int.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.int.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 300_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['e2e/**/*.e2e.ts'],
          testTimeout: 120_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
