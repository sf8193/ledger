import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Kysely, sql } from 'kysely';
import { Database } from '../db/types';
import { setupTestDb, teardownTestDb, createTestHousehold, getLedgerBalance } from './setup';

let db: Kysely<Database>;
let householdId: string;

beforeAll(async () => {
  db = await setupTestDb();
}, 30000);

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  // Clean slate for each test
  const h = await createTestHousehold(db);
  householdId = h.householdId;
});

describe('Monarch transaction import', () => {
  it('creates accounts, categories, and journal entries from CSV data', async () => {
    // Simulate what the import route does
    const { nanoid } = await import('nanoid');

    // Create an asset account
    const acctId = nanoid();
    await db.insertInto('accounts').values({
      id: acctId, household_id: householdId, name: 'Main Checking',
      account_type: 'asset', plaid_item_id: null, plaid_account_id: null,
      institution_name: null, mask: null, subtype: null, is_hidden: false,
      icon: null, color: null, parent_id: null, sort_order: 0,
      is_manual: true, owner: null,
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }).execute();

    // Create an expense category
    const catId = nanoid();
    await db.insertInto('accounts').values({
      id: catId, household_id: householdId, name: 'Groceries',
      account_type: 'expense', plaid_item_id: null, plaid_account_id: null,
      institution_name: null, mask: null, subtype: null, is_hidden: false,
      icon: null, color: null, parent_id: null, sort_order: 0,
      is_manual: false, owner: null,
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }).execute();

    // Simulate a Monarch expense: Amount = -85 (negative = money out)
    // expenseAmount = -(-85) = 85 → debit expense
    const entryId = nanoid();
    await db.insertInto('journal_entries').values({
      id: entryId, household_id: householdId, date: '2024-01-15',
      description: 'Whole Foods', merchant_name: 'Whole Foods',
      notes: null, owner: 'Shared', is_verified: false,
      plaid_transaction_id: 'monarch_12345', source: 'monarch_import',
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }).execute();

    await db.insertInto('journal_lines').values([
      { id: nanoid(), journal_entry_id: entryId, account_id: catId, amount: 85, created_at: new Date().toISOString() },
      { id: nanoid(), journal_entry_id: entryId, account_id: acctId, amount: -85, created_at: new Date().toISOString() },
    ]).execute();

    // Verify
    expect(await getLedgerBalance(db, acctId)).toBe(-85);
    expect(await getLedgerBalance(db, catId)).toBe(85);
  });

  it('income transaction: positive Monarch amount → credit income + debit bank', async () => {
    const { nanoid } = await import('nanoid');

    const acctId = nanoid();
    await db.insertInto('accounts').values({
      id: acctId, household_id: householdId, name: 'Checking Income',
      account_type: 'asset', plaid_item_id: null, plaid_account_id: null,
      institution_name: null, mask: null, subtype: null, is_hidden: false,
      icon: null, color: null, parent_id: null, sort_order: 0,
      is_manual: true, owner: null,
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }).execute();

    const incomeId = nanoid();
    await db.insertInto('accounts').values({
      id: incomeId, household_id: householdId, name: 'Paychecks',
      account_type: 'income', plaid_item_id: null, plaid_account_id: null,
      institution_name: null, mask: null, subtype: null, is_hidden: false,
      icon: null, color: null, parent_id: null, sort_order: 0,
      is_manual: false, owner: null,
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }).execute();

    // Monarch paycheck: Amount = 5850 (positive = money in)
    // expenseAmount = -(5850) = -5850 → credit income account
    const entryId = nanoid();
    await db.insertInto('journal_entries').values({
      id: entryId, household_id: householdId, date: '2024-01-14',
      description: 'GUSTO PAY', merchant_name: null,
      notes: null, owner: 'Shared', is_verified: false,
      plaid_transaction_id: 'monarch_67890', source: 'monarch_import',
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }).execute();

    await db.insertInto('journal_lines').values([
      { id: nanoid(), journal_entry_id: entryId, account_id: incomeId, amount: -5850, created_at: new Date().toISOString() },
      { id: nanoid(), journal_entry_id: entryId, account_id: acctId, amount: 5850, created_at: new Date().toISOString() },
    ]).execute();

    expect(await getLedgerBalance(db, acctId)).toBe(5850);
    expect(await getLedgerBalance(db, incomeId)).toBe(-5850); // income has credit-normal (negative)
  });

  it('transfer pairing: asset↔asset, no expense account', async () => {
    const { nanoid } = await import('nanoid');

    const checkingId = nanoid();
    const savingsId = nanoid();
    for (const [id, name] of [[checkingId, 'Checking Xfer'], [savingsId, 'Savings Xfer']] as const) {
      await db.insertInto('accounts').values({
        id, household_id: householdId, name,
        account_type: 'asset', plaid_item_id: null, plaid_account_id: null,
        institution_name: null, mask: null, subtype: null, is_hidden: false,
        icon: null, color: null, parent_id: null, sort_order: 0,
        is_manual: true, owner: null,
        updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
      }).execute();
    }

    // $500 transfer: checking → savings
    const entryId = nanoid();
    await db.insertInto('journal_entries').values({
      id: entryId, household_id: householdId, date: '2024-01-13',
      description: 'Transfer', merchant_name: null,
      notes: null, owner: null, is_verified: false,
      plaid_transaction_id: null, source: 'monarch_import',
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }).execute();

    await db.insertInto('journal_lines').values([
      { id: nanoid(), journal_entry_id: entryId, account_id: savingsId, amount: 500, created_at: new Date().toISOString() },
      { id: nanoid(), journal_entry_id: entryId, account_id: checkingId, amount: -500, created_at: new Date().toISOString() },
    ]).execute();

    expect(await getLedgerBalance(db, checkingId)).toBe(-500);
    expect(await getLedgerBalance(db, savingsId)).toBe(500);

    // Verify NO expense accounts were touched
    const expenseTotal = await db.selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', 'expense')
      .select(sql<number>`COALESCE(SUM(jl.amount), 0)`.as('total'))
      .executeTakeFirst();

    expect(Number(expenseTotal?.total)).toBe(0);
  });

  it('dedup: re-importing same monarch ID does not create duplicate', async () => {
    const { nanoid } = await import('nanoid');

    const acctId = nanoid();
    const catId = nanoid();
    for (const [id, name, type] of [
      [acctId, 'Checking Dedup', 'asset'],
      [catId, 'Shopping Dedup', 'expense'],
    ] as const) {
      await db.insertInto('accounts').values({
        id, household_id: householdId, name, account_type: type,
        plaid_item_id: null, plaid_account_id: null, institution_name: null,
        mask: null, subtype: null, is_hidden: false, icon: null, color: null,
        parent_id: null, sort_order: 0, is_manual: type === 'asset', owner: null,
        updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
      }).execute();
    }

    const dedupId = 'monarch_99999';

    // First import
    const e1 = nanoid();
    await db.insertInto('journal_entries').values({
      id: e1, household_id: householdId, date: '2024-02-01',
      description: 'Amazon', merchant_name: 'Amazon',
      notes: null, owner: null, is_verified: false,
      plaid_transaction_id: dedupId, source: 'monarch_import',
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }).execute();
    await db.insertInto('journal_lines').values([
      { id: nanoid(), journal_entry_id: e1, account_id: catId, amount: 50, created_at: new Date().toISOString() },
      { id: nanoid(), journal_entry_id: e1, account_id: acctId, amount: -50, created_at: new Date().toISOString() },
    ]).execute();

    // Second import with same ID — should fail on unique constraint
    const e2 = nanoid();
    await expect(
      db.insertInto('journal_entries').values({
        id: e2, household_id: householdId, date: '2024-02-01',
        description: 'Amazon', merchant_name: 'Amazon',
        notes: null, owner: null, is_verified: false,
        plaid_transaction_id: dedupId, source: 'monarch_import',
        updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
      }).execute()
    ).rejects.toThrow(); // unique constraint on plaid_transaction_id

    // Only one entry exists
    const count = await db.selectFrom('journal_entries')
      .where('plaid_transaction_id', '=', dedupId)
      .select(sql<number>`COUNT(*)`.as('count'))
      .executeTakeFirst();
    expect(Number(count?.count)).toBe(1);
  });
});

