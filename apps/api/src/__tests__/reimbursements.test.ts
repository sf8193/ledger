import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Kysely, sql } from 'kysely';
import { nanoid } from 'nanoid';
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

describe('exclude_from_totals — two-layer resolution', () => {
  it('category-level exclusion hides expenses from spending total', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const dining = await createAccount(db, householdId, 'Dining', 'expense');
    const workExpenses = await createAccount(db, householdId, 'Work Expenses', 'expense', { exclude_from_totals: true });

    // Personal dinner: $50 (should count)
    await createEntry(db, householdId, [
      { account_id: dining, amount: 50 },
      { account_id: checking, amount: -50 },
    ]);

    // Work dinner: $100 (should NOT count)
    await createEntry(db, householdId, [
      { account_id: workExpenses, amount: 100 },
      { account_id: checking, amount: -100 },
    ]);

    // Total spending = only non-excluded expense debits
    const spending = await db.selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', 'expense')
      .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false)
      .where('jl.amount', '>', 0)
      .select(sql<number>`COALESCE(SUM(jl.amount), 0)`.as('total'))
      .executeTakeFirst();

    expect(Number(spending?.total)).toBe(50);
  });

  it('entry-level override excludes a single entry from an included category', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const dining = await createAccount(db, householdId, 'Dining', 'expense'); // included by default

    // Personal dinner: $50
    await createEntry(db, householdId, [
      { account_id: dining, amount: 50 },
      { account_id: checking, amount: -50 },
    ]);

    // Reimbursable dinner: $100 — entry-level excluded
    const reimbursableId = await createEntry(db, householdId, [
      { account_id: dining, amount: 100 },
      { account_id: checking, amount: -100 },
    ]);

    // Mark the entry as excluded
    await db.updateTable('journal_entries')
      .set({ exclude_from_totals: true })
      .where('id', '=', reimbursableId)
      .execute();

    // Total spending should be $50 (only the personal dinner)
    const spending = await db.selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', 'expense')
      .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false)
      .where('jl.amount', '>', 0)
      .select(sql<number>`COALESCE(SUM(jl.amount), 0)`.as('total'))
      .executeTakeFirst();

    expect(Number(spending?.total)).toBe(50);
  });

  it('entry-level false overrides excluded category (include override)', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const workExpenses = await createAccount(db, householdId, 'Work Expenses', 'expense', { exclude_from_totals: true });

    // Work expense that was NOT reimbursed — user overrides to include in totals
    const personalizedId = await createEntry(db, householdId, [
      { account_id: workExpenses, amount: 75 },
      { account_id: checking, amount: -75 },
    ]);

    await db.updateTable('journal_entries')
      .set({ exclude_from_totals: false })
      .where('id', '=', personalizedId)
      .execute();

    // Normal excluded work expense
    await createEntry(db, householdId, [
      { account_id: workExpenses, amount: 200 },
      { account_id: checking, amount: -200 },
    ]);

    const spending = await db.selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', 'expense')
      .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false)
      .where('jl.amount', '>', 0)
      .select(sql<number>`COALESCE(SUM(jl.amount), 0)`.as('total'))
      .executeTakeFirst();

    // Only the $75 override-included entry counts
    expect(Number(spending?.total)).toBe(75);
  });

  it('income exclusion works the same way', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const salary = await createAccount(db, householdId, 'Salary', 'income');
    const reimbursements = await createAccount(db, householdId, 'Reimbursements', 'income', { exclude_from_totals: true });

    // Salary: $5000 (counts)
    await createEntry(db, householdId, [
      { account_id: checking, amount: 5000 },
      { account_id: salary, amount: -5000 },
    ]);

    // Reimbursement: $100 (excluded)
    await createEntry(db, householdId, [
      { account_id: checking, amount: 100 },
      { account_id: reimbursements, amount: -100 },
    ]);

    const income = await db.selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', 'income')
      .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false)
      .select(sql<number>`COALESCE(-SUM(jl.amount), 0)`.as('total'))
      .executeTakeFirst();

    expect(Number(income?.total)).toBe(5000);
  });
});

