import { Router, type Router as RouterType } from 'express';
import { db } from '../db/kysely';
import { sql } from 'kysely';
import { asyncHandler } from '../middleware/error';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { normalizeOwner } from '../lib/normalize-owner';
import { TRANSFER_CATEGORIES } from '../services/plaid-categories';

export const transactionsRouter: RouterType = Router();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  search: z.string().max(200).optional(),
  owner: z.string().max(100).optional(),
  min_amount: z.coerce.number().finite().optional(),
  max_amount: z.coerce.number().finite().optional(),
  type: z.enum(['expenses', 'income', 'transfers']).optional(),
  account_id: z.union([z.string(), z.array(z.string())]).optional(),
  category_id: z.union([z.string(), z.array(z.string())]).optional(),
  tag_id: z.union([z.string(), z.array(z.string())]).optional(),
});

const updateEntrySchema = z.object({
  category_id: z.string().nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  owner: z.string().max(100).nullable().optional(),
  exclude_from_totals: z.boolean().nullable().optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
});

// List journal entries with filters
transactionsRouter.get('/', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;
  const { limit, offset, start_date, end_date, account_id, category_id, tag_id, owner, search, min_amount, max_amount, type } = listQuerySchema.parse(req.query);

  let baseQuery = db
    .selectFrom('journal_entries as je')
    .where('je.household_id', '=', householdId)
    .where('je.source', '!=', 'plaid_reconciliation')
    .where('je.superseded_by', 'is', null);

  if (start_date) baseQuery = baseQuery.where('je.date', '>=', sql<Date>`${start_date}::date`);
  if (end_date) baseQuery = baseQuery.where('je.date', '<=', sql<Date>`${end_date}::date`);
  if (owner) baseQuery = baseQuery.where('je.owner', '=', owner);
  if (search) {
    const escaped = search.replace(/[%_\\]/g, '\\$&');
    const s = `%${escaped.toLowerCase()}%`;
    baseQuery = baseQuery.where((eb) =>
      eb.or([
        eb('je.description', 'ilike', s),
        eb('je.merchant_name', 'ilike', s),
      ])
    );
  }

  // Filter by account(s) — supports multi-select
  const accountIds = Array.isArray(account_id) ? account_id : account_id ? [account_id] : [];
  if (accountIds.length > 0) {
    baseQuery = baseQuery.where('je.id', 'in',
      db.selectFrom('journal_lines')
        .innerJoin('accounts', 'accounts.id', 'journal_lines.account_id')
        .where('journal_lines.account_id', 'in', accountIds)
        .where('accounts.household_id', '=', householdId)
        .select('journal_lines.journal_entry_id')
    );
  }

  // Filter by category(s) — supports multi-select
  // Category IDs are expense/income account IDs in the chart of accounts.
  // A journal entry matches if it has a journal_line pointing at one of those accounts.
  const catIds = Array.isArray(category_id) ? category_id : category_id ? [category_id] : [];
  if (catIds.length > 0) {
    baseQuery = baseQuery.where('je.id', 'in',
      db.selectFrom('journal_lines')
        .innerJoin('accounts', 'accounts.id', 'journal_lines.account_id')
        .where('journal_lines.account_id', 'in', catIds)
        .where('accounts.household_id', '=', householdId)
        .where('accounts.account_type', 'in', ['expense', 'income'])
        .select('journal_lines.journal_entry_id')
    );
  }

  // Filter by tag(s)
  const tagIds = Array.isArray(tag_id) ? tag_id : tag_id ? [tag_id] : [];
  if (tagIds.length > 0) {
    baseQuery = baseQuery.where('je.id', 'in',
      db.selectFrom('journal_entry_tags')
        .where('journal_entry_tags.tag_id', 'in', tagIds)
        .select('journal_entry_tags.journal_entry_id')
    );
  }

  // Filter by amount range (matches absolute value of expense/income lines)
  if (min_amount !== undefined || max_amount !== undefined) {
    baseQuery = baseQuery.where('je.id', 'in',
      db.selectFrom('journal_lines as jl')
        .innerJoin('accounts as a', 'a.id', 'jl.account_id')
        .where('a.account_type', 'in', ['expense', 'income'])
        .where((eb) => {
          const conditions = [];
          if (min_amount !== undefined) conditions.push(eb(sql`ABS(jl.amount)`, '>=', min_amount));
          if (max_amount !== undefined) conditions.push(eb(sql`ABS(jl.amount)`, '<=', max_amount));
          return eb.and(conditions);
        })
        .select('jl.journal_entry_id')
    );
  }

  // Filter by type: expenses, income, transfers
  if (type === 'expenses') {
    baseQuery = baseQuery.where('je.id', 'in',
      db.selectFrom('journal_lines as jl')
        .innerJoin('accounts as a', 'a.id', 'jl.account_id')
        .where('a.account_type', '=', 'expense')
        .where('a.name', '!=', 'Transfers')
        .select('jl.journal_entry_id')
    );
  } else if (type === 'income') {
    baseQuery = baseQuery.where('je.id', 'in',
      db.selectFrom('journal_lines as jl')
        .innerJoin('accounts as a', 'a.id', 'jl.account_id')
        .where('a.account_type', '=', 'income')
        .where('a.name', '!=', 'Uncategorized Income')
        .select('jl.journal_entry_id')
    );
  } else if (type === 'transfers') {
    baseQuery = baseQuery.where((eb) =>
      eb.or([
        // Entries with Transfers category
        eb('je.id', 'in',
          db.selectFrom('journal_lines as jl')
            .innerJoin('accounts as a', 'a.id', 'jl.account_id')
            .where('a.name', '=', 'Transfers')
            .select('jl.journal_entry_id')
        ),
        // Matchmaker-merged entries
        eb('je.source', '=', 'matchmaker'),
      ])
    );
  }

  const [entries, countResult] = await Promise.all([
    baseQuery
      .orderBy('je.date', 'desc')
      .orderBy('je.created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .selectAll('je')
      .execute(),
    baseQuery
      .select(sql<number>`COUNT(*)`.as('total'))
      .executeTakeFirst(),
  ]);

  // Fetch lines for each entry
  const entryIds = entries.map(e => e.id);
  const lines = entryIds.length > 0
    ? await db.selectFrom('journal_lines as jl')
        .innerJoin('accounts as a', 'a.id', 'jl.account_id')
        .where('jl.journal_entry_id', 'in', entryIds)
        .select([
          'jl.id', 'jl.journal_entry_id', 'jl.account_id', 'jl.amount',
          'a.name as account_name', 'a.account_type',
        ])
        .execute()
    : [];

  // Fetch tags for each entry
  const entryTags = entryIds.length > 0
    ? await db.selectFrom('journal_entry_tags as jet')
        .innerJoin('tags as t', 't.id', 'jet.tag_id')
        .where('jet.journal_entry_id', 'in', entryIds)
        .select(['jet.journal_entry_id', 't.id', 't.name'])
        .execute()
    : [];

  // Group lines by entry
  const linesByEntry = new Map<string, typeof lines>();
  for (const line of lines) {
    const existing = linesByEntry.get(line.journal_entry_id) || [];
    existing.push(line);
    linesByEntry.set(line.journal_entry_id, existing);
  }

  // Group tags by entry
  const tagsByEntry = new Map<string, Array<{ id: string; name: string }>>();
  for (const et of entryTags) {
    const existing = tagsByEntry.get(et.journal_entry_id) || [];
    existing.push({ id: et.id, name: et.name });
    tagsByEntry.set(et.journal_entry_id, existing);
  }

  const data = entries.map(e => {
    const entryLines = linesByEntry.get(e.id) || [];
    const categoryLine = entryLines.find(l => l.account_type === 'expense' || l.account_type === 'income');
    const bankLines = entryLines.filter(l => l.account_type === 'asset' || l.account_type === 'liability');

    // Detect transfers: category is "Transfers", matchmaker-merged,
    // uncategorized with Plaid transfer category, or CC payment (uncategorized income on a liability)
    const isUncategorized = categoryLine?.account_name === 'Uncategorized' ||
      categoryLine?.account_name === 'Uncategorized Income';
    const hasCCLine = bankLines.some(l => l.account_type === 'liability');
    const isTransfer = categoryLine?.account_name === 'Transfers' ||
      (e.source === 'matchmaker' && !categoryLine && bankLines.length === 2) ||
      (isUncategorized && e.plaid_category && TRANSFER_CATEGORIES.has(e.plaid_category)) ||
      (isUncategorized && hasCCLine);

    let transfer: { from_account: string; to_account: string; amount: number } | undefined;
    if (isTransfer && bankLines.length >= 2) {
      const outflow = bankLines.find(l => Number(l.amount) < 0);
      const inflow = bankLines.find(l => Number(l.amount) > 0);
      if (outflow && inflow) {
        transfer = {
          from_account: outflow.account_name,
          to_account: inflow.account_name,
          amount: Math.abs(Number(outflow.amount)),
        };
      }
    } else if (isTransfer && bankLines.length === 1) {
      // Single-sided transfer (other side not connected) — use merchant/description as the unknown side
      const bank = bankLines[0];
      const label = e.merchant_name || e.description;
      transfer = {
        from_account: Number(bank.amount) < 0 ? bank.account_name : label,
        to_account: Number(bank.amount) > 0 ? bank.account_name : label,
        amount: Math.abs(Number(bank.amount)),
      };
    }

    return {
      ...e,
      lines: entryLines,
      amount: entryLines
        .filter(l => l.account_type === 'expense' || l.account_type === 'income')
        .reduce((sum, l) => sum + Number(l.amount), 0),
      category: categoryLine,
      transfer,
      tags: tagsByEntry.get(e.id) || [],
    };
  });

  // Include pending transactions (from staging table, not yet in the ledger)
  let pendingQuery = db
    .selectFrom('pending_transactions as pt')
    .innerJoin('accounts as a', 'a.id', 'pt.account_id')
    .where('pt.household_id', '=', householdId);

  if (start_date) pendingQuery = pendingQuery.where('pt.date', '>=', start_date);
  if (end_date) pendingQuery = pendingQuery.where('pt.date', '<=', end_date);
  if (accountIds.length > 0) {
    pendingQuery = pendingQuery.where('pt.account_id', 'in', accountIds);
  }
  if (search) {
    const escaped = search.replace(/[%_\\]/g, '\\$&');
    const s = `%${escaped.toLowerCase()}%`;
    pendingQuery = pendingQuery.where((eb) =>
      eb.or([
        eb('pt.name', 'ilike', s),
        eb('pt.merchant_name', 'ilike', s),
      ])
    );
  }

  const pendingTxns = await pendingQuery
    .orderBy('pt.date', 'desc')
    .select([
      'pt.id', 'pt.date', 'pt.name as description', 'pt.merchant_name',
      'pt.amount', 'pt.plaid_category', 'pt.account_id',
      'a.name as account_name',
    ])
    .execute();

  const pendingItems = pendingTxns.map(pt => ({
    id: pt.id,
    date: pt.date,
    description: pt.description,
    merchant_name: pt.merchant_name,
    amount: -Number(pt.amount),
    account_name: pt.account_name,
    pending: true,
  }));

  res.json({ data, pending: pendingItems, total: Number(countResult?.total) || 0 });
}));

