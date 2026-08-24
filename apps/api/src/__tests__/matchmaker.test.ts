import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Kysely } from 'kysely';
import { Database } from '../db/types';
import {
  setupTestDb, teardownTestDb, createTestHousehold,
  createAccount, createEntry,
} from './setup';
import { runMatchmaker, confirmTransferSuggestion, dismissSuggestion, applyOneRule } from '../services/matchmaker';
import { mapPlaidCategory } from '../services/plaid-categories';
import { stripReferenceNumbers } from '../routes/matching';
import { nanoid } from 'nanoid';

let db: Kysely<Database>;

beforeAll(async () => {
  db = await setupTestDb();
}, 30000);

afterAll(async () => {
  await teardownTestDb();
});

// --- Unit: Plaid category mapping ---

describe('Plaid category mapping', () => {
  it('maps FOOD_AND_DRINK to expense', () => {
    const result = mapPlaidCategory('FOOD_AND_DRINK');
    expect(result).toEqual({ accountName: 'Food & Drink', accountType: 'expense' });
  });

  it('maps SALARY to income', () => {
    const result = mapPlaidCategory('SALARY');
    expect(result).toEqual({ accountName: 'Paychecks', accountType: 'income' });
  });

  it('returns null for transfer categories', () => {
    expect(mapPlaidCategory('TRANSFER_IN')).toBeNull();
    expect(mapPlaidCategory('TRANSFER_OUT')).toBeNull();
    expect(mapPlaidCategory('LOAN_PAYMENTS')).toBeNull();
  });

  it('returns null for unknown categories', () => {
    expect(mapPlaidCategory('TOTALLY_UNKNOWN')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(mapPlaidCategory(null)).toBeNull();
  });

});

// --- Unit: Category rules matching ---

describe('Category rules', () => {
  it('applies a "contains" rule to matching entries', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-rule', 'asset');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');
    const groceries = await createAccount(db, householdId, 'Groceries-rule', 'expense');

    // Create an uncategorized entry with "Trader Joe" in description
    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 50 },
      { account_id: checking, amount: -50 },
    ], { description: "TRADER JOE'S #123" });

    // Create a category rule
    await db.insertInto('category_rules').values({
      id: nanoid(),
      household_id: householdId,
      target_account_id: groceries,
      match_field: 'description',
      match_type: 'contains',
      match_value: 'trader joe',
      priority: 0,
      created_at: new Date().toISOString(),
    }).execute();

    const result = await runMatchmaker(db, householdId);
    expect(result.entries_categorized).toBe(1);

    // Verify the line was updated
    const lines = await db.selectFrom('journal_lines')
      .where('account_id', '=', groceries)
      .selectAll()
      .execute();
    expect(lines.length).toBe(1);
    expect(Number(lines[0].amount)).toBe(50);
  });

  it('does not re-categorize when target matches current', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-norecatg', 'asset');
    const groceries = await createAccount(db, householdId, 'Groceries-norecatg', 'expense');

    // Entry already categorized as groceries
    await createEntry(db, householdId, [
      { account_id: groceries, amount: 50 },
      { account_id: checking, amount: -50 },
    ], { description: "TRADER JOE'S #456" });

    await db.insertInto('category_rules').values({
      id: nanoid(),
      household_id: householdId,
      target_account_id: groceries,
      match_field: 'description',
      match_type: 'contains',
      match_value: 'trader joe',
      priority: 0,
      created_at: new Date().toISOString(),
    }).execute();

    const result = await runMatchmaker(db, householdId);
    // Should NOT count as categorized since it's already at the target
    expect(result.entries_categorized).toBe(0);
  });

  it('user rules override Plaid categories', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-override', 'asset');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');
    const myGroceries = await createAccount(db, householdId, 'My Groceries', 'expense');

    // Entry with Plaid category FOOD_AND_DRINK (will be auto-categorized to "Food & Drink")
    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 30 },
      { account_id: checking, amount: -30 },
    ], { description: 'WHOLE FOODS', plaid_category: 'FOOD_AND_DRINK' });

    // User rule: Whole Foods → My Groceries
    await db.insertInto('category_rules').values({
      id: nanoid(),
      household_id: householdId,
      target_account_id: myGroceries,
      match_field: 'description',
      match_type: 'contains',
      match_value: 'whole foods',
      priority: 0,
      created_at: new Date().toISOString(),
    }).execute();

    const result = await runMatchmaker(db, householdId);
    // Pass 1 should categorize via Plaid, Pass 3 should override via user rule
    expect(result.plaid_categorized).toBe(1);
    expect(result.entries_categorized).toBe(1);

    // Final category should be user's choice
    const lines = await db.selectFrom('journal_lines')
      .where('account_id', '=', myGroceries)
      .selectAll()
      .execute();
    expect(lines.length).toBe(1);
  });
});