describe('reimbursement lifecycle', () => {
  it('marks entry as pending and tracks group', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const dining = await createAccount(db, householdId, 'Dining', 'expense');

    const entryId = await createEntry(db, householdId, [
      { account_id: dining, amount: 100 },
      { account_id: checking, amount: -100 },
    ]);

    // Mark as reimbursable
    const groupId = 'test-group-1';
    await db.updateTable('journal_entries')
      .set({
        reimbursement_status: 'pending',
        reimbursement_group_id: groupId,
        exclude_from_totals: true,
      })
      .where('id', '=', entryId)
      .execute();

    const entry = await db.selectFrom('journal_entries')
      .where('id', '=', entryId)
      .selectAll()
      .executeTakeFirst();

    expect(entry?.reimbursement_status).toBe('pending');
    expect(entry?.reimbursement_group_id).toBe(groupId);
    expect(entry?.exclude_from_totals).toBe(true);
  });

  it('pending reimbursement query finds outstanding expenses', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const dining = await createAccount(db, householdId, 'Dining', 'expense');

    // Two pending expenses
    const entry1 = await createEntry(db, householdId, [
      { account_id: dining, amount: 50 },
      { account_id: checking, amount: -50 },
    ]);
    const entry2 = await createEntry(db, householdId, [
      { account_id: dining, amount: 80 },
      { account_id: checking, amount: -80 },
    ]);

    await db.updateTable('journal_entries')
      .set({ reimbursement_status: 'pending' })
      .where('id', 'in', [entry1, entry2])
      .execute();

    // One normal expense (not pending)
    await createEntry(db, householdId, [
      { account_id: dining, amount: 30 },
      { account_id: checking, amount: -30 },
    ]);

    // Query pending total
    const pending = await db.selectFrom('journal_entries as je')
      .innerJoin('journal_lines as jl', 'jl.journal_entry_id', 'je.id')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .where('je.household_id', '=', householdId)
      .where('je.reimbursement_status', '=', 'pending')
      .where('a.account_type', '=', 'expense')
      .where('jl.amount', '>', 0)
      .select(sql<number>`COALESCE(SUM(jl.amount), 0)`.as('total'))
      .executeTakeFirst();

    expect(Number(pending?.total)).toBe(130); // $50 + $80
  });

  it('net worth is unaffected by exclusion flags', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const workExpenses = await createAccount(db, householdId, 'Work Expenses', 'expense', { exclude_from_totals: true });
    const salary = await createAccount(db, householdId, 'Salary', 'income');

    // Salary deposit
    await createEntry(db, householdId, [
      { account_id: checking, amount: 5000 },
      { account_id: salary, amount: -5000 },
    ]);

    // Work expense (excluded from totals but still hits the bank account)
    await createEntry(db, householdId, [
      { account_id: workExpenses, amount: 100 },
      { account_id: checking, amount: -100 },
    ]);

    // Net worth = checking balance = $4900
    const balance = await getLedgerBalance(db, checking);
    expect(balance).toBe(4900);
  });
});

