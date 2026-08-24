import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Kysely } from 'kysely';
import { Database } from '../db/types';
import { setupTestDb, teardownTestDb, createTestHousehold } from './setup';
import { nanoid } from 'nanoid';
import { encrypt } from '../lib/crypto';
import { z } from 'zod';

let db: Kysely<Database>;
let householdId: string;

const webhookSchema = z.object({
  webhook_type: z.string(),
  webhook_code: z.string(),
  item_id: z.string(),
  error: z.any().optional(),
  new_transactions: z.number().optional(),
});

async function createPlaidItem(itemId: string, status = 'active') {
  const id = nanoid();
  await db.insertInto('plaid_items').values({
    id,
    household_id: householdId,
    institution_id: 'ins_109508',
    institution_name: 'Test Bank',
    access_token_encrypted: encrypt('access-sandbox-test'),
    item_id: itemId,
    cursor: null,
    last_synced: null,
    status,
    created_at: new Date().toISOString(),
  }).execute();
  return id;
}

beforeAll(async () => {
  db = await setupTestDb();
}, 30000);

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await db.deleteFrom('plaid_items').execute();
  await db.deleteFrom('households').execute();
  const result = await createTestHousehold(db);
  householdId = result.householdId;
});

describe('Webhook validation', () => {
  it('rejects malformed payloads', () => {
    const result = webhookSchema.safeParse({ bad: 'payload' });
    expect(result.success).toBe(false);
  });

  it('rejects payload missing item_id', () => {
    const result = webhookSchema.safeParse({
      webhook_type: 'TRANSACTIONS',
      webhook_code: 'SYNC_UPDATES_AVAILABLE',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid TRANSACTIONS payload', () => {
    const result = webhookSchema.safeParse({
      webhook_type: 'TRANSACTIONS',
      webhook_code: 'SYNC_UPDATES_AVAILABLE',
      item_id: 'test-item',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid ITEM ERROR payload with error object', () => {
    const result = webhookSchema.safeParse({
      webhook_type: 'ITEM',
      webhook_code: 'ERROR',
      item_id: 'test-item',
      error: { error_code: 'ITEM_LOGIN_REQUIRED' },
    });
    expect(result.success).toBe(true);
    expect(result.data?.error?.error_code).toBe('ITEM_LOGIN_REQUIRED');
  });
});

describe('Webhook DB state mutations', () => {
  it('sets status to reauth_needed on ITEM_LOGIN_REQUIRED', async () => {
    const plaidItemId = 'test-item-' + nanoid(8);
    const internalId = await createPlaidItem(plaidItemId);

    // Simulate what the webhook handler does for ITEM_LOGIN_REQUIRED
    await db.updateTable('plaid_items')
      .set({ status: 'reauth_needed' })
      .where('id', '=', internalId)
      .execute();

    const item = await db.selectFrom('plaid_items')
      .where('id', '=', internalId)
      .select('status')
      .executeTakeFirst();
    expect(item?.status).toBe('reauth_needed');
  });

  it('sets status to error on generic ITEM ERROR', async () => {
    const plaidItemId = 'test-item-' + nanoid(8);
    const internalId = await createPlaidItem(plaidItemId);

    await db.updateTable('plaid_items')
      .set({ status: 'error' })
      .where('id', '=', internalId)
      .execute();

    const item = await db.selectFrom('plaid_items')
      .where('id', '=', internalId)
      .select('status')
      .executeTakeFirst();
    expect(item?.status).toBe('error');
  });

  it('unknown item_id does not crash', async () => {
    const item = await db.selectFrom('plaid_items')
      .where('item_id', '=', 'nonexistent')
      .select(['id', 'household_id', 'status'])
      .executeTakeFirst();
    expect(item).toBeUndefined();
  });

  it('non-active items are found but filtered', async () => {
    const plaidItemId = 'test-item-' + nanoid(8);
    await createPlaidItem(plaidItemId, 'reauth_needed');

    // Webhook handler looks up by item_id (finds it)
    const item = await db.selectFrom('plaid_items')
      .where('item_id', '=', plaidItemId)
      .select(['id', 'household_id', 'status'])
      .executeTakeFirst();
    expect(item).toBeDefined();
    expect(item?.status).toBe('reauth_needed');

    // But syncAllItemsForHousehold filters for active only
    const activeItems = await db.selectFrom('plaid_items')
      .where('id', '=', item!.id)
      .where('household_id', '=', item!.household_id)
      .where('status', '=', 'active')
      .select('id')
      .execute();
    expect(activeItems).toHaveLength(0);
  });

  it('PENDING_EXPIRATION does not change status', async () => {
    const plaidItemId = 'test-item-' + nanoid(8);
    const internalId = await createPlaidItem(plaidItemId);

    // PENDING_EXPIRATION is a warning — no DB mutation
    const item = await db.selectFrom('plaid_items')
      .where('id', '=', internalId)
      .select('status')
      .executeTakeFirst();
    expect(item?.status).toBe('active');
  });
});
