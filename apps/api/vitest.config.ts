import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true, // Run all tests in one process to share DB
      },
    },
    sequence: {
      concurrent: false, // Run tests sequentially
    },
  },
});
