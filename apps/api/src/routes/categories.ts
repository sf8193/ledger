import { Router, type Router as RouterType } from 'express';
import { db } from '../db/kysely';
import { nanoid } from 'nanoid';
import { asyncHandler } from '../middleware/error';
import { z } from 'zod';

export const categoriesRouter: RouterType = Router();

const createCategorySchema = z.object({
  name: z.string().min(1).max(100),
  icon: z.string().max(50).nullable().optional(),
  color: z.string().max(20).nullable().optional(),
  is_income: z.boolean().default(false),
  parent_id: z.string().nullable().optional(),
});

const updateCategorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  icon: z.string().max(50).nullable().optional(),
  color: z.string().max(20).nullable().optional(),
  sort_order: z.number().int().min(0).optional(),
});

// List categories (expense + income accounts)
categoriesRouter.get('/', asyncHandler(async (req, res) => {
  const categories = await db
    .selectFrom('accounts')
    .where('household_id', '=', req.householdId!)
    .where('account_type', 'in', ['expense', 'income'])
    .orderBy('sort_order', 'asc')
    .selectAll()
    .execute();

  res.json(categories);
}));

// Create category (as expense or income account)
categoriesRouter.post('/', asyncHandler(async (req, res) => {
  const data = createCategorySchema.parse(req.body);

  const category = {
    id: nanoid(),
    household_id: req.householdId!,
    name: data.name,
    account_type: data.is_income ? 'income' as const : 'expense' as const,
    plaid_item_id: null,
    plaid_account_id: null,
    institution_name: null,
    mask: null,
    subtype: null,
    is_hidden: false,
    icon: data.icon || null,
    color: data.color || null,
    parent_id: data.parent_id || null,
    sort_order: 0,
    is_manual: false,
    owner: null,
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  await db.insertInto('accounts').values(category).execute();
  res.json(category);
}));

// Update category
categoriesRouter.put('/:id', asyncHandler(async (req, res) => {
  const data = updateCategorySchema.parse(req.body);

  const updated = await db
    .updateTable('accounts')
    .set({
      ...(data.name !== undefined && { name: data.name }),
      ...(data.icon !== undefined && { icon: data.icon }),
      ...(data.color !== undefined && { color: data.color }),
      ...(data.sort_order !== undefined && { sort_order: data.sort_order }),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', req.params.id)
    .where('household_id', '=', req.householdId!)
    .where('account_type', 'in', ['expense', 'income'])
    .returningAll()
    .executeTakeFirst();

  if (!updated) {
    return res.status(404).json({ error: 'Category not found' });
  }

  res.json(updated);
}));

// Delete category
categoriesRouter.delete('/:id', asyncHandler(async (req, res) => {
  // Check for journal line references (scoped to household via accounts join)
  const lineCount = await db
    .selectFrom('journal_lines')
    .innerJoin('accounts', 'accounts.id', 'journal_lines.account_id')
    .where('journal_lines.account_id', '=', req.params.id)
    .where('accounts.household_id', '=', req.householdId!)
    .select(db.fn.countAll().as('count'))
    .executeTakeFirst();

  if (Number(lineCount?.count) > 0) {
    res.status(409).json({
      error: 'Category has transactions. Reassign them first.',
      entryCount: Number(lineCount?.count),
    });
    return;
  }

  await db
    .deleteFrom('accounts')
    .where('id', '=', req.params.id)
    .where('household_id', '=', req.householdId!)
    .where('account_type', 'in', ['expense', 'income'])
    .execute();

  res.json({ ok: true });
}));