// Update journal entry (change category = move the expense/income line)
transactionsRouter.put('/:id', asyncHandler(async (req, res) => {
  const data = updateEntrySchema.parse(req.body);
  const householdId = req.householdId!;

  // Verify entry belongs to this household BEFORE the transaction
  const entryExists = await db.selectFrom('journal_entries')
    .where('id', '=', req.params.id)
    .where('household_id', '=', householdId)
    .select('id')
    .executeTakeFirst();

  if (!entryExists) {
    return res.status(404).json({ error: 'Entry not found' });
  }

  await db.transaction().execute(async (tx) => {
    // Update entry metadata
    const setFields: Record<string, any> = { updated_at: new Date().toISOString() };
    if (data.notes !== undefined) setFields.notes = data.notes;
    if (data.owner !== undefined) {
      setFields.owner = normalizeOwner(data.owner);
    }
    if (data.exclude_from_totals !== undefined) setFields.exclude_from_totals = data.exclude_from_totals;

    await tx.updateTable('journal_entries')
      .set(setFields)
      .where('id', '=', req.params.id)
      .where('household_id', '=', householdId)
      .execute();

    // If tags changed, sync the junction table
    if (data.tags !== undefined) {
      // Delete existing tags for this entry
      await tx.deleteFrom('journal_entry_tags')
        .where('journal_entry_id', '=', req.params.id)
        .execute();

      if (data.tags.length > 0) {
        // Get-or-create each tag
        const tagIds: string[] = [];
        for (const tagName of data.tags) {
          const trimmed = tagName.trim();
          if (!trimmed) continue;

          // Insert if not exists (case-insensitive), then fetch the id
          const tagId = nanoid();
          await tx.insertInto('tags').values({
            id: tagId,
            household_id: householdId,
            name: trimmed,
            created_at: new Date().toISOString(),
          }).onConflict(oc => oc
            .expression(sql`(household_id, LOWER(name))`)
            .doNothing()
          ).execute();

          const tag = await tx.selectFrom('tags')
            .where('household_id', '=', householdId)
            .where(sql`LOWER(name)`, '=', trimmed.toLowerCase())
            .select('id')
            .executeTakeFirstOrThrow();
          tagIds.push(tag.id);
        }

        if (tagIds.length > 0) {
          await tx.insertInto('journal_entry_tags').values(
            tagIds.map(tagId => ({
              journal_entry_id: req.params.id,
              tag_id: tagId,
            }))
          ).execute();
        }
      }
    }

    // If category changed, update the expense/income line's account_id and mark as user-categorized
    if (data.category_id !== undefined) {
      await tx.updateTable('journal_entries')
        .set({ categorized_by: 'user' })
        .where('id', '=', req.params.id)
        .execute();
      // Find the expense/income line for this entry
      const expenseLine = await tx.selectFrom('journal_lines as jl')
        .innerJoin('accounts as a', 'a.id', 'jl.account_id')
        .where('jl.journal_entry_id', '=', req.params.id)
        .where('a.account_type', 'in', ['expense', 'income'])
        .select(['jl.id'])
        .executeTakeFirst();

      if (expenseLine && data.category_id) {
        // Validate category belongs to this household AND is expense/income type
        const categoryAccount = await tx.selectFrom('accounts')
          .where('id', '=', data.category_id)
          .where('household_id', '=', householdId)
          .where('account_type', 'in', ['expense', 'income'])
          .select('id')
          .executeTakeFirst();

        if (!categoryAccount) {
          throw new Error('Category does not belong to this household');
        }

        await tx.updateTable('journal_lines')
          .set({ account_id: data.category_id })
          .where('id', '=', expenseLine.id)
          .execute();
      } else if (expenseLine && data.category_id === null) {
        // Un-categorize: move line to the system "Uncategorized" account
        const currentAccount = await tx.selectFrom('journal_lines as jl')
          .innerJoin('accounts as a', 'a.id', 'jl.account_id')
          .where('jl.id', '=', expenseLine.id)
          .select('a.account_type')
          .executeTakeFirst();

        const uncatName = currentAccount?.account_type === 'income'
          ? 'Uncategorized Income'
          : 'Uncategorized';

        const uncatAccount = await tx.selectFrom('accounts')
          .where('household_id', '=', householdId)
          .where('name', '=', uncatName)
          .where('account_type', 'in', ['expense', 'income'])
          .select('id')
          .executeTakeFirst();

        if (!uncatAccount) {
          throw new Error(`System account "${uncatName}" not found`);
        }

        await tx.updateTable('journal_lines')
          .set({ account_id: uncatAccount.id })
          .where('id', '=', expenseLine.id)
          .execute();
      }
    }
  });

  // Fetch updated entry with tags
  const entry = await db.selectFrom('journal_entries')
    .where('id', '=', req.params.id)
    .where('household_id', '=', householdId)
    .selectAll()
    .executeTakeFirst();

  if (!entry) {
    return res.status(404).json({ error: 'Entry not found' });
  }

  const updatedTags = await db.selectFrom('journal_entry_tags as jet')
    .innerJoin('tags as t', 't.id', 'jet.tag_id')
    .where('jet.journal_entry_id', '=', req.params.id)
    .select(['t.id', 't.name'])
    .execute();

  res.json({ ...entry, tags: updatedTags });
}));

