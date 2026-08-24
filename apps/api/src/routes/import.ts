import { Router, type Router as RouterType } from 'express';
import { db } from '../db/kysely';
import { sql } from 'kysely';
import { nanoid } from 'nanoid';
import { asyncHandler } from '../middleware/error';
import { parse } from 'csv-parse/sync';
import express from 'express';
import { getOrCreateEquityAccount } from '../lib/equity-account';
import type { AccountType } from '../db/types';
import { normalizeOwner } from '../lib/normalize-owner';

export const importRouter: RouterType = Router();

/** Check if a Plaid-synced entry already exists with same account, date (±1 day), and amount */
async function hasCrossSourceDuplicate(
  tx: any,
  householdId: string,
  accountId: string,
  date: string,
  amount: number,
): Promise<boolean> {
  const dateObj = new Date(date + 'T00:00:00Z');
  const dayBefore = new Date(dateObj.getTime() - 86400000).toISOString().slice(0, 10);
  const dayAfter = new Date(dateObj.getTime() + 86400000).toISOString().slice(0, 10);

  const match = await tx.selectFrom('journal_entries as je')
    .innerJoin('journal_lines as jl', 'jl.journal_entry_id', 'je.id')
    .where('je.household_id', '=', householdId)
    .where('je.source', '!=', 'monarch_import')
    .where('je.superseded_by', 'is', null)
    .where('jl.account_id', '=', accountId)
    .where('je.date', '>=', sql`${dayBefore}::date`)
    .where('je.date', '<=', sql`${dayAfter}::date`)
    .where(sql`ABS(jl.amount - ${amount})`, '<', 0.01)
    .select('je.id')
    .executeTakeFirst();

  return !!match;
}
importRouter.use(express.json({ limit: '20mb' }));

interface MonarchTransaction {
  Date: string;
  Merchant: string;
  Category: string;
  Account: string;
  'Original Statement': string;
  Notes: string;
  Amount: string;
  Tags: string;
  Owner: string;
  Reviewed: string;
  Id: string;
}

interface MonarchBalance {
  Date: string;
  Balance: string;
  Account: string;
}

// Import Monarch transactions CSV
// Preview: return Monarch account names so user can map them to existing Plaid accounts
importRouter.post('/monarch/preview', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;
  const csvData = req.body.csv as string;
  if (!csvData) return res.status(400).json({ error: 'csv field is required' });

  const rows: MonarchTransaction[] = parse(csvData, { columns: true, skip_empty_lines: true, trim: true });
  const monarchAccounts = [...new Set(rows.map(r => r.Account).filter(Boolean))];

  // Get existing accounts for mapping suggestions
  const existingAccounts = await db
    .selectFrom('accounts')
    .where('household_id', '=', householdId)
    .where('account_type', 'in', ['asset', 'liability'])
    .select(['id', 'name'])
    .execute();

  // Auto-match by exact name (case-insensitive)
  const suggestions: Record<string, string | null> = {};
  for (const ma of monarchAccounts) {
    const match = existingAccounts.find(ea => ea.name.toLowerCase() === ma.toLowerCase());
    suggestions[ma] = match?.id || null;
  }

  res.json({
    monarch_accounts: monarchAccounts,
    existing_accounts: existingAccounts,
    suggested_mapping: suggestions,
    transaction_count: rows.length,
    date_range: { min: rows[rows.length - 1]?.Date, max: rows[0]?.Date },
  });
}));

