import { db } from '../db/kysely';
import { sql, Transaction as KyselyTransaction } from 'kysely';
import { nanoid } from 'nanoid';
import { getPlaidClient } from '../lib/plaid';
import { decrypt } from '../lib/crypto';
import { runMatchmaker } from './matchmaker';
import { Database } from '../db/types';
import { Transaction as PlaidTransaction } from 'plaid';
import { normalizeOwner } from '../lib/normalize-owner';
import { logger } from '../lib/logger';

const log = logger.child({ context: 'sync' });

// --- Per-item lock map ---
const syncLocks = new Map<string, Promise<any>>();

function withItemLock<T>(itemId: string, fn: () => Promise<T>): Promise<T> {
  const existing = syncLocks.get(itemId);
  const run = async () => {
    if (existing) {
      try { await existing; } catch {}
    }
    return fn();
  };
  const promise = run().finally(() => {
    if (syncLocks.get(itemId) === promise) {
      syncLocks.delete(itemId);
    }
  });
  syncLocks.set(itemId, promise);
  return promise;
}

/**
 * Sync transactions for a single Plaid item.
 * Uses cursor-based /transactions/sync, creates journal entries + lines,
 * then reconciles balances.
 */
export async function syncItemTransactions(
  householdId: string,
  plaidItemId: string
): Promise<{ added: number; modified: number; removed: number; pending_added: number }> {
  return withItemLock(plaidItemId, () => _syncItemTransactions(householdId, plaidItemId));
}

async function createJournalEntry(
  tx: KyselyTransaction<Database>,
  householdId: string,
  plaidTx: PlaidTransaction,
  bankAccountId: string,
  plaidCategory: string | null,
  uncatExpenseId: string,
  uncatIncomeId: string,
  accountOwner: string | null = null,
) {
  const entryId = nanoid();
  await tx.insertInto('journal_entries').values({
    id: entryId,
    household_id: householdId,
    date: plaidTx.date,
    description: plaidTx.name,
    merchant_name: plaidTx.merchant_name || null,
    notes: null,
    owner: normalizeOwner(accountOwner),
    is_verified: false,
    plaid_transaction_id: plaidTx.transaction_id,
    plaid_category: plaidCategory,
    source: 'plaid',
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  }).execute();

  await tx.insertInto('journal_lines').values([
    {
      id: nanoid(),
      journal_entry_id: entryId,
      account_id: plaidTx.amount > 0 ? uncatExpenseId : uncatIncomeId,
      amount: plaidTx.amount,
      created_at: new Date().toISOString(),
    },
    {
      id: nanoid(),
      journal_entry_id: entryId,
      account_id: bankAccountId,
      amount: -plaidTx.amount,
      created_at: new Date().toISOString(),
    },
  ]).execute();
}

