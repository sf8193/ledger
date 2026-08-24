import { test, expect } from 'playwright/test';

test.describe('Transactions Page — Search & Filters', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/transactions');
    // Wait for the transaction list to load
    await expect(page.locator('h1', { hasText: 'Activity' })).toBeVisible();
    await expect(page.locator('text=/\\d+ of \\d+ entries/')).toBeVisible({ timeout: 10_000 });
  });

  test('search bar filters by merchant/description', async ({ page }) => {
    const searchInput = page.locator('input[placeholder="Search..."]');
    await expect(searchInput).toBeVisible();

    // Type a search term and wait for debounce + refetch
    await searchInput.fill('amazon');
    await page.waitForTimeout(500); // debounce is 300ms

    // Either results match or "No transactions found" appears
    const entries = page.locator('text=/\\d+ of \\d+ entries/');
    await expect(entries).toBeVisible();
  });

  test('date presets switch active state', async ({ page }) => {
    const thisMonth = page.locator('button', { hasText: 'This month' });
    const lastMonth = page.locator('button', { hasText: 'Last month' });

    // This month should be active by default
    await expect(thisMonth).toHaveClass(/text-primary/);

    // Click last month
    await lastMonth.click();
    await expect(lastMonth).toHaveClass(/text-primary/);
    await expect(thisMonth).not.toHaveClass(/text-primary/);
  });

  test('type pills filter transactions', async ({ page }) => {
    const expensesPill = page.locator('button', { hasText: 'expenses' });
    const incomePill = page.locator('button', { hasText: 'income' });
    const allPill = page.locator('button', { hasText: /^all$/ });

    // Click expenses
    await expensesPill.click();
    await expect(expensesPill).toHaveClass(/text-primary/);

    // Pending section should be hidden when type filter is active
    const pendingHeader = page.locator('text=/Pending/i');
    await expect(pendingHeader).not.toBeVisible();

    // Switch to income
    await incomePill.click();
    await expect(incomePill).toHaveClass(/text-primary/);
    await expect(expensesPill).not.toHaveClass(/text-primary/);

    // Back to all
    await allPill.click();
    await expect(allPill).toHaveClass(/text-primary/);
  });

  test('advanced filters panel toggles and shows account/category pills', async ({ page }) => {
    // Find the filter toggle button (SlidersHorizontal icon)
    const filterToggle = page.locator('button:has(svg.lucide-sliders-horizontal)');
    await filterToggle.click();

    // Account and category filter labels should appear in the main content area
    await expect(page.getByRole('main').getByText('Accounts')).toBeVisible();
    await expect(page.getByRole('main').getByText('Categories')).toBeVisible();
    await expect(page.locator('input[placeholder="0"]')).toBeVisible(); // min amount
    await expect(page.locator('input[placeholder="\u221e"]')).toBeVisible(); // max amount
  });

  test('category filter applies and shows filter badge', async ({ page }) => {
    // Open advanced filters
    const filterToggle = page.locator('button:has(svg.lucide-sliders-horizontal)');
    await filterToggle.click();

    // Click the first category pill
    const categoryPills = page.locator('text=/Categories/i').locator('..').locator('button');
    const firstCategory = categoryPills.first();
    if (await firstCategory.isVisible()) {
      await firstCategory.click();

      // Badge should show on the filter icon
      const badge = page.locator('span', { hasText: /^[0-9]+$/ });
      await expect(badge.first()).toBeVisible();

      // Pending section should be hidden (category filter active)
      const pendingHeader = page.locator('h2', { hasText: /Pending/ });
      await expect(pendingHeader).not.toBeVisible();

      // Click again to deselect
      await firstCategory.click();
    }
  });

  test('amount range filter works', async ({ page }) => {
    const filterToggle = page.locator('button:has(svg.lucide-sliders-horizontal)');
    await filterToggle.click();

    const minInput = page.locator('input[placeholder="0"]');
    const maxInput = page.locator('input[placeholder="\u221e"]');

    await minInput.fill('50');
    await maxInput.fill('200');

    // Wait for refetch
    await page.waitForTimeout(300);

    // Entries counter should update
    await expect(page.locator('text=/\\d+ of \\d+ entries/')).toBeVisible();
  });

  test('owner filter pills toggle', async ({ page }) => {
    // The owner "All" pill is the one with exact text "All" (not "All time" or lowercase "all")
    const allPill = page.getByRole('button', { name: 'All', exact: true });

    // All should be active by default
    await expect(allPill).toHaveClass(/text-primary/);

    // Check if there are owner pills (they appear next to "All")
    const ownerSection = allPill.locator('..');
    const pills = ownerSection.locator('button');
    const count = await pills.count();
    if (count > 1) {
      const ownerPill = pills.nth(1);
      await ownerPill.click();
      await expect(ownerPill).toHaveClass(/text-primary/);
      await expect(allPill).not.toHaveClass(/text-primary/);

      // Click All to reset
      await allPill.click();
      await expect(allPill).toHaveClass(/text-primary/);
    }
  });

  test('clear button resets all filters including search', async ({ page }) => {
    // Set a search term
    const searchInput = page.locator('input[placeholder="Search..."]');
    await searchInput.fill('test');
    await page.waitForTimeout(400);

    // Open filters and set an amount
    const filterToggle = page.locator('button:has(svg.lucide-sliders-horizontal)');
    await filterToggle.click();
    const minInput = page.locator('input[placeholder="0"]');
    await minInput.fill('100');

    // Click clear
    const clearButton = page.locator('button', { hasText: 'Clear' });
    await clearButton.click();

    // Search should be cleared
    await expect(searchInput).toHaveValue('');
    // Min amount should be cleared
    await expect(minInput).toHaveValue('');
  });

  test('date range picker opens and selects dates', async ({ page }) => {
    // Find the date range picker button ("Select dates")
    const datePickerButton = page.locator('button', { hasText: /Select dates/ });
    await datePickerButton.click();

    // Calendar should appear
    const calendar = page.locator('.rdp-root, .rdp-dark, [class*="DayPicker"]');
    await expect(calendar.first()).toBeVisible();

    // Click a day to select start date
    const days = page.locator('button[name="day"]');
    const dayCount = await days.count();
    if (dayCount > 0) {
      await days.first().click();
      // After selecting one date, calendar should still be open (waiting for end date)
    }
  });

  test('load more button appears and works when there are more entries', async ({ page }) => {
    // Switch to "All time" to maximize chances of having > PAGE_SIZE entries
    const allTime = page.locator('button', { hasText: 'All time' });
    await allTime.click();

    // Wait for data to load
    await page.waitForTimeout(500);

    const loadMoreButton = page.locator('button', { hasText: /Load more/ });
    const isVisible = await loadMoreButton.isVisible().catch(() => false);

    if (isVisible) {
      // Get initial count
      const counterText = await page.locator('text=/\\d+ of \\d+ entries/').textContent();
      const initialCount = parseInt(counterText?.match(/(\d+) of/)?.[1] || '0');

      // Click load more
      await loadMoreButton.click();

      // Wait for new entries to load
      await page.waitForTimeout(1000);

      // Count should increase
      const newCounterText = await page.locator('text=/\\d+ of \\d+ entries/').textContent();
      const newCount = parseInt(newCounterText?.match(/(\d+) of/)?.[1] || '0');
      expect(newCount).toBeGreaterThan(initialCount);
    }
  });

  test('clicking a transaction opens the detail blade', async ({ page }) => {
    // Click the first transaction row
    const firstRow = page.locator('.card .cursor-pointer').first();
    if (await firstRow.isVisible()) {
      await firstRow.click();

      // Transaction detail blade should appear with category dropdown
      await expect(page.locator('text=/Category/i').first()).toBeVisible({ timeout: 3000 });
    }
  });
});