// --- Unit: Transfer detection ---

describe('Transfer detection', () => {
  it('auto-merges when both entries have Plaid transfer category', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-xfer1', 'asset');
    const savings = await createAccount(db, householdId, 'Savings-xfer1', 'asset');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');
    const uncatIncome = await createAccount(db, householdId, 'Uncategorized Income', 'income');

    // Money leaves checking
    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 500 },
      { account_id: checking, amount: -500 },
    ], { description: 'Online Transfer to Savings', date: '2024-03-01', plaid_category: 'TRANSFER_OUT' });

    // Money arrives in savings
    await createEntry(db, householdId, [
      { account_id: uncatIncome, amount: -500 },
      { account_id: savings, amount: 500 },
    ], { description: 'Online Transfer from Checking', date: '2024-03-01', plaid_category: 'TRANSFER_IN' });

    const result = await runMatchmaker(db, householdId);
    expect(result.transfers_auto_merged).toBe(1);
    expect(result.transfer_suggestions).toBe(0);

    // Verify: new transfer entry exists
    const transferEntries = await db.selectFrom('journal_entries')
      .where('household_id', '=', householdId)
      .where('source', '=', 'matchmaker')
      .selectAll()
      .execute();
    expect(transferEntries.length).toBe(1);
    expect(transferEntries[0].description).toContain('Transfer:');
    expect(transferEntries[0].is_verified).toBe(true);

    // Verify: original entries are superseded
    const superseded = await db.selectFrom('journal_entries')
      .where('household_id', '=', householdId)
      .where('superseded_by', 'is not', null)
      .selectAll()
      .execute();
    expect(superseded.length).toBe(2);
    expect(superseded[0].exclude_from_totals).toBe(true);
  });

  it('creates suggestion for lower confidence matches', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-suggest', 'asset');
    const savings = await createAccount(db, householdId, 'Savings-suggest', 'asset');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');
    const uncatIncome = await createAccount(db, householdId, 'Uncategorized Income', 'income');

    // Same amounts, no Plaid category, different dates (3 days apart)
    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 200 },
      { account_id: checking, amount: -200 },
    ], { description: 'PAYMENT - ACH', date: '2024-03-01' });

    await createEntry(db, householdId, [
      { account_id: uncatIncome, amount: -200 },
      { account_id: savings, amount: 200 },
    ], { description: 'DEPOSIT FROM CHECKING', date: '2024-03-04' });

    const result = await runMatchmaker(db, householdId);
    expect(result.transfers_auto_merged).toBe(0);
    expect(result.transfer_suggestions).toBe(1);

    // Verify suggestion created
    const suggestions = await db.selectFrom('match_suggestions')
      .where('household_id', '=', householdId)
      .where('status', '=', 'pending')
      .selectAll()
      .execute();
    expect(suggestions.length).toBe(1);
    expect(suggestions[0].match_type).toBe('transfer');
    expect(Number(suggestions[0].confidence)).toBeLessThan(0.90);
  });

  it('detects CC payments (asset → liability)', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-ccpay', 'asset');
    const creditCard = await createAccount(db, householdId, 'Visa-ccpay', 'liability');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');
    const uncatIncome = await createAccount(db, householdId, 'Uncategorized Income', 'income');

    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 1500 },
      { account_id: checking, amount: -1500 },
    ], { description: 'AUTOPAY VISA', date: '2024-03-15', plaid_category: 'TRANSFER_OUT' });

    await createEntry(db, householdId, [
      { account_id: uncatIncome, amount: -1500 },
      { account_id: creditCard, amount: 1500 },
    ], { description: 'PAYMENT THANK YOU', date: '2024-03-15', plaid_category: 'TRANSFER_IN' });

    const result = await runMatchmaker(db, householdId);
    expect(result.transfers_auto_merged).toBe(1);

    // Verify it's tagged as cc_payment in the source entry
    const transferEntry = await db.selectFrom('journal_entries')
      .where('household_id', '=', householdId)
      .where('source', '=', 'matchmaker')
      .selectAll()
      .executeTakeFirst();
    expect(transferEntry?.description).toContain('CC Payment:');
  });

  it('does not match entries on the same account', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-same', 'asset');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');
    const uncatIncome = await createAccount(db, householdId, 'Uncategorized Income', 'income');

    // Two opposite entries on the SAME account — not a transfer
    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 100 },
      { account_id: checking, amount: -100 },
    ], { description: 'Purchase', date: '2024-03-01' });

    await createEntry(db, householdId, [
      { account_id: uncatIncome, amount: -100 },
      { account_id: checking, amount: 100 },
    ], { description: 'Refund', date: '2024-03-02' });

    const result = await runMatchmaker(db, householdId);
    expect(result.transfers_auto_merged).toBe(0);
    expect(result.transfer_suggestions).toBe(0);
  });

  it('does not match entries more than 5 days apart', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-far', 'asset');
    const savings = await createAccount(db, householdId, 'Savings-far', 'asset');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');
    const uncatIncome = await createAccount(db, householdId, 'Uncategorized Income', 'income');

    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 300 },
      { account_id: checking, amount: -300 },
    ], { description: 'Transfer out', date: '2024-03-01' });

    await createEntry(db, householdId, [
      { account_id: uncatIncome, amount: -300 },
      { account_id: savings, amount: 300 },
    ], { description: 'Transfer in', date: '2024-03-10' }); // 9 days later

    const result = await runMatchmaker(db, householdId);
    expect(result.transfers_auto_merged).toBe(0);
    expect(result.transfer_suggestions).toBe(0);
  });
});

