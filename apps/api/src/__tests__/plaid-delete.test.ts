import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Kysely } from 'kysely';
import { Database } from '../db/types';
import { nanoid } from 'nanoid';
import {
  setupTestDb, teardownTestDb, createTestHousehold,
  createAccount, createEntry,
} from './setup';

let db: Kysely<Database>;

beforeAll(async () => {
  db = await setupTestDb();
}, 30000);

afterAll(async () => {
  await teardownTestDb();
});

// Replicate the delete logic from plaid.ts
async function deletePlaidItem(tx: Kysely<Database>, itemId: string, householdId: string) {
  const linkedAccountIds = (await tx.selectFrom('accounts')
    .where('plaid_item_id', '=', itemId)
    .select('id')
    .execute()).map(a => a.id);

  if (linkedAccountIds.length > 0) {
    await tx.deleteFrom('pending_transactions')
      .where('account_id', 'in', linkedAccountIds)
      .execute();

    const plaidEntryIds = (await tx.selectFrom('journal_lines')
      .innerJoin('journal_entries', 'journal_entries.id', 'journal_lines.journal_entry_id')
      .where('journal_lines.account_id', 'in', linkedAccountIds)
      .where('journal_entries.source', 'in', ['plaid', 'plaid_opening_balance', 'plaid_reconciliation', 'plaid_removed'])
      .select('journal_lines.journal_entry_id')
      .distinct()
      .execute()).map(r => r.journal_entry_id);

    if (plaidEntryIds.length > 0) {
      await tx.deleteFrom('journal_lines')
        .where('journal_entry_id', 'in', plaidEntryIds)
        .execute();

      await tx.deleteFrom('journal_entries')
        .where('id', 'in', plaidEntryIds)
        .execute();
    }

    const accountsWithManualLines = new Set(
      (await tx.selectFrom('journal_lines')
        .where('account_id', 'in', linkedAccountIds)
        .select('account_id')
        .distinct()
        .execute()).map(r => r.account_id)
    );

    const deletableAccountIds = linkedAccountIds.filter(id => !accountsWithManualLines.has(id));
    const unlinkAccountIds = linkedAccountIds.filter(id => accountsWithManualLines.has(id));

    if (deletableAccountIds.length > 0) {
      await tx.deleteFrom('accounts')
        .where('id', 'in', deletableAccountIds)
        .execute();
    }

    if (unlinkAccountIds.length > 0) {
      await tx.updateTable('accounts')
        .set({ plaid_item_id: null, plaid_account_id: null })
        .where('id', 'in', unlinkAccountIds)
        .execute();
    }
  }

  await tx.deleteFrom('plaid_items')
    .where('id', '=', itemId)
    .execute();
}

async function createPlaidItem(householdId: string) {
  const itemId = nanoid();
  await db.insertInto('plaid_items').values({
    id: itemId,
    household_id: householdId,
    institution_id: 'ins_test',
    institution_name: 'Test Bank',
    access_token_encrypted: 'encrypted_test',
    item_id: 'plaid_item_test_' + nanoid(6),
    cursor: null,
    last_synced: null,
    status: 'active',
    logo: null,
    primary_color: null,
    created_at: new Date().toISOString(),
  }).execute();
  return itemId;
}

async function createPlaidAccount(householdId: string, itemId: string, name: string) {
  const id = nanoid();
  await db.insertInto('accounts').values({
    id,
    household_id: householdId,
    name,
    account_type: 'liability',
    plaid_item_id: itemId,
    plaid_account_id: 'plaid_acct_' + nanoid(6),
    institution_name: 'Test Bank',
    mask: '1234',
    subtype: 'credit card',
    is_hidden: false,
    icon: null, color: null, parent_id: null, sort_order: 0,
    is_manual: false, owner: null,
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  }).execute();
  return id;
}

