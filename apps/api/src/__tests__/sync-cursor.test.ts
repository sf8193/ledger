import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Kysely } from 'kysely';
import { Database } from '../db/types';
import { setupTestDb, teardownTestDb, createTestHousehold } from './setup';
import { sql } from 'kysely';
import { nanoid } from 'nanoid';
import { encrypt } from '../lib/crypto';

// We need to mock both Plaid client and the db module
const mockTransactionsSync = vi.fn();
const mockAccountsGet = vi.fn();

vi.mock('../lib/plaid', () => ({
  getPlaidClient: () => ({
    transactionsSync: mockTransactionsSync,
    accountsGet: mockAccountsGet,
  }),
}));

// Hold a reference to the test db that we'll set in beforeAll
let testDb: Kysely<Database>;

vi.mock('../db/kysely', () => ({
  get db() { return testDb; },
}));

// Import after mocks
const { syncItemTransactions } = await import('../services/sync');

let householdId: string;
let plaidItemId: string;
let checkingAccountId: string;
const PLAID_ACCOUNT_ID = 'plaid-checking-001';

function makePlaidTx(overrides: Record<string, any> = {}) {
  return {
    transaction_id: overrides.transaction_id ?? nanoid(),
    account_id: overrides.account_id ?? PLAID_ACCOUNT_ID,
    amount: overrides.amount ?? 25.00,
    date: overrides.date ?? '2026-08-01',
    name: overrides.name ?? 'Test Transaction',
    pending: overrides.pending ?? false,
    merchant_name: overrides.merchant_name ?? null,
    pending_transaction_id: overrides.pending_transaction_id ?? null,
    personal_finance_category: overrides.personal_finance_category ?? { primary: 'FOOD_AND_DRINK' },
    authorized_date: null,
    authorized_datetime: null,
    category: null,
    category_id: null,
    check_number: null,
    counterparties: [],
    datetime: null,
    iso_currency_code: 'USD',
    location: {},
    logo_url: null,
    merchant_category_code: null,
    merchant_entity_id: null,
    payment_channel: 'online',
    payment_meta: {},
    personal_finance_category_icon_url: null,
    transaction_code: null,
    transaction_type: 'place',
    unofficial_currency_code: null,
    website: null,
    account_owner: null,
  };
}

function mockSyncResponse(added: any[] = [], modified: any[] = [], removed: any[] = [], hasMore = false) {
  return {
    data: {
      added,
      modified,
      removed,
      has_more: hasMore,
      next_cursor: `cursor-${nanoid(8)}`,
    },
  };
}

async function getCursor(): Promise<string | null> {
  const item = await testDb.selectFrom('plaid_items')
    .where('id', '=', plaidItemId)
    .select('cursor')
    .executeTakeFirstOrThrow();
  return item.cursor;
}

async function getLastSynced(): Promise<string | null> {
  const item = await testDb.selectFrom('plaid_items')
    .where('id', '=', plaidItemId)
    .select('last_synced')
    .executeTakeFirstOrThrow();
  return item.last_synced as string | null;
}