async function _syncItemTransactions(
  householdId: string,
  plaidItemId: string
): Promise<{ added: number; modified: number; removed: number; pending_added: number }> {
  const item = await db
    .selectFrom('plaid_items')
    .where('id', '=', plaidItemId)
    .selectAll()
    .executeTakeFirst();

  if (!item) throw new Error('Plaid item not found');

  const plaid = getPlaidClient();
  let accessToken: string;
  try {
    accessToken = decrypt(item.access_token_encrypted);
  } catch {
    await db.updateTable('plaid_items')
      .set({ status: 'error' })
      .where('id', '=', plaidItemId)
      .execute();
    throw new Error('Failed to decrypt access token');
  }

  // Build account lookup: plaid_account_id -> our account.id
  const accounts = await db
    .selectFrom('accounts')
    .where('plaid_item_id', '=', plaidItemId)
    .select(['id', 'plaid_account_id', 'owner'])
    .execute();

  const accountMap = new Map(
    accounts.filter(a => a.plaid_account_id).map(a => [a.plaid_account_id!, a.id])
  );

  const accountOwnerMap = new Map(
    accounts.filter(a => a.plaid_account_id).map(a => [a.plaid_account_id!, a.owner])
  );

  // Get or create Uncategorized expense + income accounts
  async function getOrCreateAccount(name: string, type: 'expense' | 'income', opts?: { hidden?: boolean; excludeFromTotals?: boolean }) {
    let acct = await db.selectFrom('accounts')
      .where('household_id', '=', householdId)
      .where('name', '=', name)
      .where('account_type', '=', type)
      .select('id')
      .executeTakeFirst();
    if (acct) {
      // Enforce flags on existing accounts
      if (opts?.hidden !== undefined || opts?.excludeFromTotals !== undefined) {
        const updates: Record<string, boolean> = {};
        if (opts?.hidden !== undefined) updates.is_hidden = opts.hidden;
        if (opts?.excludeFromTotals !== undefined) updates.exclude_from_totals = opts.excludeFromTotals;
        await db.updateTable('accounts')
          .set(updates)
          .where('id', '=', acct.id)
          .execute();
      }
    } else {
      const id = nanoid();
      await db.insertInto('accounts').values({
        id, household_id: householdId, name, account_type: type,
        plaid_item_id: null, plaid_account_id: null, institution_name: null,
        mask: null, subtype: null,
        is_hidden: opts?.hidden ?? false,
        exclude_from_totals: opts?.excludeFromTotals ?? false,
        icon: null, color: null, parent_id: null, sort_order: 9999,
        is_manual: false, owner: null,
        updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
      }).execute();
      acct = { id };
    }
    return acct.id;
  }

  const uncatExpenseId = await getOrCreateAccount('Uncategorized', 'expense');
  const uncatIncomeId = await getOrCreateAccount('Uncategorized Income', 'income');

  let cursor = item.cursor || undefined;
  let added = 0;
  let modified = 0;
  let removed = 0;
  let pending_added = 0;
  let hasMore = true;

  while (hasMore) {
    let response;
    try {
      response = await plaid.transactionsSync({
        access_token: accessToken,
        cursor,
      });
    } catch (err: any) {
      if (err?.response?.data?.error_code === 'ITEM_LOGIN_REQUIRED') {
        await db.updateTable('plaid_items')
          .set({ status: 'reauth_needed' })
          .where('id', '=', plaidItemId)
          .execute();
      }
      throw err;
    }

    const data = response.data;

    // Track accountMap misses separately from legitimate skips (duplicates, pending).
    // Misses mean data loss — we must not advance the cursor past them.
    let accountMapMisses = 0;

    await db.transaction().execute(async (tx) => {
      // Process added transactions
      for (const plaidTx of data.added) {
        const bankAccountId = accountMap.get(plaidTx.account_id);
        if (!bankAccountId) { accountMapMisses++; continue; }

        const plaidCategory = plaidTx.personal_finance_category?.primary || null;

        if (plaidTx.pending) {
          // Pending → staging table (mutable, not in the ledger)
          const existingPending = await tx.selectFrom('pending_transactions')
            .where('plaid_transaction_id', '=', plaidTx.transaction_id)
            .select('id')
            .executeTakeFirst();

          if (!existingPending) {
            await tx.insertInto('pending_transactions').values({
              id: nanoid(),
              household_id: householdId,
              plaid_transaction_id: plaidTx.transaction_id,
              plaid_account_id: plaidTx.account_id,
              account_id: bankAccountId,
              date: plaidTx.date,
              name: plaidTx.name,
              merchant_name: plaidTx.merchant_name || null,
              amount: plaidTx.amount,
              plaid_category: plaidCategory,
              updated_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            }).execute();
            pending_added++;
          }
          continue; // Don't count pending as "added" — they're not in the ledger
        }

        // Cleared transaction → journal entry
        const existing = await tx.selectFrom('journal_entries')
          .where('plaid_transaction_id', '=', plaidTx.transaction_id)
          .select('id')
          .executeTakeFirst();

        if (existing) continue; // Skip duplicate

        // Secondary dedup: same bank account + date + amount + description,
        // OR same account + date (±1 day) + amount on a matchmaker-merged entry
        const fuzzyDupe = await tx.selectFrom('journal_lines as jl')
          .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
          .where('je.household_id', '=', householdId)
          .where('jl.account_id', '=', bankAccountId)
          .where('jl.amount', '=', -plaidTx.amount)
          .where((eb) => eb.or([
            // Exact match: same date + description (re-synced with new Plaid ID)
            eb.and([
              eb('je.date', '=', sql<Date>`${plaidTx.date}::date`),
              eb('je.description', '=', plaidTx.name),
            ]),
            // Matchmaker merge: same amount within ±1 day (description was renamed)
            eb.and([
              eb('je.source', '=', 'matchmaker'),
              eb('je.date', '>=', sql<Date>`(${plaidTx.date}::date - 1)`),
              eb('je.date', '<=', sql<Date>`(${plaidTx.date}::date + 1)`),
            ]),
          ]))
          .select('je.id')
          .executeTakeFirst();

        if (fuzzyDupe) continue; // Skip re-synced duplicate

        // Clean up any related pending row (Plaid sends old pending ID in `removed`
        // and new cleared ID in `added`, but the cleared tx may carry `pending_transaction_id`
        // linking to the old pending row)
        const pendingTxId = plaidTx.pending_transaction_id;
        if (pendingTxId) {
          await tx.deleteFrom('pending_transactions')
            .where('plaid_transaction_id', '=', pendingTxId)
            .execute();
        }

        await createJournalEntry(tx, householdId, plaidTx, bankAccountId, plaidCategory, uncatExpenseId, uncatIncomeId, accountOwnerMap.get(plaidTx.account_id) ?? null);
        added++;
      }

      // Process modified
      for (const plaidTx of data.modified) {
        const bankAccountId = accountMap.get(plaidTx.account_id);

        // Check if this was a pending transaction that just cleared
        const wasPending = await tx.selectFrom('pending_transactions')
          .where('plaid_transaction_id', '=', plaidTx.transaction_id)
          .select('id')
          .executeTakeFirst();

        if (wasPending) {
          if (plaidTx.pending) {
            // Still pending — update the staging row
            await tx.updateTable('pending_transactions')
              .set({
                date: plaidTx.date,
                name: plaidTx.name,
                merchant_name: plaidTx.merchant_name || null,
                amount: plaidTx.amount,
                updated_at: new Date().toISOString(),
              })
              .where('id', '=', wasPending.id)
              .execute();
          } else {
            // Pending → cleared: promote to journal entry
            if (!bankAccountId) {
              // Can't promote without a bank account — leave pending row intact
              accountMapMisses++;
              continue;
            }
            await tx.deleteFrom('pending_transactions')
              .where('id', '=', wasPending.id)
              .execute();

            const plaidCategory = plaidTx.personal_finance_category?.primary || null;
            await createJournalEntry(tx, householdId, plaidTx, bankAccountId, plaidCategory, uncatExpenseId, uncatIncomeId, accountOwnerMap.get(plaidTx.account_id) ?? null);
            added++;
          }
          modified++;
          continue;
        }

        // Existing journal entry modified (cleared → updated)
        const entry = await tx.selectFrom('journal_entries')
          .where('plaid_transaction_id', '=', plaidTx.transaction_id)
          .where('household_id', '=', householdId)
          .select('id')
          .executeTakeFirst();

        if (!entry) continue;

        await tx.updateTable('journal_entries')
          .set({
            description: plaidTx.name,
            merchant_name: plaidTx.merchant_name || null,
            date: plaidTx.date,
            updated_at: new Date().toISOString(),
          })
          .where('id', '=', entry.id)
          .execute();

        // Preserve user categorization: read existing category-side account_id
        if (bankAccountId) {
          const existingCategoryLine = await tx.selectFrom('journal_lines as jl')
            .innerJoin('accounts as a', 'a.id', 'jl.account_id')
            .where('jl.journal_entry_id', '=', entry.id)
            .where('a.account_type', 'in', ['expense', 'income'])
            .select(['jl.account_id'])
            .executeTakeFirst();

          let categoryAccountId: string;
          if (existingCategoryLine?.account_id) {
            const existingLine = await tx.selectFrom('journal_lines')
              .where('journal_entry_id', '=', entry.id)
              .where('account_id', '=', existingCategoryLine.account_id)
              .select('amount')
              .executeTakeFirst();
            const signFlipped = existingLine && ((existingLine.amount > 0) !== (plaidTx.amount > 0));
            categoryAccountId = signFlipped
              ? (plaidTx.amount > 0 ? uncatExpenseId : uncatIncomeId)
              : existingCategoryLine.account_id;
          } else {
            categoryAccountId = plaidTx.amount > 0 ? uncatExpenseId : uncatIncomeId;
          }

          await tx.deleteFrom('journal_lines')
            .where('journal_entry_id', '=', entry.id)
            .execute();

          await tx.insertInto('journal_lines').values([
            { id: nanoid(), journal_entry_id: entry.id, account_id: categoryAccountId, amount: plaidTx.amount, created_at: new Date().toISOString() },
            { id: nanoid(), journal_entry_id: entry.id, account_id: bankAccountId, amount: -plaidTx.amount, created_at: new Date().toISOString() },
          ]).execute();
        }

        modified++;
      }

      // Process removed — check both pending staging and journal
      for (const plaidTx of data.removed) {
        if (plaidTx.transaction_id) {
          // Check pending first
          const pendingRow = await tx.selectFrom('pending_transactions')
            .where('plaid_transaction_id', '=', plaidTx.transaction_id)
            .select('id')
            .executeTakeFirst();

          if (pendingRow) {
            await tx.deleteFrom('pending_transactions')
              .where('id', '=', pendingRow.id)
              .execute();
            removed++;
            continue;
          }

          // Then check journal — soft-delete (preserve audit trail)
          const entryToRemove = await tx.selectFrom('journal_entries')
            .where('plaid_transaction_id', '=', plaidTx.transaction_id)
            .where('household_id', '=', householdId)
            .select('id')
            .executeTakeFirst();

          if (entryToRemove) {
            await tx.updateTable('journal_entries')
              .set({
                exclude_from_totals: true,
                source: 'plaid_removed',
                is_verified: true,
                updated_at: new Date().toISOString(),
              })
              .where('id', '=', entryToRemove.id)
              .execute();
            removed++;
          }
        }
      }

      // Always update last_synced so monitoring stays fresh.
      // Only advance cursor if no accountMap misses — duplicates and
      // already-ingested data are safe to skip past, but misses represent
      // data we couldn't process and must retry.
      const cursorUpdate: Record<string, string | null> = {
        last_synced: new Date().toISOString(),
      };
      if (accountMapMisses === 0) {
        cursorUpdate.cursor = data.next_cursor || null;
      }
      await tx.updateTable('plaid_items')
        .set(cursorUpdate)
        .where('id', '=', plaidItemId)
        .execute();
    });

    if (accountMapMisses > 0) {
      // Hold cursor so next sync retries this page, but stop looping
      // to avoid hitting the same stuck page repeatedly in this run.
      // Item stays 'active' so cron/webhook/manual sync will retry.
      log.error(
        { itemId: plaidItemId, misses: accountMapMisses, added: data.added.length },
        'Transactions had no matching local account — holding cursor',
      );
      break;
    }
    cursor = data.next_cursor;
    hasMore = data.has_more;
  }

  // Refresh balances from Plaid — journal the RESIDUAL as unrealized gains
  try {
    const balancesResponse = await plaid.accountsGet({ access_token: accessToken });
    const adjustmentsId = await getOrCreateAccount('Unclassified Adjustments', 'income', { hidden: true, excludeFromTotals: true });

    await db.transaction().execute(async (tx) => {
      // Get pending transaction sums per account
      // Plaid's balance includes pending, our ledger doesn't — subtract pending to compare fairly
      const pendingSums = await tx.selectFrom('pending_transactions')
        .where('household_id', '=', householdId)
        .groupBy('account_id')
        .select([
          'account_id',
          sql<number>`COALESCE(SUM(amount), 0)`.as('pending_total'),
        ])
        .execute();
      const pendingByAccount = new Map(pendingSums.map(p => [p.account_id, Number(p.pending_total)]));

      for (const account of balancesResponse.data.accounts) {
        const localAccountId = accountMap.get(account.account_id);
        if (!localAccountId) continue;

        const acctInfo = await tx.selectFrom('accounts')
          .where('id', '=', localAccountId)
          .select(['account_type', 'name'])
          .executeTakeFirst();

        const accountType = acctInfo?.account_type || 'asset';

        // Adjust Plaid's balance by removing the effect of pending transactions
        // For assets: Plaid amount positive = money out = balance lower. Add back to undo.
        // For liabilities: Plaid amount positive = charge = balance higher. Subtract to undo.
        const pendingTotal = pendingByAccount.get(localAccountId) || 0;
        const pendingAdjustment = accountType === 'liability' ? -pendingTotal : pendingTotal;
        const newBalance = (account.balances.current || 0) + pendingAdjustment;

        const ledgerSum = await tx.selectFrom('journal_lines as jl')
          .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
          .where('jl.account_id', '=', localAccountId)
          .where(sql`COALESCE(je.exclude_from_totals, false)`, '=', false)
          .select(sql<number>`COALESCE(SUM(jl.amount), 0)`.as('total'))
          .executeTakeFirst();
        const ledgerBalance = accountType === 'liability'
          ? -Number(ledgerSum?.total || 0)
          : Number(ledgerSum?.total || 0);

        const residual = newBalance - ledgerBalance;

        if (Math.abs(residual) >= 0.10) {
          const today = new Date().toISOString().split('T')[0];
          const ledgerResidual = accountType === 'liability' ? -residual : residual;

          // One reconciliation entry per account per day — supersede any existing one
          const existingRecon = await tx.selectFrom('journal_entries as je')
            .innerJoin('journal_lines as jl', 'jl.journal_entry_id', 'je.id')
            .where('je.household_id', '=', householdId)
            .where('je.source', '=', 'plaid_reconciliation')
            .where(sql`je.date::text`, '=', today)
            .where('jl.account_id', '=', localAccountId)
            .select('je.id')
            .executeTakeFirst();

          const entryId = nanoid();

          // Create new reconciliation entry
          await tx.insertInto('journal_entries').values({
            id: entryId, household_id: householdId,
            date: today,
            description: `Balance reconciliation: ${acctInfo?.name || 'Unknown'}${account.mask ? ' ····' + account.mask : ''}`,
            merchant_name: null, notes: null, owner: null,
            is_verified: true, plaid_transaction_id: null,
            source: 'plaid_reconciliation',
            updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
          }).execute();

          await tx.insertInto('journal_lines').values([
            { id: nanoid(), journal_entry_id: entryId, account_id: localAccountId, amount: ledgerResidual, created_at: new Date().toISOString() },
            { id: nanoid(), journal_entry_id: entryId, account_id: adjustmentsId, amount: -ledgerResidual, created_at: new Date().toISOString() },
          ]).execute();

          // Supersede the old one (non-destructive — keeps audit trail)
          if (existingRecon) {
            await tx.updateTable('journal_entries')
              .set({
                superseded_by: entryId,
                exclude_from_totals: true,
                updated_at: new Date().toISOString(),
              })
              .where('id', '=', existingRecon.id)
              .execute();
          }
        }

        await tx.updateTable('accounts')
          .set({ updated_at: new Date().toISOString() })
          .where('id', '=', localAccountId)
          .execute();
      }
    });
  } catch (err) {
    log.error({ err }, 'Failed to refresh balances');
    throw err;
  }

  // Refresh liabilities data (APR, payments, due dates) for credit accounts
  try {
    const liabilitiesResponse = await plaid.liabilitiesGet({ access_token: accessToken });
    const creditCards = liabilitiesResponse.data.liabilities.credit || [];

    for (const cc of creditCards) {
      if (!cc.account_id) continue;
      const localId = accountMap.get(cc.account_id);
      if (!localId) continue;

      const purchaseApr = cc.aprs?.find(a => a.apr_type === 'purchase_apr');
      const cashApr = cc.aprs?.find(a => a.apr_type === 'cash_apr');

      await db.updateTable('accounts')
        .set({
          apr_purchase: purchaseApr?.apr_percentage || null,
          apr_cash: cashApr?.apr_percentage || null,
          last_payment_amount: cc.last_payment_amount || null,
          last_payment_date: cc.last_payment_date || null,
          minimum_payment: cc.minimum_payment_amount || null,
          next_payment_due_date: cc.next_payment_due_date || null,
          last_statement_balance: cc.last_statement_balance || null,
          is_overdue: cc.is_overdue || false,
        })
        .where('id', '=', localId)
        .execute();
    }
  } catch {
    // Liabilities product may not be available for this item — non-critical
  }

  return { added, modified, removed, pending_added };
}