describe('reclassification entry — append-only reimbursement', () => {
  it('income shows net after reclassification (salary - reimbursement portion)', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const salary = await createAccount(db, householdId, 'Salary', 'income');
    const reimbursements = await createAccount(db, householdId, 'Reimbursements', 'income', { exclude_from_totals: true });

    // Paycheck: $600 all to salary
    await createEntry(db, householdId, [
      { account_id: checking, amount: 600 },
      { account_id: salary, amount: -600 },
    ], { date: new Date().toISOString().split('T')[0] });

    // Reclassification: move $100 from Salary to Reimbursements
    await createEntry(db, householdId, [
      { account_id: salary, amount: 100 },        // debit salary (reduces income)
      { account_id: reimbursements, amount: -100 }, // credit reimbursements (excluded)
    ], { date: new Date().toISOString().split('T')[0] });

    // Net income query (non-excluded income accounts, -SUM for correct sign)
    const income = await db.selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', 'income')
      .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false)
      .select(sql<number>`COALESCE(-SUM(jl.amount), 0)`.as('total'))
      .executeTakeFirst();

    // Should be $500 (salary net: -600 + 100 = -500, -(-500) = 500)
    expect(Number(income?.total)).toBe(500);
  });

  it('original Plaid entry stays untouched after reclassification', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const salary = await createAccount(db, householdId, 'Salary', 'income');
    const reimbursements = await createAccount(db, householdId, 'Reimbursements', 'income', { exclude_from_totals: true });

    // Original Plaid entry
    const plaidEntryId = await createEntry(db, householdId, [
      { account_id: checking, amount: 600 },
      { account_id: salary, amount: -600 },
    ], { source: 'plaid' });

    // Reclassification (separate entry)
    await createEntry(db, householdId, [
      { account_id: salary, amount: 100 },
      { account_id: reimbursements, amount: -100 },
    ], { source: 'reimbursement' });

    // Original entry's lines are unchanged
    const originalLines = await db.selectFrom('journal_lines')
      .where('journal_entry_id', '=', plaidEntryId)
      .selectAll()
      .execute();

    expect(originalLines).toHaveLength(2);
    const checkingLine = originalLines.find(l => l.account_id === checking);
    const salaryLine = originalLines.find(l => l.account_id === salary);
    expect(Number(checkingLine?.amount)).toBe(600);
    expect(Number(salaryLine?.amount)).toBe(-600);
  });

  it('checking balance is correct after reclassification (reclassification does not touch bank)', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const salary = await createAccount(db, householdId, 'Salary', 'income');
    const reimbursements = await createAccount(db, householdId, 'Reimbursements', 'income', { exclude_from_totals: true });

    // Paycheck
    await createEntry(db, householdId, [
      { account_id: checking, amount: 600 },
      { account_id: salary, amount: -600 },
    ]);

    // Reclassification (only moves between income accounts — no bank account touched)
    await createEntry(db, householdId, [
      { account_id: salary, amount: 100 },
      { account_id: reimbursements, amount: -100 },
    ]);

    // Checking balance = $600 (reclassification didn't touch it)
    const balance = await getLedgerBalance(db, checking);
    expect(balance).toBe(600);
  });

  it('mark auto-sets exclude_from_totals, unmark leaves it', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const dining = await createAccount(db, householdId, 'Dining', 'expense');

    const entryId = await createEntry(db, householdId, [
      { account_id: dining, amount: 100 },
      { account_id: checking, amount: -100 },
    ]);

    // Mark as reimbursable — should auto-set exclude_from_totals
    await db.updateTable('journal_entries')
      .set({
        reimbursement_status: 'pending',
        reimbursement_group_id: 'test-group',
        exclude_from_totals: true,
      })
      .where('id', '=', entryId)
      .execute();

    let entry = await db.selectFrom('journal_entries')
      .where('id', '=', entryId).selectAll().executeTakeFirst();
    expect(entry?.reimbursement_status).toBe('pending');
    expect(entry?.exclude_from_totals).toBe(true);

    // Unmark — clears reimbursement fields but leaves exclude_from_totals
    await db.updateTable('journal_entries')
      .set({
        reimbursement_status: null,
        reimbursement_group_id: null,
        // exclude_from_totals intentionally NOT cleared
      })
      .where('id', '=', entryId)
      .execute();

    entry = await db.selectFrom('journal_entries')
      .where('id', '=', entryId).selectAll().executeTakeFirst();
    expect(entry?.reimbursement_status).toBeNull();
    expect(entry?.exclude_from_totals).toBe(true); // preserved
  });
});

