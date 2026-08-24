// Set env vars for tests before any imports
process.env.BASE_URL = 'http://localhost:4100';
process.env.FRONTEND_URL = 'http://localhost:5180';
process.env.BETTER_AUTH_SECRET = 'test-secret-at-least-32-characters-long';

import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Database } from '../db/types';
import { nanoid } from 'nanoid';

const TEST_DB = 'ledger_test';
const TEST_PORT = 5434;

let pool: Pool;
let db: Kysely<Database>;

export function getTestDb() {
  return db;
}

export async function setupTestDb() {
  // Connect to default DB to create test DB
  const adminPool = new Pool({
    user: 'postgres',
    password: 'postgres',
    host: 'localhost',
    port: TEST_PORT,
    database: 'postgres',
  });

  // Only create if not already set up (idempotent for multi-file test runs)
  if (!db) {
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      await adminPool.query(`CREATE DATABASE ${TEST_DB}`);
    } finally {
      await adminPool.end();
    }
  } else {
    await adminPool.end();
    return db;
  }

  // Connect to test DB
  pool = new Pool({
    user: 'postgres',
    password: 'postgres',
    host: 'localhost',
    port: TEST_PORT,
    database: TEST_DB,
  });

  db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });

  // Run migrations via raw SQL (read migration files)
  const fs = await import('fs/promises');
  const path = await import('path');
  const migrationsDir = path.join(__dirname, '../../migrations');
  const files = (await fs.readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();

  // First run better-auth migrations
  const { getMigrations } = await import('better-auth/db/migration');
  const { authOptions } = await import('../lib/auth');
  // Override the auth options to use our test pool
  const testAuthOptions = { ...authOptions, database: pool };
  const { runMigrations } = await getMigrations(testAuthOptions);
  await runMigrations();

  // Then run custom migrations
  for (const file of files) {
    const sqlContent = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    await sql.raw(sqlContent).execute(db);
  }

  return db;
}

export async function teardownTestDb() {
  // db.destroy() also ends the pool — don't double-end
  if (db) await db.destroy();
}

// Helper: create a test household with a user
export async function createTestHousehold(testDb: Kysely<Database>) {
  const householdId = nanoid();
  const userId = nanoid();

  await testDb.insertInto('households').values({
    id: householdId,
    name: 'Test Household',
    created_at: new Date().toISOString(),
  }).execute();

  return { householdId, userId };
}

// Helper: create an account
export async function createAccount(
  testDb: Kysely<Database>,
  householdId: string,
  name: string,
  type: 'asset' | 'liability' | 'income' | 'expense' | 'equity',
  opts?: { exclude_from_totals?: boolean; institution_name?: string },
) {
  const id = nanoid();
  await testDb.insertInto('accounts').values({
    id,
    household_id: householdId,
    name,
    account_type: type,
    plaid_item_id: null,
    plaid_account_id: null,
    institution_name: opts?.institution_name || null,
    mask: null,
    subtype: null,
    is_hidden: false,
    icon: null,
    color: null,
    parent_id: null,
    sort_order: 0,
    is_manual: true,
    owner: null,
    exclude_from_totals: opts?.exclude_from_totals ?? false,
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  }).execute();
  return id;
}

// Helper: create a journal entry with lines
export async function createEntry(
  testDb: Kysely<Database>,
  householdId: string,
  lines: Array<{ account_id: string; amount: number }>,
  opts?: { description?: string; merchant_name?: string; date?: string; source?: string; plaid_category?: string; plaid_transaction_id?: string },
) {
  const entryId = nanoid();
  await testDb.insertInto('journal_entries').values({
    id: entryId,
    household_id: householdId,
    date: opts?.date || '2024-01-15',
    description: opts?.description || 'Test entry',
    merchant_name: opts?.merchant_name || null,
    plaid_category: opts?.plaid_category || null,
    plaid_transaction_id: opts?.plaid_transaction_id || null,
    notes: null,
    owner: null,
    is_verified: false,
    source: opts?.source || 'test',
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  }).execute();

  await testDb.insertInto('journal_lines').values(
    lines.map(l => ({
      id: nanoid(),
      journal_entry_id: entryId,
      account_id: l.account_id,
      amount: l.amount,
      created_at: new Date().toISOString(),
    }))
  ).execute();

  return entryId;
}

// Helper: get ledger balance for an account
export async function getLedgerBalance(testDb: Kysely<Database>, accountId: string): Promise<number> {
  const result = await testDb.selectFrom('journal_lines')
    .where('account_id', '=', accountId)
    .select(sql<number>`COALESCE(SUM(amount), 0)`.as('total'))
    .executeTakeFirst();
  return Number(result?.total) || 0;
}
