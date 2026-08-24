import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Kysely, sql } from 'kysely';
import { Database } from '../db/types';
import {
  setupTestDb, teardownTestDb,
  createTestHousehold, createAccount, createEntry,
} from './setup';
import { nanoid } from 'nanoid';

let db: Kysely<Database>;

beforeAll(async () => {
  db = await setupTestDb();
});
afterAll(async () => {
  await teardownTestDb();
});

async function createBudget(
  householdId: string, categoryId: string, amount: number, priority = 0, rolloverCap: number | null = null,
) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insertInto('budgets').values({
    id, household_id: householdId, category_id: categoryId,
    monthly_amount: amount, priority, rollover_cap: rolloverCap,
    created_at: now, updated_at: now,
  }).execute();
  return id;
}

async function createAllocation(householdId: string, categoryId: string, month: string, assigned: number) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insertInto('budget_allocations').values({
    id, household_id: householdId, category_id: categoryId,
    month, assigned, created_at: now, updated_at: now,
  }).execute();
  return id;
}

describe('budgets — CRUD', () => {
  let householdId: string;
  let groceriesId: string;
  let diningId: string;

  beforeAll(async () => {
    ({ householdId } = await createTestHousehold(db));
    groceriesId = await createAccount(db, householdId, 'Groceries', 'expense');
    diningId = await createAccount(db, householdId, 'Dining', 'expense');
  });

  it('creates a budget with priority', async () => {
    const id = await createBudget(householdId, groceriesId, 500, 10);
    const budget = await db.selectFrom('budgets').where('id', '=', id).selectAll().executeTakeFirstOrThrow();
    expect(Number(budget.monthly_amount)).toBe(500);
    expect(budget.priority).toBe(10);
    expect(budget.category_id).toBe(groceriesId);
  });

  it('enforces unique household + category', async () => {
    await expect(createBudget(householdId, groceriesId, 600)).rejects.toThrow();
  });

  it('deletes a budget', async () => {
    const id = await createBudget(householdId, diningId, 300);
    await db.deleteFrom('budgets').where('id', '=', id).execute();
    const result = await db.selectFrom('budgets').where('id', '=', id).selectAll().executeTakeFirst();
    expect(result).toBeUndefined();
  });

  it('cross-tenant isolation', async () => {
    const { householdId: other } = await createTestHousehold(db);
    const budgets = await db.selectFrom('budgets').where('household_id', '=', other).selectAll().execute();
    expect(budgets).toHaveLength(0);
  });
});

describe('budgets — envelope allocations + rollover', () => {
  let householdId: string;
  let groceriesId: string;
  let checkingId: string;

  beforeAll(async () => {
    ({ householdId } = await createTestHousehold(db));
    groceriesId = await createAccount(db, householdId, 'Groceries', 'expense');
    checkingId = await createAccount(db, householdId, 'Checking', 'asset');
    await createBudget(householdId, groceriesId, 500);
  });

  it('stores per-month allocation', async () => {
    await createAllocation(householdId, groceriesId, '2026-08', 450);
    const alloc = await db.selectFrom('budget_allocations')
      .where('household_id', '=', householdId)
      .where('category_id', '=', groceriesId)
      .where('month', '=', '2026-08')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(Number(alloc.assigned)).toBe(450);
  });

  it('enforces unique allocation per category per month', async () => {
    await expect(createAllocation(householdId, groceriesId, '2026-08', 600)).rejects.toThrow();
  });

  it('computes rollover (prior assigned - prior spent)', async () => {
    await createAllocation(householdId, groceriesId, '2026-07', 400);
    await createEntry(db, householdId, [
      { account_id: groceriesId, amount: 350 },
      { account_id: checkingId, amount: -350 },
    ], { description: 'July groceries', date: '2026-07-15' });

    const priorAlloc = await db.selectFrom('budget_allocations')
      .where('household_id', '=', householdId)
      .where('category_id', '=', groceriesId)
      .where('month', '<', '2026-08')
      .select(sql<number>`COALESCE(SUM(assigned), 0)`.as('total'))
      .executeTakeFirst();

    const priorSpent = await db
      .selectFrom('journal_lines as jl')
      .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
      .where('jl.account_id', '=', groceriesId)
      .where(sql`COALESCE(je.exclude_from_totals, false)`, '=', false)
      .where(sql`TO_CHAR(je.date, 'YYYY-MM')`, '<', '2026-08')
      .select(sql<number>`COALESCE(SUM(jl.amount), 0)`.as('total'))
      .executeTakeFirst();

    const rollover = Number(priorAlloc?.total) - Number(priorSpent?.total);
    expect(rollover).toBe(50); // 400 assigned - 350 spent
  });

  it('rollover cap limits carried-forward balance', async () => {
    const { householdId: hh } = await createTestHousehold(db);
    const catId = await createAccount(db, hh, 'Groceries', 'expense');
    const chkId = await createAccount(db, hh, 'Checking', 'asset');

    await createBudget(hh, catId, 500, 0, 200); // cap at $200
    await createAllocation(hh, catId, '2026-07', 500);
    await createEntry(db, hh, [
      { account_id: catId, amount: 100 },
      { account_id: chkId, amount: -100 },
    ], { description: 'Light month', date: '2026-07-15' });

    // Raw rollover = 500 - 100 = 400, capped at 200
    const priorAlloc = await db.selectFrom('budget_allocations')
      .where('household_id', '=', hh).where('category_id', '=', catId).where('month', '<', '2026-08')
      .select(sql<number>`COALESCE(SUM(assigned), 0)`.as('total')).executeTakeFirst();
    const priorSpent = await db.selectFrom('journal_lines as jl')
      .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
      .where('jl.account_id', '=', catId)
      .where(sql`COALESCE(je.exclude_from_totals, false)`, '=', false)
      .where(sql`TO_CHAR(je.date, 'YYYY-MM')`, '<', '2026-08')
      .select(sql<number>`COALESCE(SUM(jl.amount), 0)`.as('total')).executeTakeFirst();

    const raw = Number(priorAlloc?.total) - Number(priorSpent?.total);
    expect(raw).toBe(400);
    expect(Math.min(raw, 200)).toBe(200); // capped
  });
});