// --- Suggestions lifecycle ---

describe('Suggestion lifecycle', () => {
  it('confirm merges entries and supersedes originals', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-confirm', 'asset');
    const savings = await createAccount(db, householdId, 'Savings-confirm', 'asset');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');
    const uncatIncome = await createAccount(db, householdId, 'Uncategorized Income', 'income');

    const entryA = await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 750 },
      { account_id: checking, amount: -750 },
    ], { description: 'Wire out', date: '2024-04-01' });

    const entryB = await createEntry(db, householdId, [
      { account_id: uncatIncome, amount: -750 },
      { account_id: savings, amount: 750 },
    ], { description: 'Wire in', date: '2024-04-03' });

    // Create suggestion manually
    const suggestionId = nanoid();
    await db.insertInto('match_suggestions').values({
      id: suggestionId,
      household_id: householdId,
      match_type: 'transfer',
      entry_a_id: entryA,
      entry_b_id: entryB,
      confidence: 0.75,
      status: 'pending',
      metadata: JSON.stringify({ amount: 750 }),
      created_at: new Date().toISOString(),
    }).execute();

    await confirmTransferSuggestion(db, householdId, suggestionId);

    // Suggestion is confirmed
    const suggestion = await db.selectFrom('match_suggestions')
      .where('id', '=', suggestionId)
      .selectAll()
      .executeTakeFirst();
    expect(suggestion?.status).toBe('confirmed');

    // Originals are superseded
    const origA = await db.selectFrom('journal_entries').where('id', '=', entryA).selectAll().executeTakeFirst();
    const origB = await db.selectFrom('journal_entries').where('id', '=', entryB).selectAll().executeTakeFirst();
    expect(origA?.superseded_by).toBeTruthy();
    expect(origB?.superseded_by).toBe(origA?.superseded_by); // Same replacement
    expect(origA?.exclude_from_totals).toBe(true);

    // New transfer entry exists with two bank lines
    const newEntry = await db.selectFrom('journal_entries')
      .where('id', '=', origA!.superseded_by!)
      .selectAll()
      .executeTakeFirst();
    expect(newEntry?.source).toBe('matchmaker');

    const newLines = await db.selectFrom('journal_lines')
      .where('journal_entry_id', '=', newEntry!.id)
      .selectAll()
      .execute();
    expect(newLines.length).toBe(2);
    expect(newLines.reduce((s, l) => s + Number(l.amount), 0)).toBeCloseTo(0);
  });

  it('dismiss marks suggestion as dismissed', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-dismiss', 'asset');
    const savings = await createAccount(db, householdId, 'Savings-dismiss', 'asset');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');
    const uncatIncome = await createAccount(db, householdId, 'Uncategorized Income', 'income');

    const entryA = await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 100 },
      { account_id: checking, amount: -100 },
    ], { description: 'Not a transfer', date: '2024-04-01' });

    const entryB = await createEntry(db, householdId, [
      { account_id: uncatIncome, amount: -100 },
      { account_id: savings, amount: 100 },
    ], { description: 'Also not a transfer', date: '2024-04-02' });

    const suggestionId = nanoid();
    await db.insertInto('match_suggestions').values({
      id: suggestionId,
      household_id: householdId,
      match_type: 'transfer',
      entry_a_id: entryA,
      entry_b_id: entryB,
      confidence: 0.60,
      status: 'pending',
      metadata: JSON.stringify({ amount: 100 }),
      created_at: new Date().toISOString(),
    }).execute();

    await dismissSuggestion(db, householdId, suggestionId);

    const suggestion = await db.selectFrom('match_suggestions')
      .where('id', '=', suggestionId)
      .selectAll()
      .executeTakeFirst();
    expect(suggestion?.status).toBe('dismissed');

    // Entries are unchanged
    const origA = await db.selectFrom('journal_entries').where('id', '=', entryA).selectAll().executeTakeFirst();
    expect(origA?.superseded_by).toBeNull();
  });
});