describe('Spending queries exclude transfers', () => {
  it('spending = SUM of debits to expense accounts only', async () => {
    const { nanoid } = await import('nanoid');

    const checking = nanoid();
    const savings = nanoid();
    const groceries = nanoid();
    const equity = nanoid();

    for (const [id, name, type] of [
      [checking, 'Checking Spend', 'asset'],
      [savings, 'Savings Spend', 'asset'],
      [groceries, 'Groceries Spend', 'expense'],
      [equity, 'OB Spend', 'equity'],
    ] as const) {
      await db.insertInto('accounts').values({
        id, household_id: householdId, name, account_type: type,
        plaid_item_id: null, plaid_account_id: null, institution_name: null,
        mask: null, subtype: null, is_hidden: false, icon: null, color: null,
        parent_id: null, sort_order: 0, is_manual: true, owner: null,
        updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
      }).execute();
    }

    // Opening balance: $10K
    const e1 = nanoid();
    await db.insertInto('journal_entries').values({
      id: e1, household_id: householdId, date: '2024-01-01',
      description: 'Opening', merchant_name: null, notes: null, owner: null,
      is_verified: true, plaid_transaction_id: null, source: 'test',
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }).execute();
    await db.insertInto('journal_lines').values([
      { id: nanoid(), journal_entry_id: e1, account_id: checking, amount: 10000, created_at: new Date().toISOString() },
      { id: nanoid(), journal_entry_id: e1, account_id: equity, amount: -10000, created_at: new Date().toISOString() },
    ]).execute();

    // $85 grocery purchase
    const e2 = nanoid();
    await db.insertInto('journal_entries').values({
      id: e2, household_id: householdId, date: '2024-01-15',
      description: 'Groceries', merchant_name: null, notes: null, owner: null,
      is_verified: false, plaid_transaction_id: null, source: 'test',
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }).execute();
    await db.insertInto('journal_lines').values([
      { id: nanoid(), journal_entry_id: e2, account_id: groceries, amount: 85, created_at: new Date().toISOString() },
      { id: nanoid(), journal_entry_id: e2, account_id: checking, amount: -85, created_at: new Date().toISOString() },
    ]).execute();

    // $500 transfer (asset → asset, NOT spending)
    const e3 = nanoid();
    await db.insertInto('journal_entries').values({
      id: e3, household_id: householdId, date: '2024-01-16',
      description: 'Transfer', merchant_name: null, notes: null, owner: null,
      is_verified: false, plaid_transaction_id: null, source: 'test',
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }).execute();
    await db.insertInto('journal_lines').values([
      { id: nanoid(), journal_entry_id: e3, account_id: savings, amount: 500, created_at: new Date().toISOString() },
      { id: nanoid(), journal_entry_id: e3, account_id: checking, amount: -500, created_at: new Date().toISOString() },
    ]).execute();

    // Spending query: SUM(debits to expense accounts)
    const spending = await db.selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', 'expense')
      .where('jl.amount', '>', 0)
      .select(sql<number>`COALESCE(SUM(jl.amount), 0)`.as('total'))
      .executeTakeFirst();

    // Should be $85 (groceries only), NOT $585 (groceries + transfer)
    expect(Number(spending?.total)).toBe(85);
  });
});