describe('Plaid item delete', () => {
  it('deletes accounts and Plaid entries when no manual data exists', async () => {
    const { householdId } = await createTestHousehold(db);
    const itemId = await createPlaidItem(householdId);
    const ccId = await createPlaidAccount(householdId, itemId, 'Test CC');
    const equity = await createAccount(db, householdId, 'Equity-del1', 'equity');

    // Create a Plaid-sourced entry
    await createEntry(db, householdId, [
      { account_id: ccId, amount: -50 },
      { account_id: equity, amount: 50 },
    ], { source: 'plaid' });

    await db.transaction().execute(tx => deletePlaidItem(tx, itemId, householdId));

    // Account should be fully deleted
    const accounts = await db.selectFrom('accounts').where('id', '=', ccId).execute();
    expect(accounts).toHaveLength(0);

    // Plaid item should be gone
    const items = await db.selectFrom('plaid_items').where('id', '=', itemId).execute();
    expect(items).toHaveLength(0);

    // Journal entries should be deleted
    const entries = await db.selectFrom('journal_entries')
      .where('household_id', '=', householdId)
      .where('source', '=', 'plaid')
      .execute();
    expect(entries).toHaveLength(0);
  });

  it('preserves accounts with manual entries, unlinks them', async () => {
    const { householdId } = await createTestHousehold(db);
    const itemId = await createPlaidItem(householdId);
    const ccId = await createPlaidAccount(householdId, itemId, 'CC with manual');
    const expense = await createAccount(db, householdId, 'Food-del2', 'expense');
    const equity = await createAccount(db, householdId, 'Equity-del2', 'equity');

    // Plaid-sourced entry (should be deleted)
    await createEntry(db, householdId, [
      { account_id: ccId, amount: -100 },
      { account_id: equity, amount: 100 },
    ], { source: 'plaid_opening_balance' });

    // Manual entry touching the CC account (should be preserved)
    const manualEntryId = await createEntry(db, householdId, [
      { account_id: expense, amount: 25 },
      { account_id: ccId, amount: -25 },
    ], { source: 'manual' });

    await db.transaction().execute(tx => deletePlaidItem(tx, itemId, householdId));

    // Account should still exist but be unlinked
    const account = await db.selectFrom('accounts').where('id', '=', ccId).selectAll().executeTakeFirst();
    expect(account).toBeDefined();
    expect(account!.plaid_item_id).toBeNull();
    expect(account!.plaid_account_id).toBeNull();

    // Manual entry should still exist with both lines intact
    const manualLines = await db.selectFrom('journal_lines')
      .where('journal_entry_id', '=', manualEntryId)
      .execute();
    expect(manualLines).toHaveLength(2);

    // Plaid entry should be gone
    const plaidEntries = await db.selectFrom('journal_entries')
      .where('household_id', '=', householdId)
      .where('source', '=', 'plaid_opening_balance')
      .execute();
    expect(plaidEntries).toHaveLength(0);
  });

  it('handles mixed: some accounts deletable, some with manual entries', async () => {
    const { householdId } = await createTestHousehold(db);
    const itemId = await createPlaidItem(householdId);
    const cc1 = await createPlaidAccount(householdId, itemId, 'CC deletable');
    const cc2 = await createPlaidAccount(householdId, itemId, 'CC with manual data');
    const expense = await createAccount(db, householdId, 'Food-del3', 'expense');
    const equity = await createAccount(db, householdId, 'Equity-del3', 'equity');

    // CC1: only Plaid data
    await createEntry(db, householdId, [
      { account_id: cc1, amount: -30 },
      { account_id: equity, amount: 30 },
    ], { source: 'plaid' });

    // CC2: Plaid + manual data
    await createEntry(db, householdId, [
      { account_id: cc2, amount: -60 },
      { account_id: equity, amount: 60 },
    ], { source: 'plaid' });

    await createEntry(db, householdId, [
      { account_id: expense, amount: 15 },
      { account_id: cc2, amount: -15 },
    ], { source: 'manual' });

    await db.transaction().execute(tx => deletePlaidItem(tx, itemId, householdId));

    // CC1 should be fully deleted
    const cc1Row = await db.selectFrom('accounts').where('id', '=', cc1).execute();
    expect(cc1Row).toHaveLength(0);

    // CC2 should be unlinked but preserved
    const cc2Row = await db.selectFrom('accounts').where('id', '=', cc2).selectAll().executeTakeFirst();
    expect(cc2Row).toBeDefined();
    expect(cc2Row!.plaid_item_id).toBeNull();

    // Item should be gone
    const items = await db.selectFrom('plaid_items').where('id', '=', itemId).execute();
    expect(items).toHaveLength(0);
  });

  it('deletes plaid_removed entries', async () => {
    const { householdId } = await createTestHousehold(db);
    const itemId = await createPlaidItem(householdId);
    const ccId = await createPlaidAccount(householdId, itemId, 'CC removed test');
    const equity = await createAccount(db, householdId, 'Equity-del4', 'equity');

    await createEntry(db, householdId, [
      { account_id: ccId, amount: -20 },
      { account_id: equity, amount: 20 },
    ], { source: 'plaid_removed' });

    await db.transaction().execute(tx => deletePlaidItem(tx, itemId, householdId));

    const accounts = await db.selectFrom('accounts').where('id', '=', ccId).execute();
    expect(accounts).toHaveLength(0);

    const entries = await db.selectFrom('journal_entries')
      .where('household_id', '=', householdId)
      .where('source', '=', 'plaid_removed')
      .execute();
    expect(entries).toHaveLength(0);
  });
});