// --- Integration: full pipeline ---

describe('Full matchmaker pipeline', () => {
  it('runs all four passes in order', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-full', 'asset');
    const savings = await createAccount(db, householdId, 'Savings-full', 'asset');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');
    const uncatIncome = await createAccount(db, householdId, 'Uncategorized Income', 'income');

    // 1. Entry with Plaid category → should be auto-categorized by Pass 1
    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 25 },
      { account_id: checking, amount: -25 },
    ], { description: 'Starbucks', plaid_category: 'FOOD_AND_DRINK', date: '2024-05-01' });

    // 2. Transfer pair with Plaid tags → should be auto-merged by Pass 2
    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 1000 },
      { account_id: checking, amount: -1000 },
    ], { description: 'Transfer to Savings', plaid_category: 'TRANSFER_OUT', date: '2024-05-02' });

    await createEntry(db, householdId, [
      { account_id: uncatIncome, amount: -1000 },
      { account_id: savings, amount: 1000 },
    ], { description: 'Transfer from Checking', plaid_category: 'TRANSFER_IN', date: '2024-05-02' });

    // 3. Entry with no Plaid category → should remain uncategorized
    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 15 },
      { account_id: checking, amount: -15 },
    ], { description: 'Random purchase', date: '2024-05-03' });

    const result = await runMatchmaker(db, householdId);

    expect(result.plaid_categorized).toBe(1);       // Starbucks
    expect(result.transfers_auto_merged).toBe(1);    // The transfer pair
    expect(result.uncategorized_remaining).toBe(1);  // Random purchase
  });

  it('superseded entries are excluded from re-runs', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-rerun', 'asset');
    const savings = await createAccount(db, householdId, 'Savings-rerun', 'asset');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');
    const uncatIncome = await createAccount(db, householdId, 'Uncategorized Income', 'income');

    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 500 },
      { account_id: checking, amount: -500 },
    ], { description: 'Transfer', plaid_category: 'TRANSFER_OUT', date: '2024-06-01' });

    await createEntry(db, householdId, [
      { account_id: uncatIncome, amount: -500 },
      { account_id: savings, amount: 500 },
    ], { description: 'Transfer', plaid_category: 'TRANSFER_IN', date: '2024-06-01' });

    // First run
    const result1 = await runMatchmaker(db, householdId);
    expect(result1.transfers_auto_merged).toBe(1);

    // Second run — should find nothing
    const result2 = await runMatchmaker(db, householdId);
    expect(result2.transfers_auto_merged).toBe(0);
    expect(result2.plaid_categorized).toBe(0);
    expect(result2.entries_categorized).toBe(0);
  });
});

// --- applyOneRule ---

