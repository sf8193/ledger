import { Router, type Router as RouterType } from 'express';
import { db } from '../db/kysely';
import { sql } from 'kysely';
import { nanoid } from 'nanoid';
import { asyncHandler } from '../middleware/error';
import { z } from 'zod';
import { getOrCreateEquityAccount } from '../lib/equity-account';
import { normalizeOwner } from '../lib/normalize-owner';

export const accountsRouter: RouterType = Router();

const createAccountSchema = z.object({
  name: z.string().min(1).max(200),
  account_type: z.enum(['asset', 'liability', 'income', 'expense']),
  subtype: z.string().max(100).nullable().optional(),
  initial_balance: z.number().finite().default(0),
  icon: z.string().max(50).nullable().optional(),
  color: z.string().max(20).nullable().optional(),
  parent_id: z.string().nullable().optional(),
});

const updateAccountSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  is_hidden: z.boolean().optional(),
  balance: z.number().finite().optional(),
  icon: z.string().max(50).nullable().optional(),
  color: z.string().max(20).nullable().optional(),
  sort_order: z.number().int().min(0).optional(),
  owner: z.string().max(100).nullable().optional(),
  tax_treatment: z.enum(['taxable', 'tax_deferred', 'roth']).nullable().optional(),
});

// List accounts — optionally filter by type
accountsRouter.get('/', asyncHandler(async (req, res) => {
  const { type } = req.query;

  let query = db
    .selectFrom('accounts')
    .leftJoin('plaid_items', 'plaid_items.id', 'accounts.plaid_item_id')
    .where('accounts.household_id', '=', req.householdId!)
    .orderBy('accounts.sort_order', 'asc')
    .orderBy('accounts.created_at', 'asc');

  if (type) {
    query = query.where('accounts.account_type', '=', type as any);
  }

  const accounts = await query
    .selectAll('accounts')
    .select(['plaid_items.logo as institution_logo', 'plaid_items.primary_color as institution_color'])
    .execute();

  // For asset/liability accounts, compute balance from ledger
  const assetLiabilityIds = accounts
    .filter(a => ['asset', 'liability'].includes(a.account_type))
    .map(a => a.id);

  let ledgerBalances = new Map<string, number>();
  if (assetLiabilityIds.length > 0) {
    const balances = await db
      .selectFrom('journal_lines as jl')
      .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
      .where('jl.account_id', 'in', assetLiabilityIds)
      .where(sql`COALESCE(je.exclude_from_totals, false)`, '=', false)
      .groupBy('jl.account_id')
      .select([
        'jl.account_id',
        sql<number>`SUM(jl.amount)`.as('balance'),
      ])
      .execute();
    ledgerBalances = new Map(balances.map(b => [b.account_id, Number(b.balance)]));
  }

  const result = accounts.map(a => ({
    ...a,
    // Compute balance from ledger for asset/liability accounts
    balance: ['asset', 'liability'].includes(a.account_type)
      ? (ledgerBalances.get(a.id) || 0)
      : 0,
    institution_logo: (a as any).institution_logo || null,
    institution_color: (a as any).institution_color || null,
  }));

  res.json(result);
}));

// Get single account with stats
accountsRouter.get('/:id', asyncHandler(async (req, res) => {
  const account = await db
    .selectFrom('accounts')
    .leftJoin('plaid_items', 'plaid_items.id', 'accounts.plaid_item_id')
    .where('accounts.id', '=', req.params.id)
    .where('accounts.household_id', '=', req.householdId!)
    .selectAll('accounts')
    .select([
      'plaid_items.logo as institution_logo',
      'plaid_items.primary_color as institution_color',
      'plaid_items.last_synced',
      'plaid_items.status as connection_status',
    ])
    .executeTakeFirst();

  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  // Compute balance from ledger
  const ledgerSum = await db
    .selectFrom('journal_lines as jl')
    .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
    .where('jl.account_id', '=', account.id)
    .where(sql`COALESCE(je.exclude_from_totals, false)`, '=', false)
    .select(sql<number>`COALESCE(SUM(jl.amount), 0)`.as('balance'))
    .executeTakeFirst();

  // Count transactions
  const txnCount = await db
    .selectFrom('journal_lines')
    .where('account_id', '=', account.id)
    .select(db.fn.countAll().as('count'))
    .executeTakeFirst();

  res.json({
    ...account,
    balance: Number(ledgerSum?.balance) || 0,
    transaction_count: Number(txnCount?.count) || 0,
    institution_logo: (account as any).institution_logo || null,
    institution_color: (account as any).institution_color || null,
    last_synced: (account as any).last_synced || null,
    connection_status: (account as any).connection_status || null,
  });
}));

