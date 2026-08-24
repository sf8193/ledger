import { Router, type Router as RouterType } from 'express';
import { db } from '../db/kysely';
import { sql } from 'kysely';
import { nanoid } from 'nanoid';
import { asyncHandler } from '../middleware/error';
import { z } from 'zod';
import { getSpendingByCategory, getCumulativeSpendingBefore } from '../lib/spending';

export const budgetsRouter: RouterType = Router();

const upsertBudgetSchema = z.object({
  category_id: z.string().min(1),
  monthly_amount: z.number().positive(),
  priority: z.number().int().min(0).default(0),
  rollover_cap: z.number().positive().nullable().optional(),
});

const updateBudgetSchema = z.object({
  monthly_amount: z.number().positive().optional(),
  priority: z.number().int().min(0).optional(),
  rollover_cap: z.number().positive().nullable().optional(),
});

const allocateSchema = z.object({
  category_id: z.string().min(1),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  assigned: z.number().min(0),
});

const moveMoneySchema = z.object({
  from_category_id: z.string().min(1),
  to_category_id: z.string().min(1),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  amount: z.number().positive(),
});

// --- Helpers ---

// Spending queries use shared helpers from lib/spending.ts
// This ensures budget, dashboard, and reports all use identical
// filtering logic (exclude_from_totals, account_type, date windowing).

async function getMonthIncome(householdId: string, month: string): Promise<number> {
  const result = await db
    .selectFrom('journal_lines as jl')
    .innerJoin('accounts as a', 'a.id', 'jl.account_id')
    .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
    .where('a.household_id', '=', householdId)
    .where('a.account_type', '=', 'income')
    .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false)
    .where(sql`TO_CHAR(je.date, 'YYYY-MM')`, '=', month)
    .select(sql<number>`COALESCE(-SUM(jl.amount), 0)`.as('total'))
    .executeTakeFirst();
  return Number(result?.total) || 0;
}

async function getAllocation(householdId: string, categoryId: string, month: string): Promise<number> {
  const row = await db.selectFrom('budget_allocations')
    .where('household_id', '=', householdId)
    .where('category_id', '=', categoryId)
    .where('month', '=', month)
    .select('assigned')
    .executeTakeFirst();
  return row ? Number(row.assigned) : 0;
}

async function upsertAllocation(householdId: string, categoryId: string, month: string, assigned: number) {
  const now = new Date().toISOString();
  await db
    .insertInto('budget_allocations')
    .values({
      id: nanoid(), household_id: householdId, category_id: categoryId,
      month, assigned, created_at: now, updated_at: now,
    })
    .onConflict(oc =>
      oc.columns(['household_id', 'category_id', 'month']).doUpdateSet({
        assigned, updated_at: now,
      })
    )
    .execute();
}

// --- GET / — Envelope budgets with spending + rollover ---