describe('applyOneRule', () => {
  it('applies a single rule without triggering transfer detection', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-one', 'asset');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');
    const dining = await createAccount(db, householdId, 'Dining-one', 'expense');

    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 45 },
      { account_id: checking, amount: -45 },
    ], { description: 'CHIPOTLE #123', date: '2024-07-01' });

    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 30 },
      { account_id: checking, amount: -30 },
    ], { description: 'CHIPOTLE #456', date: '2024-07-05' });

    const rule = {
      match_field: 'description',
      match_type: 'contains',
      match_value: 'chipotle',
      target_account_id: dining,
    };

    const applied = await applyOneRule(db, householdId, rule);
    expect(applied).toBe(2);

    // Verify both lines updated
    const lines = await db.selectFrom('journal_lines')
      .where('account_id', '=', dining)
      .selectAll()
      .execute();
    expect(lines.length).toBe(2);
  });
});

// --- routeUnmatchedTransfers (pass 2.5) ---

describe('Route unmatched transfers', () => {
  it('routes single-sided transfer-category entries to Transfers account', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-xfer', 'asset');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');

    // Brokerage transfer — Plaid tagged as TRANSFER_OUT, no counterpart
    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 5000 },
      { account_id: checking, amount: -5000 },
    ], { description: 'SCHWAB MONEYLINK', plaid_category: 'TRANSFER_OUT', date: '2024-08-07' });

    const result = await runMatchmaker(db, householdId);
    expect(result.transfers_routed).toBe(1);

    // Verify it landed in a "Transfers" account, not Uncategorized
    const transferAcct = await db.selectFrom('accounts')
      .where('household_id', '=', householdId)
      .where('name', '=', 'Transfers')
      .selectAll()
      .executeTakeFirst();
    expect(transferAcct).toBeTruthy();
    expect(transferAcct!.exclude_from_totals).toBe(true);
    expect(transferAcct!.is_hidden).toBe(true);
  });

  it('does NOT route non-transfer uncategorized entries', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-noroute', 'asset');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');

    // Regular expense — no Plaid transfer category
    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 42 },
      { account_id: checking, amount: -42 },
    ], { description: 'RANDOM STORE', plaid_category: 'GENERAL_MERCHANDISE', date: '2024-08-01' });

    const result = await runMatchmaker(db, householdId);
    expect(result.transfers_routed).toBe(0);

    // Should still be in Uncategorized (Plaid auto-categorization may have moved it,
    // but NOT to Transfers)
    const transferAcct = await db.selectFrom('accounts')
      .where('household_id', '=', householdId)
      .where('name', '=', 'Transfers')
      .select('id')
      .executeTakeFirst();
    // Transfers account shouldn't even be created if there's nothing to route
    expect(transferAcct).toBeUndefined();
  });

  it('user rule in pass 3 overrides transfer routing', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-override', 'asset');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');
    const housing = await createAccount(db, householdId, 'Housing', 'expense');

    // Mortgage payment — Plaid says LOAN_PAYMENTS
    const entryId = await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 2500 },
      { account_id: checking, amount: -2500 },
    ], { description: 'REDWOOD CREDIT MTGPAYMENT', plaid_category: 'LOAN_PAYMENTS', date: '2024-08-03' });

    // User rule: mortgage → Housing (overrides pass 2.5)
    await db.insertInto('category_rules').values({
      id: nanoid(),
      household_id: householdId,
      match_field: 'description',
      match_type: 'contains',
      match_value: 'REDWOOD',
      target_account_id: housing,
      priority: 10,
      created_at: new Date().toISOString(),
    }).execute();

    const result = await runMatchmaker(db, householdId);
    expect(result.transfers_routed).toBe(1); // pass 2.5 routes it first
    expect(result.entries_categorized).toBe(1); // pass 3 overrides to Housing

    // Verify it ended up in Housing, not Transfers
    const line = await db.selectFrom('journal_lines')
      .where('journal_entry_id', '=', entryId)
      .where('account_id', '=', housing)
      .selectAll()
      .executeTakeFirst();
    expect(line).toBeTruthy();
  });

  it('Transfers account is created idempotently on second run', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-idem', 'asset');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');

    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 100 },
      { account_id: checking, amount: -100 },
    ], { description: 'ZELLE PAYMENT', plaid_category: 'TRANSFER_OUT', date: '2024-08-01' });

    // First run creates the Transfers account
    await runMatchmaker(db, householdId);

    // Add another transfer
    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 200 },
      { account_id: checking, amount: -200 },
    ], { description: 'WIRE TRANSFER', plaid_category: 'TRANSFER_OUT', date: '2024-08-05' });

    // Second run should reuse the existing Transfers account
    const result = await runMatchmaker(db, householdId);
    expect(result.transfers_routed).toBe(1);

    // Only one Transfers account exists
    const transferAccts = await db.selectFrom('accounts')
      .where('household_id', '=', householdId)
      .where('name', '=', 'Transfers')
      .selectAll()
      .execute();
    expect(transferAccts.length).toBe(1);
  });
});

