import { Router, type Router as RouterType } from 'express';
import { db } from '../db/kysely';
import { sql } from 'kysely';
import { nanoid } from 'nanoid';
import { asyncHandler } from '../middleware/error';
import { z } from 'zod';

export const reimbursementsRouter: RouterType = Router();

// List pending reimbursements
reimbursementsRouter.get('/pending', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;

  const entries = await db
    .selectFrom('journal_entries as je')
    .where('je.household_id', '=', householdId)
    .where('je.reimbursement_status', '=', 'pending')
    .orderBy('je.date', 'desc')
    .selectAll('je')
    .execute();

  // Get expense amounts for each entry
  const entryIds = entries.map(e => e.id);
  const amounts = entryIds.length > 0
    ? await db.selectFrom('journal_lines as jl')
        .innerJoin('accounts as a', 'a.id', 'jl.account_id')
        .where('jl.journal_entry_id', 'in', entryIds)
        .where('a.account_type', '=', 'expense')
        .where('jl.amount', '>', 0)
        .select(['jl.journal_entry_id', sql<number>`SUM(jl.amount)`.as('total')])
        .groupBy('jl.journal_entry_id')
        .execute()
    : [];

  const amountByEntry = new Map(amounts.map(a => [a.journal_entry_id, Number(a.total)]));

  const data = entries.map(e => ({
    ...e,
    expense_amount: amountByEntry.get(e.id) || 0,
  }));

  const totalPending = data.reduce((sum, d) => sum + d.expense_amount, 0);

  res.json({ data, totalPending });
}));

// Mark an expense as reimbursable
const markReimbursableSchema = z.object({
  entry_id: z.string().min(1),
});

reimbursementsRouter.post('/mark', asyncHandler(async (req, res) => {
  const { entry_id } = markReimbursableSchema.parse(req.body);
  const householdId = req.householdId!;

  const groupId = nanoid();

  const updated = await db.updateTable('journal_entries')
    .set({
      reimbursement_status: 'pending',
      reimbursement_group_id: groupId,
      exclude_from_totals: true,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', entry_id)
    .where('household_id', '=', householdId)
    .where('reimbursement_status', 'is', null)
    .returningAll()
    .executeTakeFirst();

  if (!updated) {
    return res.status(404).json({ error: 'Entry not found or already marked' });
  }

  res.json(updated);
}));

// Unmark a reimbursable expense (back to normal)
// Clears reimbursement fields and restores exclude_from_totals to false
reimbursementsRouter.post('/unmark', asyncHandler(async (req, res) => {
  const { entry_id } = markReimbursableSchema.parse(req.body);
  const householdId = req.householdId!;

  const updated = await db.updateTable('journal_entries')
    .set({
      reimbursement_status: null,
      reimbursement_group_id: null,
      exclude_from_totals: false,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', entry_id)
    .where('household_id', '=', householdId)
    .where('reimbursement_status', '=', 'pending')
    .returningAll()
    .executeTakeFirst();

  if (!updated) {
    return res.status(404).json({ error: 'Entry not found or already reimbursed (cannot unmark)' });
  }

  res.json(updated);
}));

// Apply reimbursement — mark pending expenses as reimbursed
const applyReimbursementSchema = z.object({
  expense_entry_ids: z.array(z.string().min(1)).min(1),
});

reimbursementsRouter.post('/apply', asyncHandler(async (req, res) => {
  const data = applyReimbursementSchema.parse(req.body);
  const householdId = req.householdId!;

  // Validate the expense entries exist and are pending
  const expenses = await db.selectFrom('journal_entries')
    .where('id', 'in', data.expense_entry_ids)
    .where('household_id', '=', householdId)
    .where('reimbursement_status', '=', 'pending')
    .selectAll()
    .execute();

  if (expenses.length !== data.expense_entry_ids.length) {
    return res.status(400).json({ error: 'One or more expenses not found or not pending' });
  }

  // Compute total from server-authoritative data
  const expenseTotal = await db.selectFrom('journal_lines as jl')
    .innerJoin('accounts as a', 'a.id', 'jl.account_id')
    .where('jl.journal_entry_id', 'in', data.expense_entry_ids)
    .where('a.account_type', '=', 'expense')
    .where('jl.amount', '>', 0)
    .select(sql<number>`COALESCE(SUM(jl.amount), 0)`.as('total'))
    .executeTakeFirst();

  const amount = Number(expenseTotal?.total) || 0;

  const groupId = nanoid();

  // Mark expense entries as reimbursed (exclude_from_totals already set during /mark)
  await db.transaction().execute(async (tx) => {
    for (const expense of expenses) {
      await tx.updateTable('journal_entries')
        .set({
          reimbursement_group_id: groupId,
          reimbursement_status: 'reimbursed',
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', expense.id)
        .execute();
    }
  });

  res.json({ ok: true, amount, group_id: groupId });
}));