/**
 * Sync a specific item (or all active items) for a household.
 * Called by: webhook handler, cron job, manual sync button.
 */
export async function syncAllItemsForHousehold(
  householdId: string,
  specificItemId?: string,
): Promise<{ added: number; modified: number; removed: number; pending_added: number }> {
  let items;
  if (specificItemId) {
    const item = await db
      .selectFrom('plaid_items')
      .where('id', '=', specificItemId)
      .where('household_id', '=', householdId)
      .where('status', '=', 'active')
      .select('id')
      .executeTakeFirst();
    items = item ? [item] : [];
  } else {
    items = await db
      .selectFrom('plaid_items')
      .where('household_id', '=', householdId)
      .where('status', '=', 'active')
      .select('id')
      .execute();
  }

  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;
  let totalPendingAdded = 0;

  for (const item of items) {
    try {
      const result = await syncItemTransactions(householdId, item.id);
      totalAdded += result.added;
      totalModified += result.modified;
      totalRemoved += result.removed;
      totalPendingAdded += result.pending_added;
    } catch (err: any) {
      log.error({ err, itemId: item.id }, 'Sync failed for item');
    }
  }

  // Run matchmaker if anything was added or modified
  if (totalAdded > 0 || totalModified > 0) {
    try {
      await runMatchmaker(db, householdId);
    } catch (err) {
      log.error({ err }, 'Matchmaker failed');
    }
  }

  return { added: totalAdded, modified: totalModified, removed: totalRemoved, pending_added: totalPendingAdded };
}

/**
 * Sync ALL households — used by the cron job.
 */
export async function syncAllHouseholds(): Promise<void> {
  const households = await db
    .selectFrom('plaid_items')
    .where('status', '=', 'active')
    .select('household_id')
    .distinct()
    .execute();

  log.info({ count: households.length }, 'Syncing households with active Plaid items');

  for (const { household_id } of households) {
    try {
      const result = await syncAllItemsForHousehold(household_id);
      if (result.added > 0 || result.modified > 0 || result.removed > 0) {
        log.info({ householdId: household_id, ...result }, 'Household sync complete');
      }
    } catch (err: any) {
      log.error({ err, householdId: household_id }, 'Household sync failed');
    }
  }
}