// --- Staggered transfer detection (includeTransfers) ---

describe('Staggered transfer detection', () => {
  it('merges counterpart arriving after first side was routed to Transfers', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-stagger', 'asset');
    const savings = await createAccount(db, householdId, 'Savings-stagger', 'asset');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');
    const uncatIncome = await createAccount(db, householdId, 'Uncategorized Income', 'income');

    // First sync: only the checking side arrives — gets routed to Transfers by pass 2.5
    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 1000 },
      { account_id: checking, amount: -1000 },
    ], { description: 'Transfer to Savings', plaid_category: 'TRANSFER_OUT', date: '2024-09-01' });

    const result1 = await runMatchmaker(db, householdId);
    expect(result1.transfers_routed).toBe(1);
    expect(result1.transfers_auto_merged).toBe(0);

    // Second sync: counterpart arrives in savings
    await createEntry(db, householdId, [
      { account_id: uncatIncome, amount: -1000 },
      { account_id: savings, amount: 1000 },
    ], { description: 'Transfer from Checking', plaid_category: 'TRANSFER_IN', date: '2024-09-01' });

    // Pass 2 should now see the Transfers-routed entry + the new uncategorized entry
    const result2 = await runMatchmaker(db, householdId);
    expect(result2.transfers_auto_merged).toBe(1);

    // Verify: new transfer entry exists, both originals superseded
    const transferEntries = await db.selectFrom('journal_entries')
      .where('household_id', '=', householdId)
      .where('source', '=', 'matchmaker')
      .where('superseded_by', 'is', null)
      .selectAll()
      .execute();
    expect(transferEntries.length).toBe(1);
    expect(transferEntries[0].description).toContain('Transfer:');

    const superseded = await db.selectFrom('journal_entries')
      .where('household_id', '=', householdId)
      .where('superseded_by', 'is not', null)
      .selectAll()
      .execute();
    expect(superseded.length).toBe(2);
  });

  it('does not re-propose dismissed pairs on subsequent runs', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-dismiss2', 'asset');
    const savings = await createAccount(db, householdId, 'Savings-dismiss2', 'asset');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');
    const uncatIncome = await createAccount(db, householdId, 'Uncategorized Income', 'income');

    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 500 },
      { account_id: checking, amount: -500 },
    ], { description: 'Wire out', date: '2024-10-01' });

    await createEntry(db, householdId, [
      { account_id: uncatIncome, amount: -500 },
      { account_id: savings, amount: 500 },
    ], { description: 'Wire in', date: '2024-10-03' });

    // First run: creates a suggestion
    const result1 = await runMatchmaker(db, householdId);
    expect(result1.transfer_suggestions).toBe(1);

    // Dismiss it
    const suggestion = await db.selectFrom('match_suggestions')
      .where('household_id', '=', householdId)
      .where('status', '=', 'pending')
      .selectAll()
      .executeTakeFirst();
    await dismissSuggestion(db, householdId, suggestion!.id);

    // Second run: same pair should NOT be re-proposed
    const result2 = await runMatchmaker(db, householdId);
    expect(result2.transfer_suggestions).toBe(0);
    expect(result2.transfers_auto_merged).toBe(0);
  });

  it('matches verified orphan in Uncategorized with new counterpart', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking-orphan', 'asset');
    const creditCard = await createAccount(db, householdId, 'Visa-orphan', 'liability');
    const uncatExpense = await createAccount(db, householdId, 'Uncategorized', 'expense');
    const uncatIncome = await createAccount(db, householdId, 'Uncategorized Income', 'income');

    // Orphaned entry: CC side is verified but stuck in Uncategorized Income
    // (simulates a reconnection scenario where a previous merge was lost)
    const orphanId = await createEntry(db, householdId, [
      { account_id: uncatIncome, amount: -1347.07 },
      { account_id: creditCard, amount: 1347.07 },
    ], { description: 'CAPITAL ONE ONLINE PYMT', plaid_category: 'TRANSFER_IN', date: '2024-09-15' });

    // Mark it as verified (orphan from a previous merge)
    await db.updateTable('journal_entries')
      .set({ is_verified: true })
      .where('id', '=', orphanId)
      .execute();

    // New counterpart from checking side (unverified)
    await createEntry(db, householdId, [
      { account_id: uncatExpense, amount: 1347.07 },
      { account_id: checking, amount: -1347.07 },
    ], { description: 'CAPITAL ONE ONLINE PMT', plaid_category: 'TRANSFER_OUT', date: '2024-09-15' });

    const result = await runMatchmaker(db, householdId);
    // Verified entries get routed to suggestions, never auto-merged
    expect(result.transfers_auto_merged).toBe(0);
    expect(result.transfer_suggestions).toBe(1);

    // Verify it's tagged as cc_payment
    const suggestion = await db.selectFrom('match_suggestions')
      .where('household_id', '=', householdId)
      .where('status', '=', 'pending')
      .selectAll()
      .executeTakeFirst();
    expect(suggestion?.match_type).toBe('cc_payment');
    expect(Number(suggestion?.confidence)).toBeLessThan(0.90);
  });
});