budgetsRouter.get('/', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;
  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);

  const budgets = await db
    .selectFrom('budgets as b')
    .innerJoin('accounts as a', 'a.id', 'b.category_id')
    .where('b.household_id', '=', householdId)
    .select([
      'b.id', 'b.category_id', 'b.monthly_amount', 'b.priority', 'b.rollover_cap',
      'a.name as category_name', 'a.icon', 'a.color',
    ])
    .orderBy('b.priority', 'asc')
    .orderBy('a.name', 'asc')
    .execute();

  const [spending, allocations, cumAllocations, cumSpending] = await Promise.all([
    getSpendingByCategory(householdId, month),
    db.selectFrom('budget_allocations')
      .where('household_id', '=', householdId)
      .where('month', '=', month)
      .select(['category_id', 'assigned'])
      .execute(),
    db.selectFrom('budget_allocations')
      .where('household_id', '=', householdId)
      .where('month', '<', month)
      .groupBy('category_id')
      .select([
        'category_id',
        sql<number>`COALESCE(SUM(assigned), 0)`.as('total_assigned'),
      ])
      .execute(),
    getCumulativeSpendingBefore(householdId, month),
  ]);

  const spendingMap = new Map(spending.map(s => [s.category_id, Number(s.spent)]));
  const allocMap = new Map(allocations.map(a => [a.category_id, Number(a.assigned)]));
  const cumAllocMap = new Map(cumAllocations.map(a => [a.category_id, Number(a.total_assigned)]));
  const cumSpentMap = new Map(cumSpending.map(s => [s.category_id, Number(s.spent)]));

  const monthIncome = await getMonthIncome(householdId, month);
  const totalAssignedThisMonth = allocations.reduce((s, a) => s + Number(a.assigned), 0);

  const household = await db.selectFrom('households')
    .where('id', '=', householdId)
    .select('surplus_category_id')
    .executeTakeFirst();

  res.json({
    month,
    readyToAssign: monthIncome - totalAssignedThisMonth,
    monthIncome,
    surplusCategoryId: household?.surplus_category_id ?? null,
    budgets: budgets.map(b => {
      const assigned = allocMap.get(b.category_id) ?? 0;
      const spent = spendingMap.get(b.category_id) ?? 0;
      const priorAssigned = cumAllocMap.get(b.category_id) ?? 0;
      const priorSpent = cumSpentMap.get(b.category_id) ?? 0;
      let rollover = priorAssigned - priorSpent;

      if (b.rollover_cap !== null && rollover > Number(b.rollover_cap)) {
        rollover = Number(b.rollover_cap);
      }

      return {
        id: b.id,
        categoryId: b.category_id,
        categoryName: b.category_name,
        icon: b.icon,
        color: b.color,
        monthlyAmount: Number(b.monthly_amount),
        priority: b.priority,
        rolloverCap: b.rollover_cap !== null ? Number(b.rollover_cap) : null,
        assigned,
        spent,
        rollover,
        available: rollover + assigned - spent,
      };
    }),
  });
}));

// --- CRUD ---

budgetsRouter.post('/', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;
  const data = upsertBudgetSchema.parse(req.body);

  const category = await db
    .selectFrom('accounts')
    .where('id', '=', data.category_id)
    .where('household_id', '=', householdId)
    .where('account_type', '=', 'expense')
    .select('id')
    .executeTakeFirst();

  if (!category) {
    return res.status(404).json({ error: 'Expense category not found' });
  }

  const now = new Date().toISOString();
  await db
    .insertInto('budgets')
    .values({
      id: nanoid(), household_id: householdId, category_id: data.category_id,
      monthly_amount: data.monthly_amount, priority: data.priority,
      rollover_cap: data.rollover_cap ?? null, created_at: now, updated_at: now,
    })
    .onConflict(oc =>
      oc.columns(['household_id', 'category_id']).doUpdateSet({
        monthly_amount: data.monthly_amount, priority: data.priority,
        rollover_cap: data.rollover_cap ?? null, updated_at: now,
      })
    )
    .execute();

  const budget = await db.selectFrom('budgets')
    .where('household_id', '=', householdId)
    .where('category_id', '=', data.category_id)
    .selectAll()
    .executeTakeFirstOrThrow();

  res.json({
    id: budget.id, categoryId: budget.category_id,
    monthlyAmount: Number(budget.monthly_amount),
    priority: budget.priority,
    rolloverCap: budget.rollover_cap !== null ? Number(budget.rollover_cap) : null,
  });
}));

budgetsRouter.put('/:id', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;
  const data = updateBudgetSchema.parse(req.body);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (data.monthly_amount !== undefined) updates.monthly_amount = data.monthly_amount;
  if (data.priority !== undefined) updates.priority = data.priority;
  if (data.rollover_cap !== undefined) updates.rollover_cap = data.rollover_cap;

  const updated = await db.updateTable('budgets')
    .set(updates)
    .where('id', '=', req.params.id)
    .where('household_id', '=', householdId)
    .returningAll()
    .executeTakeFirst();

  if (!updated) return res.status(404).json({ error: 'Budget not found' });

  res.json({
    id: updated.id, categoryId: updated.category_id,
    monthlyAmount: Number(updated.monthly_amount),
    priority: updated.priority,
    rolloverCap: updated.rollover_cap !== null ? Number(updated.rollover_cap) : null,
  });
}));

budgetsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const deleted = await db.deleteFrom('budgets')
    .where('id', '=', req.params.id)
    .where('household_id', '=', req.householdId!)
    .executeTakeFirst();

  if (Number(deleted.numDeletedRows) === 0) return res.status(404).json({ error: 'Budget not found' });
  res.json({ ok: true });
}));

// --- Assign money to an envelope ---

budgetsRouter.post('/allocate', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;
  const data = allocateSchema.parse(req.body);

  const budget = await db.selectFrom('budgets')
    .where('household_id', '=', householdId)
    .where('category_id', '=', data.category_id)
    .select('id')
    .executeTakeFirst();

  if (!budget) return res.status(404).json({ error: 'No budget for this category' });

  await upsertAllocation(householdId, data.category_id, data.month, data.assigned);
  res.json({ ok: true, categoryId: data.category_id, month: data.month, assigned: data.assigned });
}));

// --- Move money between envelopes ---
// Takes from one category's allocation and adds to another for the same month.

budgetsRouter.post('/move', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;
  const data = moveMoneySchema.parse(req.body);

  if (data.from_category_id === data.to_category_id) {
    return res.status(400).json({ error: 'Cannot move money to the same category' });
  }

  // Validate both categories have budgets in this household
  const [fromBudget, toBudget] = await Promise.all([
    db.selectFrom('budgets').where('household_id', '=', householdId).where('category_id', '=', data.from_category_id).select('id').executeTakeFirst(),
    db.selectFrom('budgets').where('household_id', '=', householdId).where('category_id', '=', data.to_category_id).select('id').executeTakeFirst(),
  ]);

  if (!fromBudget || !toBudget) {
    return res.status(404).json({ error: 'Both categories must have budgets' });
  }

  // Get current allocations
  const [fromAlloc, toAlloc] = await Promise.all([
    getAllocation(householdId, data.from_category_id, data.month),
    getAllocation(householdId, data.to_category_id, data.month),
  ]);

  const newFrom = fromAlloc - data.amount;
  if (newFrom < 0) {
    return res.status(400).json({ error: 'Insufficient funds in source category', available: fromAlloc });
  }

  // Update both allocations atomically
  await db.transaction().execute(async (trx) => {
    const now = new Date().toISOString();

    await trx.insertInto('budget_allocations')
      .values({ id: nanoid(), household_id: householdId, category_id: data.from_category_id, month: data.month, assigned: newFrom, created_at: now, updated_at: now })
      .onConflict(oc => oc.columns(['household_id', 'category_id', 'month']).doUpdateSet({ assigned: newFrom, updated_at: now }))
      .execute();

    await trx.insertInto('budget_allocations')
      .values({ id: nanoid(), household_id: householdId, category_id: data.to_category_id, month: data.month, assigned: toAlloc + data.amount, created_at: now, updated_at: now })
      .onConflict(oc => oc.columns(['household_id', 'category_id', 'month']).doUpdateSet({ assigned: toAlloc + data.amount, updated_at: now }))
      .execute();
  });

  res.json({
    from: { categoryId: data.from_category_id, assigned: newFrom },
    to: { categoryId: data.to_category_id, assigned: toAlloc + data.amount },
    amount: data.amount,
  });
}));

// --- Auto-assign: fill envelopes in priority order ---

