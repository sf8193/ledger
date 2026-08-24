import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Kysely, sql } from 'kysely';
import { Database } from '../db/types';
import {
  setupTestDb, teardownTestDb, createTestHousehold,
  createAccount, createEntry, getLedgerBalance,
} from './setup';

let db: Kysely<Database>;

beforeAll(async () => {
  db = await setupTestDb();
}, 30000);

afterAll(async () => {
  await teardownTestDb();
});

describe('Zero-sum invariant', () => {
  it('accepts a balanced two-line entry', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const groceries = await createAccount(db, householdId, 'Groceries', 'expense');

    // Should not throw
    await createEntry(db, householdId, [
      { account_id: groceries, amount: 85 },
      { account_id: checking, amount: -85 },
    ]);
  });

  it('rejects an unbalanced entry', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking2', 'asset');
    const groceries = await createAccount(db, householdId, 'Groceries2', 'expense');

    await expect(
      createEntry(db, householdId, [
        { account_id: groceries, amount: 85 },
        { account_id: checking, amount: -84 }, // off by $1
      ])
    ).rejects.toThrow(/unbalanced/i);
  });

  it('rejects deleting a single line (phantom entry)', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking3', 'asset');
    const groceries = await createAccount(db, householdId, 'Groceries3', 'expense');

    const entryId = await createEntry(db, householdId, [
      { account_id: groceries, amount: 50 },
      { account_id: checking, amount: -50 },
    ]);

    // Get one line
    const line = await db.selectFrom('journal_lines')
      .where('journal_entry_id', '=', entryId)
      .select('id')
      .executeTakeFirst();

    // Deleting one line should fail (unbalanced)
    await expect(
      db.deleteFrom('journal_lines').where('id', '=', line!.id).execute()
    ).rejects.toThrow();
  });

  it('allows CASCADE delete of entire entry', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking4', 'asset');
    const groceries = await createAccount(db, householdId, 'Groceries4', 'expense');

    const entryId = await createEntry(db, householdId, [
      { account_id: groceries, amount: 30 },
      { account_id: checking, amount: -30 },
    ]);

    // Deleting the parent entry should cascade-delete lines without trigger error
    await db.deleteFrom('journal_entries').where('id', '=', entryId).execute();

    const remaining = await db.selectFrom('journal_lines')
      .where('journal_entry_id', '=', entryId)
      .selectAll()
      .execute();
    expect(remaining).toHaveLength(0);
  });
});