importRouter.post('/monarch/transactions', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;
  const csvData = req.body.csv as string;
  // Optional: map Monarch account names to existing account IDs (for cross-source dedup)
  const accountAliases = (req.body.account_map || {}) as Record<string, string>;

  if (!csvData) {
    return res.status(400).json({ error: 'csv field is required' });
  }

  const rows: MonarchTransaction[] = parse(csvData, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const uniqueAccounts = new Set(rows.map(r => r.Account).filter(Boolean));
  const uniqueCategories = new Set(rows.map(r => r.Category).filter(Boolean));

  let accountsCreated = 0;
  let categoriesCreated = 0;
  let imported = 0;
  let skipped = 0;
  let tagsCreated = 0;

  await db.transaction().execute(async (tx) => {
    // Step 1: Create/find bank accounts (asset/liability)
    const accountMap = new Map<string, string>();

    const existingAccounts = await tx
      .selectFrom('accounts')
      .where('household_id', '=', householdId)
      .where('account_type', 'in', ['asset', 'liability'])
      .select(['id', 'name'])
      .execute();

    for (const ea of existingAccounts) {
      accountMap.set(ea.name.toLowerCase(), ea.id);
    }

    // Apply account aliases: if user mapped a Monarch name to an existing account ID, use it
    for (const [monarchName, existingId] of Object.entries(accountAliases)) {
      if (existingId && !accountMap.has(monarchName.toLowerCase())) {
        accountMap.set(monarchName.toLowerCase(), existingId);
      }
    }

    for (const accountName of uniqueAccounts) {
      if (!accountMap.has(accountName.toLowerCase())) {
        const id = nanoid();
        const guessedType = guessAccountType(accountName);
        const accountType: AccountType = ['credit', 'loan'].includes(guessedType) ? 'liability' : 'asset';

        await tx.insertInto('accounts').values({
          id,
          household_id: householdId,
          name: accountName,
          account_type: accountType,
          plaid_item_id: null,
          plaid_account_id: null,
          institution_name: null,
          mask: null,
          subtype: null,
          is_hidden: false,
          icon: null,
          color: null,
          parent_id: null,
          sort_order: 0,
          is_manual: true,
          owner: null,
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        }).execute();
        accountMap.set(accountName.toLowerCase(), id);
        accountsCreated++;
      }
    }

    // Step 2: Create/find categories (expense/income accounts)
    const categoryMap = new Map<string, string>();

    const existingCategories = await tx
      .selectFrom('accounts')
      .where('household_id', '=', householdId)
      .where('account_type', 'in', ['expense', 'income'])
      .select(['id', 'name'])
      .execute();

    for (const ec of existingCategories) {
      categoryMap.set(ec.name.toLowerCase(), ec.id);
    }

    const incomeCategories = new Set([
      'Paychecks', 'Other Income', 'Interest', 'Dividends & Capital Gains',
      'Reimbursement', 'Returns', 'Sell', 'trading',
    ]);

    let sortOrder = existingCategories.length;
    for (const categoryName of uniqueCategories) {
      if (!categoryMap.has(categoryName.toLowerCase())) {
        const id = nanoid();
        await tx.insertInto('accounts').values({
          id,
          household_id: householdId,
          name: categoryName,
          account_type: (incomeCategories.has(categoryName) ? 'income' : 'expense') as AccountType,
          plaid_item_id: null,
          plaid_account_id: null,
          institution_name: null,
          mask: null,
          subtype: null,
          is_hidden: false,
          icon: null,
          color: null,
          parent_id: null,
          sort_order: sortOrder++,
          is_manual: false,
          owner: null,
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        }).execute();
        categoryMap.set(categoryName.toLowerCase(), id);
        categoriesCreated++;
      }
    }

    // Get/create Uncategorized account
    let uncatId = categoryMap.get('uncategorized');
    if (!uncatId) {
      uncatId = nanoid();
      await tx.insertInto('accounts').values({
        id: uncatId,
        household_id: householdId,
        name: 'Uncategorized',
        account_type: 'expense',
        plaid_item_id: null, plaid_account_id: null, institution_name: null,
        mask: null, subtype: null, is_hidden: false,
        icon: null, color: null, parent_id: null, sort_order: 9999,
        is_manual: false, owner: null,
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      }).execute();
      categoryMap.set('uncategorized', uncatId);
    }

    // Step 3: Separate transfers from regular transactions
    const transferCategories = new Set(['transfer', 'credit card payment']);
    const transferRows: MonarchTransaction[] = [];
    const regularRows: MonarchTransaction[] = [];

    for (const row of rows) {
      if (transferCategories.has(row.Category.toLowerCase())) {
        transferRows.push(row);
      } else {
        regularRows.push(row);
      }
    }

    // Step 3a: Pair transfers by date + opposite amounts
    // Get or create Equity:Suspense for unpaired transfers
    let suspenseId = await tx.selectFrom('accounts')
      .where('household_id', '=', householdId)
      .where('account_type', '=', 'equity')
      .where('name', '=', 'Suspense')
      .select('id')
      .executeTakeFirst();

    if (!suspenseId) {
      const sId = nanoid();
      await tx.insertInto('accounts').values({
        id: sId, household_id: householdId, name: 'Suspense',
        account_type: 'equity', plaid_item_id: null, plaid_account_id: null,
        institution_name: null, mask: null, subtype: null,
        is_hidden: false, icon: null, color: null, parent_id: null,
        sort_order: 9998, is_manual: false, owner: null,
        updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
      }).execute();
      suspenseId = { id: sId };
    }

    // Group transfers by date for pairing
    const transfersByDate = new Map<string, MonarchTransaction[]>();
    for (const row of transferRows) {
      const key = row.Date;
      const list = transfersByDate.get(key) || [];
      list.push(row);
      transfersByDate.set(key, list);
    }

    const pairedIds = new Set<string>();
    for (const [, dayTransfers] of transfersByDate) {
      // Try to pair: find two rows with opposite amounts on different accounts
      for (let i = 0; i < dayTransfers.length; i++) {
        if (pairedIds.has(dayTransfers[i].Id || `idx_${i}`)) continue;
        const amtA = parseFloat(dayTransfers[i].Amount);
        if (isNaN(amtA)) continue;
        const acctA = accountMap.get(dayTransfers[i].Account.toLowerCase());
        if (!acctA) continue;

        for (let j = i + 1; j < dayTransfers.length; j++) {
          if (pairedIds.has(dayTransfers[j].Id || `idx_${j}`)) continue;
          const amtB = parseFloat(dayTransfers[j].Amount);
          if (isNaN(amtB)) continue;
          const acctB = accountMap.get(dayTransfers[j].Account.toLowerCase());
          if (!acctB || acctB === acctA) continue;

          // Match: opposite amounts (within $0.01)
          if (Math.abs(amtA + amtB) < 0.01) {
            pairedIds.add(dayTransfers[i].Id || `idx_${i}`);
            pairedIds.add(dayTransfers[j].Id || `idx_${j}`);

            // Create asset↔asset entry (the positive-amount side is the destination)
            const entryId = nanoid();
            const dedupId = dayTransfers[i].Id ? `monarch_${dayTransfers[i].Id}` : null;

            if (dedupId) {
              const existing = await tx.selectFrom('journal_entries')
                .where('plaid_transaction_id', '=', dedupId).select('id').executeTakeFirst();
              if (existing) continue;
            }

            // Monarch: positive = money coming in, negative = money going out
            const fromAcct = amtA < 0 ? acctA : acctB;
            const toAcct = amtA > 0 ? acctA : acctB;
            const transferAmt = Math.abs(amtA);

            // Store both Monarch IDs for re-import dedup
            const partnerId = dayTransfers[j].Id ? `monarch_${dayTransfers[j].Id}` : null;
            const pairNote = partnerId ? `[paired: ${partnerId}]` : null;
            const notes = [dayTransfers[i].Notes, pairNote].filter(Boolean).join(' ') || null;

            await tx.insertInto('journal_entries').values({
              id: entryId, household_id: householdId, date: dayTransfers[i].Date,
              description: dayTransfers[i]['Original Statement'] || dayTransfers[i].Merchant || 'Transfer',
              merchant_name: null, notes,
              owner: normalizeOwner(dayTransfers[i].Owner), is_verified: false,
              plaid_transaction_id: dedupId, source: 'monarch_import',
              updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
            }).execute();

            await tx.insertInto('journal_lines').values([
              { id: nanoid(), journal_entry_id: entryId, account_id: toAcct, amount: transferAmt, created_at: new Date().toISOString() },
              { id: nanoid(), journal_entry_id: entryId, account_id: fromAcct, amount: -transferAmt, created_at: new Date().toISOString() },
            ]).execute();

            imported++;
            break; // Move to next i
          }
        }
      }

      // Unpaired transfers → Equity:Suspense
      for (let i = 0; i < dayTransfers.length; i++) {
        if (pairedIds.has(dayTransfers[i].Id || `idx_${i}`)) continue;
        const amt = parseFloat(dayTransfers[i].Amount);
        if (isNaN(amt)) { skipped++; continue; }
        const acct = accountMap.get(dayTransfers[i].Account.toLowerCase());
        if (!acct) { skipped++; continue; }

        const dedupId = dayTransfers[i].Id ? `monarch_${dayTransfers[i].Id}` : null;
        if (dedupId) {
          // Check if this ID is used as primary or partner in an existing entry
          const existing = await tx.selectFrom('journal_entries')
            .where('household_id', '=', householdId)
            .where((eb) => eb.or([
              eb('plaid_transaction_id', '=', dedupId),
              eb('notes', 'like', `%[paired: ${dedupId}]%`),
            ]))
            .select('id')
            .executeTakeFirst();
          if (existing) continue;
        }

        // Cross-source dedup for transfers
        if (await hasCrossSourceDuplicate(tx, householdId, acct, dayTransfers[i].Date, amt)) {
          skipped++;
          continue;
        }

        const entryId = nanoid();
        // Monarch sign already encodes direction: negative = money out, positive = money in
        // Bank line uses Monarch sign directly (negative = credit = money leaving)
        const bankAmt = amt; // Monarch -500 → credit bank -500 (money out) ✓
        const suspenseAmt = -amt; // Opposite side on suspense

        await tx.insertInto('journal_entries').values({
          id: entryId, household_id: householdId, date: dayTransfers[i].Date,
          description: dayTransfers[i]['Original Statement'] || dayTransfers[i].Merchant || 'Unmatched Transfer',
          merchant_name: null, notes: dayTransfers[i].Notes || null,
          owner: normalizeOwner(dayTransfers[i].Owner), is_verified: false,
          plaid_transaction_id: dedupId, source: 'monarch_import',
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        }).execute();

        await tx.insertInto('journal_lines').values([
          { id: nanoid(), journal_entry_id: entryId, account_id: acct, amount: bankAmt, created_at: new Date().toISOString() },
          { id: nanoid(), journal_entry_id: entryId, account_id: suspenseId.id, amount: suspenseAmt, created_at: new Date().toISOString() },
        ]).execute();

        imported++;
      }
    }

    // Step 3b: Import regular (non-transfer) transactions
    for (const row of regularRows) {
        const bankAccountId = accountMap.get(row.Account.toLowerCase());
        if (!bankAccountId || !row.Date) {
          skipped++;
          continue;
        }

        const amount = parseFloat(row.Amount);
        if (isNaN(amount)) {
          skipped++;
          continue;
        }

        const dedupId = row.Id ? `monarch_${row.Id}` : null;
        const categoryAccountId = categoryMap.get(row.Category.toLowerCase()) || uncatId;
        const entryId = nanoid();

        const expenseAmount = -amount;

        // Check for duplicate before inserting
        if (dedupId) {
          const existing = await tx.selectFrom('journal_entries')
            .where('plaid_transaction_id', '=', dedupId)
            .select('id')
            .executeTakeFirst();
          if (existing) continue; // Skip Monarch re-import duplicate
        }

        // Cross-source dedup: skip if a Plaid entry already exists with same account/date/amount
        if (await hasCrossSourceDuplicate(tx, householdId, bankAccountId, row.Date, amount)) {
          skipped++;
          continue;
        }

        await tx.insertInto('journal_entries').values({
          id: entryId,
          household_id: householdId,
          date: row.Date,
          description: row['Original Statement'] || row.Merchant || 'Unknown',
          merchant_name: row.Merchant || null,
          notes: row.Notes || null,
          owner: normalizeOwner(row.Owner),
          is_verified: false,
          plaid_transaction_id: dedupId,
          source: 'monarch_import',
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        }).execute();

        await tx.insertInto('journal_lines').values([
          {
            id: nanoid(),
            journal_entry_id: entryId,
            account_id: categoryAccountId,
            amount: expenseAmount, // debit expense or credit income
            created_at: new Date().toISOString(),
          },
          {
            id: nanoid(),
            journal_entry_id: entryId,
            account_id: bankAccountId,
            amount: -expenseAmount, // opposite side on bank account
            created_at: new Date().toISOString(),
          },
        ]).execute();

        // Import tags from Monarch CSV
        if (row.Tags) {
          const tagNames = row.Tags.split(',').map(t => t.trim()).filter(Boolean);
          for (const tagName of tagNames) {
            // Get or create tag (case-insensitive match)
            let tag = await tx.selectFrom('tags')
              .where('household_id', '=', householdId)
              .where(sql`LOWER(name)`, '=', tagName.toLowerCase())
              .select('id')
              .executeTakeFirst();

            if (!tag) {
              const tagId = nanoid();
              await tx.insertInto('tags').values({
                id: tagId,
                household_id: householdId,
                name: tagName,
                created_at: new Date().toISOString(),
              }).execute();
              tag = { id: tagId };
              tagsCreated++;
            }

            await tx.insertInto('journal_entry_tags').values({
              journal_entry_id: entryId,
              tag_id: tag.id,
            }).execute();
          }
        }

        imported++;
    }
  });

  res.json({
    accounts_created: accountsCreated,
    categories_created: categoriesCreated,
    tags_created: tagsCreated,
    transactions_imported: imported,
    transactions_skipped: skipped,
  });
}));