// --- stripReferenceNumbers ---

describe('stripReferenceNumbers', () => {
  it('strips PPD ID references', () => {
    expect(stripReferenceNumbers('SCHWAB BROKERAGE MONEYLINK PPD ID: 9005586224'))
      .toBe('SCHWAB BROKERAGE MONEYLINK');
    expect(stripReferenceNumbers('AL ADVISORS MANA PAYROLL PPD ID: 9111111103'))
      .toBe('AL ADVISORS MANA PAYROLL');
  });

  it('strips WEB ID references', () => {
    expect(stripReferenceNumbers('CAPITAL ONE ONLINE PMT CA02A152CF3A048 WEB ID: 9279744391'))
      .toBe('CAPITAL ONE ONLINE PMT');
    expect(stripReferenceNumbers('PGANDE WEB ONLINE 83317648071126 WEB ID: 5940742640'))
      .toBe('PGANDE WEB ONLINE');
  });

  it('strips trailing alphanumeric reference codes (8+ chars)', () => {
    expect(stripReferenceNumbers('Zelle payment to Alexander Okrainsky JPM99craeo7v'))
      .toBe('Zelle payment to Alexander Okrainsky');
    expect(stripReferenceNumbers('AngelList YFJTTZPT82'))
      .toBe('AngelList');
  });

  it('strips PURCHASE + digits patterns', () => {
    expect(stripReferenceNumbers('ST OF CA DMV PURCHASE 116672257260803 WEB ID: 1680311348'))
      .toBe('ST OF CA DMV');
  });

  it('strips trailing transaction IDs after *', () => {
    expect(stripReferenceNumbers('Amazon.com*569B61IR1'))
      .toBe('Amazon.com');
    expect(stripReferenceNumbers('AMAZON MKTPL*5H58357Z2'))
      .toBe('AMAZON MKTPL');
  });

  it('leaves clean merchant names untouched', () => {
    expect(stripReferenceNumbers('Whole Foods')).toBe('Whole Foods');
    expect(stripReferenceNumbers('COSTCO WHSE #0144')).toBe('COSTCO WHSE #0144');
    expect(stripReferenceNumbers('Uber')).toBe('Uber');
    expect(stripReferenceNumbers('APPLE.COM/BILL')).toBe('APPLE.COM/BILL');
  });

  it('leaves short trailing codes alone (< 8 chars)', () => {
    expect(stripReferenceNumbers('CHECK # 244')).toBe('CHECK # 244');
    expect(stripReferenceNumbers('LIME*2 RIDES L5JH')).toBe('LIME*2 RIDES L5JH');
  });

  it('handles multiple patterns in one string', () => {
    expect(stripReferenceNumbers('REDWOOD CREDIT U MTGPAYMENT PPD ID: 6362435132'))
      .toBe('REDWOOD CREDIT U MTGPAYMENT');
  });
});