// Create account
accountsRouter.post('/', asyncHandler(async (req, res) => {
  const data = createAccountSchema.parse(req.body);

  const account = {
    id: nanoid(),
    household_id: req.householdId!,
    name: data.name,
    account_type: data.account_type,
    plaid_item_id: null,
    plaid_account_id: null,
    institution_name: null,
    mask: null,
    subtype: data.subtype || null,
    
    is_hidden: false,
    icon: data.icon || null,
    color: data.color || null,
    parent_id: data.parent_id || null,
    sort_order: 0,
    is_manual: true,
    owner: null,
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  await db.transaction().execute(async (tx) => {
    await tx.insertInto('accounts').values(account).execute();

    // If asset/liability with initial balance, create opening balance journal entry
    if (['asset', 'liability'].includes(data.account_type) && Math.abs(data.initial_balance) >= 0.01) {
      const equityId = await getOrCreateEquityAccount(tx, req.householdId!);

      const entryId = nanoid();
      await tx.insertInto('journal_entries').values({
        id: entryId, household_id: req.householdId!,
        date: new Date().toISOString().split('T')[0],
        description: `Opening balance: ${data.name}`,
        merchant_name: null, notes: null,
        owner: null, is_verified: true, plaid_transaction_id: null,
        source: 'manual_adjustment',
        updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
      }).execute();

      // Liability: credit (negative) increases what you owe; Asset: debit (positive) increases balance
      const ledgerAmount = data.account_type === 'liability' ? -data.initial_balance : data.initial_balance;

      await tx.insertInto('journal_lines').values([
        { id: nanoid(), journal_entry_id: entryId, account_id: account.id, amount: ledgerAmount, created_at: new Date().toISOString() },
        { id: nanoid(), journal_entry_id: entryId, account_id: equityId, amount: -ledgerAmount, created_at: new Date().toISOString() },
      ]).execute();
    }
  });

  res.json(account);
}));

// Update account
accountsRouter.put('/:id', asyncHandler(async (req, res) => {
  const data = updateAccountSchema.parse(req.body);
  const householdId = req.householdId!;
  const accountId = req.params.id;

  const updated = await db.transaction().execute(async (tx) => {
    // If balance is changing, validate it's an asset/liability account
    if (data.balance !== undefined) {
      const account = await tx.selectFrom('accounts')
        .where('id', '=', accountId)
        .where('household_id', '=', householdId)
        .select(['id', 'account_type'])
        .executeTakeFirst();

      // Reject balance changes on expense/income/equity accounts
      if (account && !['asset', 'liability'].includes(account.account_type)) {
        throw new Error('Cannot set current_balance on expense/income accounts');
      }

      if (account && ['asset', 'liability'].includes(account.account_type)) {
        // Compute current balance from LEDGER, not cache
        const ledgerSum = await tx.selectFrom('journal_lines as jl')
          .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
          .where('jl.account_id', '=', accountId)
          .where(sql`COALESCE(je.exclude_from_totals, false)`, '=', false)
          .select(sql<number>`COALESCE(SUM(jl.amount), 0)`.as('total'))
          .executeTakeFirst();
        const ledgerBalance = Number(ledgerSum?.total) || 0;

        // For liabilities: ledger stores negative, target is positive. Compute target ledger value.
        const targetLedger = account.account_type === 'liability' ? -data.balance : data.balance;
        const diff = targetLedger - ledgerBalance;
        if (Math.abs(diff) >= 0.01) {
          const equityId = await getOrCreateEquityAccount(tx, householdId);

          const entryId = nanoid();
          await tx.insertInto('journal_entries').values({
            id: entryId, household_id: householdId,
            date: new Date().toISOString().split('T')[0],
            description: `Balance adjustment: ${Math.abs(diff).toFixed(2)}`,
            merchant_name: null, notes: 'Automatic adjustment from balance edit',
            owner: null, is_verified: true, plaid_transaction_id: null,
            source: 'manual_adjustment',
            updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
          }).execute();

          // diff is already in ledger space (target_ledger - current_ledger)
          const ledgerDiff = diff;

          await tx.insertInto('journal_lines').values([
            { id: nanoid(), journal_entry_id: entryId, account_id: account.id, amount: ledgerDiff, created_at: new Date().toISOString() },
            { id: nanoid(), journal_entry_id: entryId, account_id: equityId, amount: -ledgerDiff, created_at: new Date().toISOString() },
          ]).execute();
        }
      }
    }

    return await tx
      .updateTable('accounts')
      .set({
        ...(data.name !== undefined && { name: data.name }),
        ...(data.is_hidden !== undefined && { is_hidden: data.is_hidden }),
        
        ...(data.icon !== undefined && { icon: data.icon }),
        ...(data.color !== undefined && { color: data.color }),
        ...(data.sort_order !== undefined && { sort_order: data.sort_order }),
        ...(data.owner !== undefined && { owner: normalizeOwner(data.owner) }),
        ...(data.tax_treatment !== undefined && { tax_treatment: data.tax_treatment }),
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', accountId)
      .where('household_id', '=', householdId)
      .returningAll()
      .executeTakeFirst();
  });

  if (!updated) {
    return res.status(404).json({ error: 'Account not found' });
  }

  res.json(updated);
}));

// Delete account
accountsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const lineCount = await db
    .selectFrom('journal_lines')
    .innerJoin('journal_entries', 'journal_entries.id', 'journal_lines.journal_entry_id')
    .where('journal_lines.account_id', '=', req.params.id)
    .where('journal_entries.household_id', '=', req.householdId!)
    .select(db.fn.countAll().as('count'))
    .executeTakeFirst();

  if (Number(lineCount?.count) > 0) {
    res.status(409).json({
      error: 'Account has journal entries. Delete or reassign them first.',
      entryCount: Number(lineCount?.count),
    });
    return;
  }

  await db
    .deleteFrom('accounts')
    .where('id', '=', req.params.id)
    .where('household_id', '=', req.householdId!)
    .execute();

  res.json({ ok: true });
}));