describe('Liability balance conventions', () => {
  it('credit card purchase increases liability (more negative in ledger)', async () => {
    const { nanoid } = await import('nanoid');

    const creditCard = nanoid();
    const groceries = nanoid();
    const equity = nanoid();

    for (const [id, name, type] of [
      [creditCard, 'Credit Card Liability', 'liability'],
      [groceries, 'Groceries Liab', 'expense'],
      [equity, 'OB Liab', 'equity'],
    ] as const) {
      await db.insertInto('accounts').values({
        id, household_id: householdId, name, account_type: type,
        plaid_item_id: null, plaid_account_id: null, institution_name: null,
        mask: null, subtype: null, is_hidden: false, icon: null, color: null,
        parent_id: null, sort_order: 0, is_manual: true, owner: null,
        updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
      }).execute();
    }

    // Opening: owe $3,000
    const e1 = nanoid();
    await db.insertInto('journal_entries').values({
      id: e1, household_id: householdId, date: '2024-01-01',
      description: 'Opening', merchant_name: null, notes: null, owner: null,
      is_verified: true, plaid_transaction_id: null, source: 'test',
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }).execute();
    await db.insertInto('journal_lines').values([
      { id: nanoid(), journal_entry_id: e1, account_id: creditCard, amount: -3000, created_at: new Date().toISOString() },
      { id: nanoid(), journal_entry_id: e1, account_id: equity, amount: 3000, created_at: new Date().toISOString() },
    ]).execute();

    // $85 grocery charge on credit card
    const e2 = nanoid();
    await db.insertInto('journal_entries').values({
      id: e2, household_id: householdId, date: '2024-01-15',
      description: 'Whole Foods', merchant_name: null, notes: null, owner: null,
      is_verified: false, plaid_transaction_id: null, source: 'test',
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }).execute();
    await db.insertInto('journal_lines').values([
      { id: nanoid(), journal_entry_id: e2, account_id: groceries, amount: 85, created_at: new Date().toISOString() },
      { id: nanoid(), journal_entry_id: e2, account_id: creditCard, amount: -85, created_at: new Date().toISOString() },
    ]).execute();

    // Liability balance: -3000 + (-85) = -3085
    expect(await getLedgerBalance(db, creditCard)).toBe(-3085);

    // Credit card payment: $1000 from checking to credit card
    const checking = nanoid();
    await db.insertInto('accounts').values({
      id: checking, household_id: householdId, name: 'Checking Payment',
      account_type: 'asset', plaid_item_id: null, plaid_account_id: null,
      institution_name: null, mask: null, subtype: null, is_hidden: false,
      icon: null, color: null, parent_id: null, sort_order: 0,
      is_manual: true, owner: null,
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }).execute();

    // Opening balance for checking
    const e3 = nanoid();
    await db.insertInto('journal_entries').values({
      id: e3, household_id: householdId, date: '2024-01-01',
      description: 'OB Checking', merchant_name: null, notes: null, owner: null,
      is_verified: true, plaid_transaction_id: null, source: 'test',
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }).execute();
    await db.insertInto('journal_lines').values([
      { id: nanoid(), journal_entry_id: e3, account_id: checking, amount: 5000, created_at: new Date().toISOString() },
      { id: nanoid(), journal_entry_id: e3, account_id: equity, amount: -5000, created_at: new Date().toISOString() },
    ]).execute();

    // CC payment: debit liability (reduces debt) + credit asset (money out)
    const e4 = nanoid();
    await db.insertInto('journal_entries').values({
      id: e4, household_id: householdId, date: '2024-01-20',
      description: 'CC Payment', merchant_name: null, notes: null, owner: null,
      is_verified: false, plaid_transaction_id: null, source: 'test',
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }).execute();
    await db.insertInto('journal_lines').values([
      { id: nanoid(), journal_entry_id: e4, account_id: creditCard, amount: 1000, created_at: new Date().toISOString() },
      { id: nanoid(), journal_entry_id: e4, account_id: checking, amount: -1000, created_at: new Date().toISOString() },
    ]).execute();

    // After payment: owe $2,085
    expect(await getLedgerBalance(db, creditCard)).toBe(-2085);
    expect(await getLedgerBalance(db, checking)).toBe(4000);

    // CC payment should NOT appear as spending
    const spending = await db.selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', 'expense')
      .where('jl.amount', '>', 0)
      .select(sql<number>`COALESCE(SUM(jl.amount), 0)`.as('total'))
      .executeTakeFirst();

    expect(Number(spending?.total)).toBe(85); // Only groceries, not the payment
  });
});