// Import Monarch balances CSV
importRouter.post('/monarch/balances', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;
  const csvData = req.body.csv as string;

  if (!csvData) {
    return res.status(400).json({ error: 'csv field is required' });
  }

  const rows: MonarchBalance[] = parse(csvData, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  let accountsCreated = 0;
  let imported = 0;
  let skipped = 0;

  await db.transaction().execute(async (tx) => {
    const existingAccounts = await tx
      .selectFrom('accounts')
      .where('household_id', '=', householdId)
      .where('account_type', 'in', ['asset', 'liability'])
      .select(['id', 'name', 'account_type'])
      .execute();

    const accountMap = new Map(existingAccounts.map(a => [a.name.toLowerCase(), a.id]));
    const accountTypeMap = new Map(existingAccounts.map(a => [a.name.toLowerCase(), a.account_type]));

    const uniqueBalanceAccounts = new Set(rows.map(r => r.Account).filter(Boolean));
    for (const accountName of uniqueBalanceAccounts) {
      if (!accountMap.has(accountName.toLowerCase())) {
        const id = nanoid();
        const guessedType = guessAccountType(accountName);
        const accountType: AccountType = ['credit', 'loan'].includes(guessedType) ? 'liability' : 'asset';
        accountTypeMap.set(accountName.toLowerCase(), accountType);

        await tx.insertInto('accounts').values({
          id,
          household_id: householdId,
          name: accountName,
          account_type: accountType,
          plaid_item_id: null, plaid_account_id: null, institution_name: null,
          mask: null, subtype: null, is_hidden: false,
          icon: null, color: null, parent_id: null, sort_order: 0,
          is_manual: true, owner: null,
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        }).execute();
        accountMap.set(accountName.toLowerCase(), id);
        accountsCreated++;
      }
    }

    // Import balance snapshots
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const accountId = accountMap.get(row.Account.toLowerCase());
      if (!accountId || !row.Date) {
        skipped++;
        continue;
      }

      let balance = parseFloat(row.Balance);
      if (isNaN(balance)) {
        skipped++;
        continue;
      }

      // Normalize: Monarch stores liabilities as negative, we store as positive
      const acctType = accountTypeMap.get(row.Account.toLowerCase()) || 'asset';
      if (acctType === 'liability' && balance < 0) {
        balance = -balance;
      }

      await tx.insertInto('balance_snapshots').values({
        id: nanoid(),
        household_id: householdId,
        account_id: accountId,
        date: row.Date,
        balance,
        created_at: new Date().toISOString(),
      }).onConflict(oc => oc.columns(['account_id', 'date']).doUpdateSet({
        balance,
      })).execute();

      imported++;
    }

    const equityId = await getOrCreateEquityAccount(tx, householdId);

    for (const [accountName, accountId] of accountMap) {
      // Get earliest and latest snapshots
      const earliest = await tx
        .selectFrom('balance_snapshots')
        .where('account_id', '=', accountId)
        .orderBy('date', 'asc')
        .select(['balance', 'date'])
        .limit(1)
        .executeTakeFirst();

      const latest = await tx
        .selectFrom('balance_snapshots')
        .where('account_id', '=', accountId)
        .orderBy('date', 'desc')
        .select(['balance'])
        .limit(1)
        .executeTakeFirst();

      if (latest) {
        await tx.updateTable('accounts')
          .set({
            updated_at: new Date().toISOString(),
          })
          .where('id', '=', accountId)
          .execute();
      }

      // Create ONE opening balance entry at the earliest snapshot date (dedup on re-import)
      const existingOpening = await tx.selectFrom('journal_entries as je')
        .innerJoin('journal_lines as jl', 'jl.journal_entry_id', 'je.id')
        .where('je.household_id', '=', householdId)
        .where('je.source', '=', 'monarch_opening_balance')
        .where('jl.account_id', '=', accountId)
        .select('je.id')
        .executeTakeFirst();

      if (!existingOpening && earliest && Math.abs(Number(earliest.balance)) >= 0.01) {
        const acctType = accountTypeMap.get(accountName.toLowerCase()) || 'asset';
        const ledgerAmount = acctType === 'liability' ? -Number(earliest.balance) : Number(earliest.balance);

        const entryId = nanoid();
        await tx.insertInto('journal_entries').values({
          id: entryId, household_id: householdId,
          date: String(earliest.date),
          description: `Opening balance: ${accountName}`,
          merchant_name: null, notes: null, owner: null,
          is_verified: true, plaid_transaction_id: null,
          source: 'monarch_opening_balance',
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        }).execute();

        await tx.insertInto('journal_lines').values([
          { id: nanoid(), journal_entry_id: entryId, account_id: accountId, amount: ledgerAmount, created_at: new Date().toISOString() },
          { id: nanoid(), journal_entry_id: entryId, account_id: equityId, amount: -ledgerAmount, created_at: new Date().toISOString() },
        ]).execute();
      }
    }
  });

  res.json({
    accounts_created: accountsCreated,
    snapshots_imported: imported,
    snapshots_skipped: skipped,
  });
}));

function guessAccountType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('checking') || lower.includes('hsa') || lower.includes('certificate of deposit')) return 'depository';
  if (lower.includes('ira') || lower.includes('roth') || lower.includes('401') || lower.includes('individual') || lower.includes('savings plan') || lower.includes('retirement')) return 'investment';
  if (lower.includes('savings')) return 'depository';
  if (lower.includes('mortgage') || lower.includes('loan') || lower.includes('student')) return 'loan';
  if (lower.includes('visa') || lower.includes('mastercard') || lower.includes('credit card') || lower.includes('ink') || lower.includes('sapphire') || lower.includes('freedom') || lower.includes('venture') || lower.includes('prime') || lower.includes('explorer') || lower.includes('united')) return 'credit';
  return 'manual';
}