budgetsRouter.post('/auto-assign', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;
  const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.body);

  const monthIncome = await getMonthIncome(householdId, month);

  const existingAllocations = await db.selectFrom('budget_allocations')
    .where('household_id', '=', householdId)
    .where('month', '=', month)
    .select(['category_id', 'assigned'])
    .execute();
  const existingMap = new Map(existingAllocations.map(a => [a.category_id, Number(a.assigned)]));
  const alreadyAssigned = existingAllocations.reduce((s, a) => s + Number(a.assigned), 0);

  let remaining = monthIncome - alreadyAssigned;

  const budgets = await db.selectFrom('budgets')
    .where('household_id', '=', householdId)
    .orderBy('priority', 'asc')
    .orderBy('monthly_amount', 'asc')
    .selectAll()
    .execute();

  const assignments: Array<{ category_id: string; assigned: number }> = [];

  for (const b of budgets) {
    if (remaining <= 0) break;
    const current = existingMap.get(b.category_id) ?? 0;
    const needed = Math.max(Number(b.monthly_amount) - current, 0);
    const fill = Math.min(needed, remaining);
    if (fill > 0) {
      assignments.push({ category_id: b.category_id, assigned: current + fill });
      remaining -= fill;
    }
  }

  for (const a of assignments) {
    await upsertAllocation(householdId, a.category_id, month, a.assigned);
  }

  // Route surplus
  let surplusAssigned = 0;
  if (remaining > 0) {
    const household = await db.selectFrom('households')
      .where('id', '=', householdId)
      .select('surplus_category_id')
      .executeTakeFirst();

    if (household?.surplus_category_id) {
      const surplusBudget = await db.selectFrom('budgets')
        .where('household_id', '=', householdId)
        .where('category_id', '=', household.surplus_category_id)
        .select('id')
        .executeTakeFirst();

      if (surplusBudget) {
        const current = existingMap.get(household.surplus_category_id) ?? 0;
        surplusAssigned = remaining;
        await upsertAllocation(householdId, household.surplus_category_id, month, current + remaining);
        remaining = 0;
      }
    }
  }

  res.json({ filled: assignments.length, surplusAssigned, remaining });
}));

// --- Smart targets: suggest amounts from spending history ---

budgetsRouter.get('/suggest-targets', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;
  const lookbackMonths = Math.min(Math.max(parseInt(req.query.months as string) || 3, 1), 12);

  const rows = await db
    .selectFrom('journal_lines as jl')
    .innerJoin('accounts as a', 'a.id', 'jl.account_id')
    .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
    .where('a.household_id', '=', householdId)
    .where('a.account_type', '=', 'expense')
    .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false)
    .where('je.date', '>=', sql<Date>`DATE_TRUNC('month', CURRENT_DATE) - make_interval(months => ${lookbackMonths})`)
    .where('je.date', '<', sql<Date>`DATE_TRUNC('month', CURRENT_DATE)`)
    .groupBy(['a.id', 'a.name'])
    .having(sql`SUM(jl.amount)`, '>', 0)
    .select([
      'a.id as category_id',
      'a.name as category_name',
      sql<number>`ROUND(SUM(jl.amount) / ${lookbackMonths}, 2)`.as('avg_monthly'),
      sql<number>`COUNT(DISTINCT TO_CHAR(je.date, 'YYYY-MM'))`.as('months_active'),
    ])
    .orderBy(sql`SUM(jl.amount)`, 'desc')
    .execute();

  const existingBudgets = await db.selectFrom('budgets')
    .where('household_id', '=', householdId)
    .select(['category_id', 'monthly_amount'])
    .execute();
  const budgetMap = new Map(existingBudgets.map(b => [b.category_id, Number(b.monthly_amount)]));

  res.json({
    lookbackMonths,
    suggestions: rows.map(r => ({
      categoryId: r.category_id,
      categoryName: r.category_name,
      avgMonthly: Number(r.avg_monthly),
      monthsActive: Number(r.months_active),
      currentBudget: budgetMap.get(r.category_id) ?? null,
      suggestedAmount: Number(r.avg_monthly),
    })),
  });
}));

// --- Surplus routing config ---

budgetsRouter.put('/surplus', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;
  const { category_id } = z.object({ category_id: z.string().nullable() }).parse(req.body);

  if (category_id) {
    const cat = await db.selectFrom('accounts')
      .where('id', '=', category_id)
      .where('household_id', '=', householdId)
      .where('account_type', '=', 'expense')
      .select('id')
      .executeTakeFirst();
    if (!cat) return res.status(404).json({ error: 'Expense category not found' });
  }

  await db.updateTable('households')
    .set({ surplus_category_id: category_id })
    .where('id', '=', householdId)
    .execute();

  res.json({ surplusCategoryId: category_id });
}));
