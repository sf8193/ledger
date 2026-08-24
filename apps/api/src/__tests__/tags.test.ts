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

describe('Transaction tags', () => {
  it('creates tags and links them to entries', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const groceries = await createAccount(db, householdId, 'Groceries', 'expense');

    const entryId = await createEntry(db, householdId, [
      { account_id: groceries, amount: 50 },
      { account_id: checking, amount: -50 },
    ]);

    // Create tags
    const tag1Id = nanoid();
    const tag2Id = nanoid();
    await db.insertInto('tags').values([
      { id: tag1Id, household_id: householdId, name: 'vacation', created_at: new Date().toISOString() },
      { id: tag2Id, household_id: householdId, name: 'shared', created_at: new Date().toISOString() },
    ]).execute();

    // Link tags to entry
    await db.insertInto('journal_entry_tags').values([
      { journal_entry_id: entryId, tag_id: tag1Id },
      { journal_entry_id: entryId, tag_id: tag2Id },
    ]).execute();

    // Query tags for entry
    const tags = await db.selectFrom('journal_entry_tags as jet')
      .innerJoin('tags as t', 't.id', 'jet.tag_id')
      .where('jet.journal_entry_id', '=', entryId)
      .select(['t.id', 't.name'])
      .orderBy('t.name')
      .execute();

    expect(tags).toHaveLength(2);
    expect(tags[0].name).toBe('shared');
    expect(tags[1].name).toBe('vacation');
  });

  it('enforces unique tag names per household (case-insensitive)', async () => {
    const { householdId } = await createTestHousehold(db);

    await db.insertInto('tags').values({
      id: nanoid(), household_id: householdId, name: 'Groceries',
      created_at: new Date().toISOString(),
    }).execute();

    // Exact duplicate
    await expect(
      db.insertInto('tags').values({
        id: nanoid(), household_id: householdId, name: 'Groceries',
        created_at: new Date().toISOString(),
      }).execute()
    ).rejects.toThrow();

    // Case-different duplicate
    await expect(
      db.insertInto('tags').values({
        id: nanoid(), household_id: householdId, name: 'groceries',
        created_at: new Date().toISOString(),
      }).execute()
    ).rejects.toThrow();
  });

  it('cascades delete when entry is deleted', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const food = await createAccount(db, householdId, 'Food', 'expense');

    const entryId = await createEntry(db, householdId, [
      { account_id: food, amount: 30 },
      { account_id: checking, amount: -30 },
    ]);

    const tagId = nanoid();
    await db.insertInto('tags').values({
      id: tagId, household_id: householdId, name: 'temp',
      created_at: new Date().toISOString(),
    }).execute();

    await db.insertInto('journal_entry_tags').values({
      journal_entry_id: entryId, tag_id: tagId,
    }).execute();

    // Delete the entry — junction row should cascade
    await db.deleteFrom('journal_entries').where('id', '=', entryId).execute();

    const remaining = await db.selectFrom('journal_entry_tags')
      .where('tag_id', '=', tagId)
      .select('journal_entry_id')
      .execute();

    expect(remaining).toHaveLength(0);
  });

  it('cascades delete when tag is deleted', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const food = await createAccount(db, householdId, 'Food', 'expense');

    const entryId = await createEntry(db, householdId, [
      { account_id: food, amount: 25 },
      { account_id: checking, amount: -25 },
    ]);

    const tagId = nanoid();
    await db.insertInto('tags').values({
      id: tagId, household_id: householdId, name: 'delete-me',
      created_at: new Date().toISOString(),
    }).execute();

    await db.insertInto('journal_entry_tags').values({
      journal_entry_id: entryId, tag_id: tagId,
    }).execute();

    // Delete the tag — junction row should cascade
    await db.deleteFrom('tags').where('id', '=', tagId).execute();

    const remaining = await db.selectFrom('journal_entry_tags')
      .where('journal_entry_id', '=', entryId)
      .select('tag_id')
      .execute();

    expect(remaining).toHaveLength(0);
  });

  it('allows same tag name in different households', async () => {
    const { householdId: h1 } = await createTestHousehold(db);
    const { householdId: h2 } = await createTestHousehold(db);

    await db.insertInto('tags').values({
      id: nanoid(), household_id: h1, name: 'cross-household',
      created_at: new Date().toISOString(),
    }).execute();

    // Should not throw — different household
    await db.insertInto('tags').values({
      id: nanoid(), household_id: h2, name: 'cross-household',
      created_at: new Date().toISOString(),
    }).execute();
  });
});