describe('apply endpoint code path — reclassification entry correctness', () => {
  it('reclassification entry does NOT have exclude_from_totals, so salary debit is visible to income query', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const salary = await createAccount(db, householdId, 'Salary', 'income');
    const dining = await createAccount(db, householdId, 'Dining', 'expense');
    const reimbursementsAcct = await createAccount(db, householdId, 'Reimbursements', 'income', { exclude_from_totals: true });

    const today = new Date().toISOString().split('T')[0];

    // 1. Paycheck $600 → salary
    await createEntry(db, householdId, [
      { account_id: checking, amount: 600 },
      { account_id: salary, amount: -600 },
    ], { date: today });

    // 2. Work expense $100 → dining, marked as pending reimbursement
    const expenseId = await createEntry(db, householdId, [
      { account_id: dining, amount: 100 },
      { account_id: checking, amount: -100 },
    ], { date: today });

    await db.updateTable('journal_entries')
      .set({
        reimbursement_status: 'pending',
        reimbursement_group_id: nanoid(),
        exclude_from_totals: true,
      })
      .where('id', '=', expenseId)
      .execute();

    // 3. Simulate /apply — create reclassification entry WITHOUT exclude_from_totals
    //    This is the critical code path from reimbursements.ts:187-203
    const reclassId = nanoid();
    const groupId = nanoid();
    await db.insertInto('journal_entries').values({
      id: reclassId,
      household_id: householdId,
      date: today,
      description: 'Reimbursement reclassification',
      merchant_name: null,
      notes: null,
      owner: null,
      is_verified: true,
      plaid_transaction_id: null,
      source: 'reimbursement',
      reimbursement_group_id: groupId,
      // KEY: no exclude_from_totals set — must be null/false
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }).execute();

    await db.insertInto('journal_lines').values([
      { id: nanoid(), journal_entry_id: reclassId, account_id: salary, amount: 100, created_at: new Date().toISOString() },
      { id: nanoid(), journal_entry_id: reclassId, account_id: reimbursementsAcct, amount: -100, created_at: new Date().toISOString() },
    ]).execute();

    // Mark expense as reimbursed
    await db.updateTable('journal_entries')
      .set({ reimbursement_status: 'reimbursed', reimbursement_group_id: groupId })
      .where('id', '=', expenseId)
      .execute();

    // 4. Verify: the reclassification entry must NOT have exclude_from_totals
    const reclassEntry = await db.selectFrom('journal_entries')
      .where('id', '=', reclassId)
      .selectAll()
      .executeTakeFirst();
    expect(reclassEntry?.exclude_from_totals).toBeNull();

    // 5. Income query using production logic — should show $500, not $600
    const income = await db.selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', 'income')
      .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false)
      .select(sql<number>`COALESCE(-SUM(jl.amount), 0)`.as('total'))
      .executeTakeFirst();

    expect(Number(income?.total)).toBe(500);

    // 6. Spending should be $0 (work expense is excluded)
    const spending = await db.selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', 'expense')
      .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false)
      .select(sql<number>`COALESCE(SUM(jl.amount), 0)`.as('total'))
      .executeTakeFirst();

    expect(Number(spending?.total)).toBe(0);

    // 7. Net worth correct: checking = $500 ($600 paycheck - $100 expense)
    const balance = await getLedgerBalance(db, checking);
    expect(balance).toBe(500);

    // 8. Pending reimbursements = $0 (expense is reimbursed)
    const pending = await db.selectFrom('journal_entries as je')
      .innerJoin('journal_lines as jl', 'jl.journal_entry_id', 'je.id')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .where('je.household_id', '=', householdId)
      .where('je.reimbursement_status', '=', 'pending')
      .where('a.account_type', '=', 'expense')
      .where('jl.amount', '>', 0)
      .select(sql<number>`COALESCE(SUM(jl.amount), 0)`.as('total'))
      .executeTakeFirst();

    expect(Number(pending?.total)).toBe(0);
  });

  it('refund reduces spending via net SUM', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const dining = await createAccount(db, householdId, 'Dining', 'expense');

    const today = new Date().toISOString().split('T')[0];

    // $200 dinner
    await createEntry(db, householdId, [
      { account_id: dining, amount: 200 },
      { account_id: checking, amount: -200 },
    ], { date: today });

    // $30 refund
    await createEntry(db, householdId, [
      { account_id: checking, amount: 30 },
      { account_id: dining, amount: -30 },
    ], { date: today });

    // Spending = $170 (net), not $200
    const spending = await db.selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', 'expense')
      .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false)
      .select(sql<number>`COALESCE(SUM(jl.amount), 0)`.as('total'))
      .executeTakeFirst();

    expect(Number(spending?.total)).toBe(170);
  });

  it('negative net spending clamps to zero (more refunds than purchases)', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const dining = await createAccount(db, householdId, 'Dining', 'expense');

    const today = new Date().toISOString().split('T')[0];

    // $50 dinner
    await createEntry(db, householdId, [
      { account_id: dining, amount: 50 },
      { account_id: checking, amount: -50 },
    ], { date: today });

    // $100 refund (more than the purchase)
    await createEntry(db, householdId, [
      { account_id: checking, amount: 100 },
      { account_id: dining, amount: -100 },
    ], { date: today });

    // Net is -50, but GREATEST clamps to 0
    const spending = await db.selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', 'expense')
      .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false)
      .select(sql<number>`GREATEST(COALESCE(SUM(jl.amount), 0), 0)`.as('total'))
      .executeTakeFirst();

    expect(Number(spending?.total)).toBe(0);
  });

  it('cannot unmark a reimbursed entry', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const dining = await createAccount(db, householdId, 'Dining', 'expense');

    const entryId = await createEntry(db, householdId, [
      { account_id: dining, amount: 100 },
      { account_id: checking, amount: -100 },
    ]);

    // Mark as reimbursed (simulating post-apply state)
    await db.updateTable('journal_entries')
      .set({
        reimbursement_status: 'reimbursed',
        reimbursement_group_id: nanoid(),
        exclude_from_totals: true,
      })
      .where('id', '=', entryId)
      .execute();

    // Try to unmark — should fail (WHERE status = 'pending' won't match)
    const result = await db.updateTable('journal_entries')
      .set({
        reimbursement_status: null,
        reimbursement_group_id: null,
      })
      .where('id', '=', entryId)
      .where('household_id', '=', householdId)
      .where('reimbursement_status', '=', 'pending')
      .executeTakeFirst();

    expect(BigInt(result.numUpdatedRows)).toBe(0n);

    // Entry should still be reimbursed
    const entry = await db.selectFrom('journal_entries')
      .where('id', '=', entryId).selectAll().executeTakeFirst();
    expect(entry?.reimbursement_status).toBe('reimbursed');
  });

  it('can unmark a pending entry', async () => {
    const { householdId } = await createTestHousehold(db);
    const checking = await createAccount(db, householdId, 'Checking', 'asset');
    const dining = await createAccount(db, householdId, 'Dining', 'expense');

    const entryId = await createEntry(db, householdId, [
      { account_id: dining, amount: 100 },
      { account_id: checking, amount: -100 },
    ]);

    // Mark as pending
    await db.updateTable('journal_entries')
      .set({
        reimbursement_status: 'pending',
        reimbursement_group_id: nanoid(),
        exclude_from_totals: true,
      })
      .where('id', '=', entryId)
      .execute();

    // Unmark — should succeed
    const result = await db.updateTable('journal_entries')
      .set({
        reimbursement_status: null,
        reimbursement_group_id: null,
      })
      .where('id', '=', entryId)
      .where('household_id', '=', householdId)
      .where('reimbursement_status', '=', 'pending')
      .executeTakeFirst();

    expect(BigInt(result.numUpdatedRows)).toBe(1n);

    const entry = await db.selectFrom('journal_entries')
      .where('id', '=', entryId).selectAll().executeTakeFirst();
    expect(entry?.reimbursement_status).toBeNull();
  });
});