// Create manual journal entry
const createEntrySchema = z.object({
  date: z.string().min(1),
  description: z.string().min(1).max(500),
  merchant_name: z.string().max(200).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  owner: z.string().max(100).nullable().optional(),
  lines: z.array(z.object({
    account_id: z.string().min(1),
    amount: z.number().finite(),
  })).min(2),
});

transactionsRouter.post('/', asyncHandler(async (req, res) => {
  const data = createEntrySchema.parse(req.body);
  const householdId = req.householdId!;

  // Validate lines sum to zero (round to 2 decimals to avoid JS float artifacts)
  const sum = data.lines.reduce((s, l) => s + Math.round(l.amount * 100) / 100, 0);
  const roundedSum = Math.round(sum * 100) / 100;
  if (Math.abs(roundedSum) >= 0.01) {
    return res.status(400).json({ error: `Lines must sum to zero (sum: ${roundedSum.toFixed(2)})` });
  }

  // Validate all account_ids belong to this household
  const accountIds = [...new Set(data.lines.map(l => l.account_id))];
  const ownedAccounts = await db.selectFrom('accounts')
    .where('id', 'in', accountIds)
    .where('household_id', '=', householdId)
    .select('id')
    .execute();

  if (ownedAccounts.length !== accountIds.length) {
    return res.status(400).json({ error: 'One or more account_ids do not belong to this household' });
  }

  const entryId = nanoid();

  await db.transaction().execute(async (tx) => {
    await tx.insertInto('journal_entries').values({
      id: entryId,
      household_id: householdId,
      date: data.date,
      description: data.description,
      merchant_name: data.merchant_name || null,
      notes: data.notes || null,
      owner: normalizeOwner(data.owner),
      is_verified: false,
      plaid_transaction_id: null,
      source: 'manual',
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }).execute();

    await tx.insertInto('journal_lines').values(
      data.lines.map(l => ({
        id: nanoid(),
        journal_entry_id: entryId,
        account_id: l.account_id,
        amount: l.amount,
        created_at: new Date().toISOString(),
      }))
    ).execute();
  });

  res.json({ id: entryId });
}));