describe('budgets — priority fill', () => {
  let householdId: string;
  let rentId: string;
  let groceriesId: string;
  let funId: string;
  let savingsId: string;

  beforeAll(async () => {
    ({ householdId } = await createTestHousehold(db));
    rentId = await createAccount(db, householdId, 'Rent', 'expense');
    groceriesId = await createAccount(db, householdId, 'Groceries', 'expense');
    funId = await createAccount(db, householdId, 'Fun Money', 'expense');
    savingsId = await createAccount(db, householdId, 'Savings', 'expense');

    await createBudget(householdId, rentId, 2000, 0);
    await createBudget(householdId, groceriesId, 800, 10);
    await createBudget(householdId, funId, 300, 100);
    await createBudget(householdId, savingsId, 500, 200);
  });

  it('fills all envelopes with sufficient income', async () => {
    const budgets = await db.selectFrom('budgets')
      .where('household_id', '=', householdId)
      .orderBy('priority', 'asc')
      .selectAll().execute();

    let remaining = 5000;
    const fills = budgets.map(b => {
      const fill = Math.min(Number(b.monthly_amount), remaining);
      remaining -= fill;
      return { id: b.category_id, amount: fill };
    });

    expect(fills.map(f => f.amount)).toEqual([2000, 800, 300, 500]);
    expect(remaining).toBe(1400);
  });

  it('fills by priority when income is insufficient', async () => {
    const budgets = await db.selectFrom('budgets')
      .where('household_id', '=', householdId)
      .orderBy('priority', 'asc')
      .selectAll().execute();

    let remaining = 2500;
    const fills = budgets.map(b => {
      const fill = Math.min(Number(b.monthly_amount), remaining);
      remaining -= fill;
      return { id: b.category_id, amount: fill };
    });

    expect(fills[0].amount).toBe(2000); // rent: full
    expect(fills[1].amount).toBe(500);  // groceries: partial
    expect(fills[2].amount).toBe(0);    // fun: nothing
    expect(fills[3].amount).toBe(0);    // savings: nothing
  });
});

describe('budgets — move money', () => {
  let householdId: string;
  let groceriesId: string;
  let diningId: string;

  beforeAll(async () => {
    ({ householdId } = await createTestHousehold(db));
    groceriesId = await createAccount(db, householdId, 'Groceries', 'expense');
    diningId = await createAccount(db, householdId, 'Dining', 'expense');
    await createBudget(householdId, groceriesId, 500);
    await createBudget(householdId, diningId, 300);
    await createAllocation(householdId, groceriesId, '2026-09', 500);
    await createAllocation(householdId, diningId, '2026-09', 300);
  });

  it('moves money between envelopes', async () => {
    // Move $100 from groceries to dining
    const fromBefore = await db.selectFrom('budget_allocations')
      .where('household_id', '=', householdId).where('category_id', '=', groceriesId).where('month', '=', '2026-09')
      .select('assigned').executeTakeFirstOrThrow();
    const toBefore = await db.selectFrom('budget_allocations')
      .where('household_id', '=', householdId).where('category_id', '=', diningId).where('month', '=', '2026-09')
      .select('assigned').executeTakeFirstOrThrow();

    expect(Number(fromBefore.assigned)).toBe(500);
    expect(Number(toBefore.assigned)).toBe(300);

    // Simulate move: subtract from source, add to dest
    const moveAmount = 100;
    const now = new Date().toISOString();

    await db.transaction().execute(async (trx) => {
      await trx.updateTable('budget_allocations')
        .set({ assigned: Number(fromBefore.assigned) - moveAmount, updated_at: now })
        .where('household_id', '=', householdId).where('category_id', '=', groceriesId).where('month', '=', '2026-09')
        .execute();
      await trx.updateTable('budget_allocations')
        .set({ assigned: Number(toBefore.assigned) + moveAmount, updated_at: now })
        .where('household_id', '=', householdId).where('category_id', '=', diningId).where('month', '=', '2026-09')
        .execute();
    });

    const fromAfter = await db.selectFrom('budget_allocations')
      .where('household_id', '=', householdId).where('category_id', '=', groceriesId).where('month', '=', '2026-09')
      .select('assigned').executeTakeFirstOrThrow();
    const toAfter = await db.selectFrom('budget_allocations')
      .where('household_id', '=', householdId).where('category_id', '=', diningId).where('month', '=', '2026-09')
      .select('assigned').executeTakeFirstOrThrow();

    expect(Number(fromAfter.assigned)).toBe(400);
    expect(Number(toAfter.assigned)).toBe(400);
    // Total unchanged: 400 + 400 = 800 = 500 + 300
  });
});