describe('Sign conventions', () => {
  it('asset opening balance: positive debit increases balance', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'CheckingSC', 'asset');
    const equity = await createAccount(db, householdId, 'Opening Balances', 'equity');

    await createEntry(db, householdId, [
      { account_id: checking, amount: 10000 },   // debit asset = money in
      { account_id: equity, amount: -10000 },
    ]);

    const balance = await getLedgerBalance(db, checking);
    expect(balance).toBe(10000);
  });

  it('liability opening balance: negative credit increases what you owe', async () => {
    const { householdId } = await createTestHousehold(db);
    const creditCard = await createAccount(db, householdId, 'CreditCardSC', 'liability');
    const equity = await createAccount(db, householdId, 'Opening Balances2', 'equity');

    // $3,000 owed: credit the liability (negative in ledger)
    await createEntry(db, householdId, [
      { account_id: creditCard, amount: -3000 },  // credit liability = owe more
      { account_id: equity, amount: 3000 },
    ]);

    const balance = await getLedgerBalance(db, creditCard);
    expect(balance).toBe(-3000); // negative in ledger = you owe $3K
  });

  it('expense purchase: debit expense + credit asset', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'CheckingExp', 'asset');
    const groceries = await createAccount(db, householdId, 'GroceriesExp', 'expense');
    const equity = await createAccount(db, householdId, 'OB3', 'equity');

    // Opening balance
    await createEntry(db, householdId, [
      { account_id: checking, amount: 10000 },
      { account_id: equity, amount: -10000 },
    ]);

    // $85 grocery purchase
    await createEntry(db, householdId, [
      { account_id: groceries, amount: 85 },    // debit expense
      { account_id: checking, amount: -85 },     // credit asset
    ]);

    expect(await getLedgerBalance(db, checking)).toBe(9915);
    expect(await getLedgerBalance(db, groceries)).toBe(85);
  });

  it('transfer: asset-to-asset, no expense involved', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'CheckingXfer', 'asset');
    const savings = await createAccount(db, householdId, 'SavingsXfer', 'asset');
    const equity = await createAccount(db, householdId, 'OB4', 'equity');

    // Opening balances
    await createEntry(db, householdId, [
      { account_id: checking, amount: 10000 },
      { account_id: equity, amount: -10000 },
    ]);

    // Transfer $500
    await createEntry(db, householdId, [
      { account_id: savings, amount: 500 },      // debit savings = money in
      { account_id: checking, amount: -500 },     // credit checking = money out
    ]);

    expect(await getLedgerBalance(db, checking)).toBe(9500);
    expect(await getLedgerBalance(db, savings)).toBe(500);

    // No expense accounts involved — spending queries won't see this
  });

  it('net worth = SUM(assets) + SUM(liabilities) in ledger', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'CheckingNW', 'asset');
    const creditCard = await createAccount(db, householdId, 'CreditCardNW', 'liability');
    const equity = await createAccount(db, householdId, 'OB5', 'equity');
    const groceries = await createAccount(db, householdId, 'GroceriesNW', 'expense');

    // $10K checking, $3K credit card debt
    await createEntry(db, householdId, [
      { account_id: checking, amount: 10000 },
      { account_id: equity, amount: -10000 },
    ]);
    await createEntry(db, householdId, [
      { account_id: creditCard, amount: -3000 },
      { account_id: equity, amount: 3000 },
    ]);

    // $85 grocery on credit card
    await createEntry(db, householdId, [
      { account_id: groceries, amount: 85 },
      { account_id: creditCard, amount: -85 },
    ]);

    const assetBalance = await getLedgerBalance(db, checking);      // 10000
    const liabilityBalance = await getLedgerBalance(db, creditCard); // -3085
    const netWorth = assetBalance + liabilityBalance;                // 6915

    expect(netWorth).toBe(6915);
  });
});

describe('Cross-tenant isolation', () => {
  it('accounts from different households cannot be mixed in a journal entry', async () => {
    const h1 = await createTestHousehold(db);
    const h2 = await createTestHousehold(db);

    const checking1 = await createAccount(db, h1.householdId, 'H1Checking', 'asset');
    const groceries2 = await createAccount(db, h2.householdId, 'H2Groceries', 'expense');

    // This creates the entry but the APPLICATION should prevent this
    // The DB allows it since journal_lines has no household_id
    // This test documents the gap — validation must be at the API layer
    const entryId = await createEntry(db, h1.householdId, [
      { account_id: groceries2, amount: 50 },   // wrong household!
      { account_id: checking1, amount: -50 },
    ]);

    // The entry exists — cross-tenant is NOT prevented at DB level
    // This is by design: validation is at the API layer (transactions.ts:175-183)
    const entry = await db.selectFrom('journal_entries')
      .where('id', '=', entryId)
      .selectAll()
      .executeTakeFirst();
    expect(entry).toBeDefined();
  });
});

describe('Account uniqueness', () => {
  it('prevents duplicate accounts with same name and type in a household', async () => {
    const { householdId } = await createTestHousehold(db);
    await createAccount(db, householdId, 'Uncategorized', 'expense');

    await expect(
      createAccount(db, householdId, 'Uncategorized', 'expense')
    ).rejects.toThrow(); // unique constraint violation
  });

  it('allows same name with different type', async () => {
    const { householdId } = await createTestHousehold(db);
    await createAccount(db, householdId, 'Transfers', 'expense');
    // Should not throw — different type
    await createAccount(db, householdId, 'Transfers', 'income');
  });
});