// Delete journal entry (cascades to lines via FK)
transactionsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const result = await db.deleteFrom('journal_entries')
    .where('id', '=', req.params.id)
    .where('household_id', '=', req.householdId!)
    .executeTakeFirst();

  if (BigInt(result.numDeletedRows) === 0n) {
    return res.status(404).json({ error: 'Entry not found' });
  }

  res.json({ ok: true });
}));

// List all tags for the household
transactionsRouter.get('/tags', asyncHandler(async (req, res) => {
  const tags = await db.selectFrom('tags')
    .where('household_id', '=', req.householdId!)
    .select(['id', 'name'])
    .orderBy('name', 'asc')
    .execute();
  res.json(tags);
}));

// Delete a tag (removes from all entries)
transactionsRouter.delete('/tags/:tagId', asyncHandler(async (req, res) => {
  const result = await db.deleteFrom('tags')
    .where('id', '=', req.params.tagId)
    .where('household_id', '=', req.householdId!)
    .executeTakeFirst();

  if (BigInt(result.numDeletedRows) === 0n) {
    return res.status(404).json({ error: 'Tag not found' });
  }
  res.json({ ok: true });
}));

// Get owner options (household member names)
transactionsRouter.get('/owners', asyncHandler(async (req, res) => {
  const members = await db
    .selectFrom('household_members')
    .innerJoin('user', 'user.id', 'household_members.user_id')
    .where('household_members.household_id', '=', req.householdId!)
    .select('user.name')
    .orderBy('user.name', 'asc')
    .execute();

  res.json(members.map(m => normalizeOwner(m.name)).filter(Boolean));
}));
