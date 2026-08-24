import { test as setup, expect } from 'playwright/test';
import path from 'path';
import fs from 'fs';

const AUTH_FILE = path.join(__dirname, '.auth-state.json');

setup('authenticate via email form', async ({ page }) => {
  // Skip if auth state already exists and is recent (< 1 hour old)
  if (fs.existsSync(AUTH_FILE)) {
    const stat = fs.statSync(AUTH_FILE);
    const age = Date.now() - stat.mtimeMs;
    if (age < 3600_000) {
      // Verify the state still works
      await page.goto('/');
      await page.waitForTimeout(2000);
      if (!page.url().includes('/login')) {
        return; // Auth state is valid
      }
    }
  }

  await page.goto('/login');

  await page.locator('input[type="email"]').fill('test@test.com');
  await page.locator('input[type="password"]').fill('testtest123');
  await page.locator('button[type="submit"]').click();

  // Wait for sign-in: either navigate away from /login, or show an error
  await page.waitForFunction(
    () => !window.location.pathname.includes('/login'),
    { timeout: 15_000 }
  );

  await page.waitForLoadState('networkidle');
  await page.context().storageState({ path: AUTH_FILE });
});
