import { defineConfig } from 'playwright/test';
import path from 'path';

export const AUTH_FILE = path.join(__dirname, 'e2e', '.auth-state.json');

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5180',
    headless: true,
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'tests',
      dependencies: ['setup'],
      testMatch: /.*\.spec\.ts/,
      use: { storageState: AUTH_FILE },
    },
  ],
  retries: 0,
});