async function countJournalEntries(): Promise<number> {
  const result = await testDb.selectFrom('journal_entries')
    .where('household_id', '=', householdId)
    .where('source', '=', 'plaid')
    .select(testDb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  return Number(result.count);
}

async function countPendingTransactions(): Promise<number> {
  const result = await testDb.selectFrom('pending_transactions')
    .where('household_id', '=', householdId)
    .select(testDb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  return Number(result.count);
}

beforeAll(async () => {
  testDb = await setupTestDb();
}, 30000);

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  // Clean slate — use TRUNCATE CASCADE to avoid trigger issues
  await sql`TRUNCATE journal_lines, journal_entries, pending_transactions, match_suggestions, accounts, plaid_items, households CASCADE`.execute(testDb);

  const result = await createTestHousehold(testDb);
  householdId = result.householdId;

  // Create plaid item
  plaidItemId = nanoid();
  await testDb.insertInto('plaid_items').values({
    id: plaidItemId,
    household_id: householdId,
    institution_id: 'ins_test_bank',
    institution_name: 'Test Bank',
    access_token_encrypted: encrypt('access-test'),
    item_id: 'plaid-item-id',
    cursor: null,
    last_synced: null,
    status: 'active',
    created_at: new Date().toISOString(),
  }).execute();

  // Create checking account linked to the plaid item
  checkingAccountId = nanoid();
  await testDb.insertInto('accounts').values({
    id: checkingAccountId,
    household_id: householdId,
    name: 'Checking',
    account_type: 'asset',
    plaid_item_id: plaidItemId,
    plaid_account_id: PLAID_ACCOUNT_ID,
    institution_name: 'Test Bank',
    mask: '1234',
    subtype: 'checking',
    is_hidden: false,
    icon: null,
    color: null,
    parent_id: null,
    sort_order: 0,
    is_manual: false,
    owner: null,
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  }).execute();

  // Reset mocks
  mockTransactionsSync.mockReset();
  mockAccountsGet.mockReset();

  // Default: accountsGet returns the checking account with $1000 balance
  mockAccountsGet.mockResolvedValue({
    data: {
      accounts: [{
        account_id: PLAID_ACCOUNT_ID,
        balances: { current: 1000 },
        mask: '1234',
        type: 'depository',
        subtype: 'checking',
      }],
    },
  });
});

describe('Sync cursor advancement', () => {
  it('advances cursor when all transactions match accountMap', async () => {
    const tx1 = makePlaidTx({ transaction_id: 'tx-1', amount: 50 });
    const tx2 = makePlaidTx({ transaction_id: 'tx-2', amount: 30 });
    const resp = mockSyncResponse([tx1, tx2]);

    mockTransactionsSync.mockResolvedValueOnce(resp);

    const result = await syncItemTransactions(householdId, plaidItemId);
    expect(result.added).toBe(2);

    const cursor = await getCursor();
    expect(cursor).toBe(resp.data.next_cursor);
    expect(await countJournalEntries()).toBe(2);
  });

  it('holds cursor when all transactions miss accountMap', async () => {
    const tx1 = makePlaidTx({ transaction_id: 'tx-miss-1', account_id: 'unknown-account' });
    const tx2 = makePlaidTx({ transaction_id: 'tx-miss-2', account_id: 'unknown-account' });
    const resp = mockSyncResponse([tx1, tx2]);

    mockTransactionsSync.mockResolvedValueOnce(resp);

    const result = await syncItemTransactions(householdId, plaidItemId);
    expect(result.added).toBe(0);

    // Cursor not advanced
    const cursor = await getCursor();
    expect(cursor).toBeNull();
    // But last_synced IS updated
    expect(await getLastSynced()).not.toBeNull();
    expect(await countJournalEntries()).toBe(0);
  });

  it('advances cursor when all transactions are duplicates', async () => {
    const txId = 'tx-dup-1';
    const tx = makePlaidTx({ transaction_id: txId, amount: 42 });

    // First sync — creates the journal entry
    const resp1 = mockSyncResponse([tx]);
    mockTransactionsSync.mockResolvedValueOnce(resp1);
    await syncItemTransactions(householdId, plaidItemId);
    expect(await countJournalEntries()).toBe(1);

    // Reset cursor to simulate re-delivery
    await testDb.updateTable('plaid_items')
      .set({ cursor: null })
      .where('id', '=', plaidItemId)
      .execute();

    // Second sync — same transaction replayed
    const resp2 = mockSyncResponse([tx]);
    mockTransactionsSync.mockResolvedValueOnce(resp2);
    const result = await syncItemTransactions(householdId, plaidItemId);

    expect(result.added).toBe(0); // duplicate skipped
    const cursor = await getCursor();
    expect(cursor).toBe(resp2.data.next_cursor); // cursor still advances
    expect(await countJournalEntries()).toBe(1); // no duplicate created
  });

  it('preserves pending row when bankAccountId missing on promotion', async () => {
    const txId = 'tx-pending-miss';

    // Insert a pending transaction
    await testDb.insertInto('pending_transactions').values({
      id: nanoid(),
      household_id: householdId,
      plaid_transaction_id: txId,
      plaid_account_id: 'unknown-account',
      account_id: checkingAccountId,
      date: '2026-08-01',
      name: 'Pending Payment',
      merchant_name: null,
      amount: 100,
      plaid_category: null,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }).execute();

    expect(await countPendingTransactions()).toBe(1);

    // Plaid sends as "modified" (pending→cleared) with unknown account_id
    const clearedTx = makePlaidTx({
      transaction_id: txId,
      account_id: 'unknown-account',
      amount: 100,
      pending: false,
    });
    const resp = mockSyncResponse([], [clearedTx]);
    mockTransactionsSync.mockResolvedValueOnce(resp);

    await syncItemTransactions(householdId, plaidItemId);

    // Pending row preserved — no data destruction
    expect(await countPendingTransactions()).toBe(1);
    // Cursor held
    expect(await getCursor()).toBeNull();
    // No journal entry created
    expect(await countJournalEntries()).toBe(0);
  });

  it('holds cursor when mix of writes and accountMap misses', async () => {
    const goodTx = makePlaidTx({ transaction_id: 'tx-good', amount: 50 });
    const badTx = makePlaidTx({ transaction_id: 'tx-bad', account_id: 'unknown-account', amount: 30 });
    const resp = mockSyncResponse([goodTx, badTx]);

    mockTransactionsSync.mockResolvedValueOnce(resp);

    const result = await syncItemTransactions(householdId, plaidItemId);
    expect(result.added).toBe(1); // good one written

    // Cursor held because of the miss
    expect(await getCursor()).toBeNull();
    expect(await countJournalEntries()).toBe(1);
  });
});

describe('Sync bookkeeping accounts', () => {
  it('creates Unclassified Adjustments with exclude_from_totals and is_hidden', async () => {
    const tx = makePlaidTx({ transaction_id: 'tx-adj-1', amount: 50 });
    const resp = mockSyncResponse([tx]);
    mockTransactionsSync.mockResolvedValueOnce(resp);

    // accountsGet returns a balance that differs from ledger → triggers reconciliation
    mockAccountsGet.mockResolvedValue({
      data: {
        accounts: [{
          account_id: PLAID_ACCOUNT_ID,
          balances: { current: 5000 },
          mask: '1234',
          type: 'depository',
          subtype: 'checking',
        }],
      },
    });

    await syncItemTransactions(householdId, plaidItemId);

    const adjustments = await testDb.selectFrom('accounts')
      .where('household_id', '=', householdId)
      .where('name', '=', 'Unclassified Adjustments')
      .selectAll()
      .executeTakeFirst();

    expect(adjustments).toBeTruthy();
    expect(adjustments!.exclude_from_totals).toBe(true);
    expect(adjustments!.is_hidden).toBe(true);
  });

  it('enforces flags on existing Unclassified Adjustments account', async () => {
    // Pre-create the account WITHOUT flags (simulates old behavior)
    const adjId = nanoid();
    await testDb.insertInto('accounts').values({
      id: adjId,
      household_id: householdId,
      name: 'Unclassified Adjustments',
      account_type: 'income',
      plaid_item_id: null,
      plaid_account_id: null,
      institution_name: null,
      mask: null,
      subtype: null,
      is_hidden: false,
      exclude_from_totals: false,
      icon: null,
      color: null,
      parent_id: null,
      sort_order: 0,
      is_manual: false,
      owner: null,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }).execute();

    const tx = makePlaidTx({ transaction_id: 'tx-adj-2', amount: 50 });
    mockTransactionsSync.mockResolvedValueOnce(mockSyncResponse([tx]));
    mockAccountsGet.mockResolvedValue({
      data: {
        accounts: [{
          account_id: PLAID_ACCOUNT_ID,
          balances: { current: 5000 },
          mask: '1234',
          type: 'depository',
          subtype: 'checking',
        }],
      },
    });

    await syncItemTransactions(householdId, plaidItemId);

    // Flags should be enforced even though account already existed
    const adjustments = await testDb.selectFrom('accounts')
      .where('id', '=', adjId)
      .selectAll()
      .executeTakeFirst();

    expect(adjustments!.exclude_from_totals).toBe(true);
    expect(adjustments!.is_hidden).toBe(true);
  });
});
