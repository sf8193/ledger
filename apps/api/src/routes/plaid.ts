import { Router, type Router as RouterType } from 'express';
import { CountryCode, Products } from 'plaid';
import { db } from '../db/kysely';
import { nanoid } from 'nanoid';
import { asyncHandler } from '../middleware/error';
import { getPlaidClient, isPlaidConfigured } from '../lib/plaid';
import { encrypt, decrypt } from '../lib/crypto';
import { plaidExchangeSchema } from '../lib/validation';
import { runMatchmaker } from '../services/matchmaker';
import { syncItemTransactions } from '../services/sync';
import { getOrCreateEquityAccount } from '../lib/equity-account';
import { logger } from '../lib/logger';

export const plaidRouter: RouterType = Router();

plaidRouter.get('/status', (_req, res) => {
  res.json({
    configured: isPlaidConfigured(),
    environment: process.env.PLAID_ENV || 'sandbox',
  });
});

plaidRouter.get('/items', asyncHandler(async (req, res) => {
  const items = await db
    .selectFrom('plaid_items')
    .where('household_id', '=', req.householdId!)
    .select(['id', 'institution_id', 'institution_name', 'status', 'last_synced', 'logo', 'primary_color', 'created_at'])
    .orderBy('created_at', 'asc')
    .execute();
  res.json(items);
}));

plaidRouter.post('/link-token', asyncHandler(async (req, res) => {
  const plaid = getPlaidClient();
  const linkConfig: any = {
    user: { client_user_id: req.auth!.userId },
    client_name: 'Ledger',
    products: [Products.Transactions, Products.Liabilities],
    country_codes: [CountryCode.Us],
    language: 'en',
  };
  if (process.env.PLAID_WEBHOOK_URL) {
    linkConfig.webhook = process.env.PLAID_WEBHOOK_URL;
  }
  const response = await plaid.linkTokenCreate(linkConfig);
  res.json({ link_token: response.data.link_token });
}));

plaidRouter.post('/exchange', asyncHandler(async (req, res) => {
  const data = plaidExchangeSchema.parse(req.body);
  const plaid = getPlaidClient();

  const exchangeResponse = await plaid.itemPublicTokenExchange({
    public_token: data.public_token,
  });

  const accessToken = exchangeResponse.data.access_token;
  const itemId = exchangeResponse.data.item_id;

  // Fetch institution logo from Plaid
  let logo: string | null = null;
  let primaryColor: string | null = null;
  if (data.institution?.institution_id) {
    try {
      const instResp = await plaid.institutionsGetById({
        institution_id: data.institution.institution_id,
        country_codes: [CountryCode.Us],
        options: { include_optional_metadata: true },
      });
      logo = instResp.data.institution.logo || null;
      primaryColor = instResp.data.institution.primary_color || null;
    } catch {
      // Non-critical — proceed without logo
    }
  }

  const plaidItemId = nanoid();
  const upsertResult = await db.insertInto('plaid_items').values({
    id: plaidItemId,
    household_id: req.householdId!,
    institution_id: data.institution?.institution_id || null,
    institution_name: data.institution?.name || null,
    access_token_encrypted: encrypt(accessToken),
    item_id: itemId,
    cursor: null,
    last_synced: null,
    status: 'active',
    logo,
    primary_color: primaryColor,
    created_at: new Date().toISOString(),
  }).onConflict(oc =>
    oc.column('item_id').doUpdateSet({
      access_token_encrypted: encrypt(accessToken),
      institution_id: data.institution?.institution_id || null,
      institution_name: data.institution?.name || null,
      status: 'active',
      cursor: null,
      logo,
      primary_color: primaryColor,
    })
  ).returning('id').executeTakeFirstOrThrow();

  const effectiveItemId = upsertResult.id;

  // Fetch and store accounts
  const accountsResponse = await plaid.accountsGet({ access_token: accessToken });

  logger.info({
    linkMetadataAccounts: data.accounts,
    plaidAccounts: accountsResponse.data.accounts.map(a => ({
      id: a.account_id,
      name: a.name,
      official_name: a.official_name,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
      persistent_account_id: a.persistent_account_id,
      holder_category: a.holder_category,
      balances: {
        current: a.balances.current,
        available: a.balances.available,
        limit: a.balances.limit,
        iso_currency_code: a.balances.iso_currency_code,
      },
    })),
  }, 'Plaid account data — full dump');

  // Build a lookup from Link metadata (has real product names like "Freedom Flex")
  const linkNameByAccountId = new Map<string, string>();
  if (data.accounts) {
    for (const a of data.accounts) {
      linkNameByAccountId.set(a.id, a.name);
    }
  }

  // Create accounts + opening balance entries in one transaction
  await db.transaction().execute(async (tx) => {
    const equityId = await getOrCreateEquityAccount(tx, req.householdId!);

    // Pick the best name for each account: Link metadata > official_name > name
    function pickName(account: typeof accountsResponse.data.accounts[number]): string {
      return linkNameByAccountId.get(account.account_id)
        || account.official_name?.trim()
        || account.name;
    }

    // Detect duplicate names and append mask to disambiguate
    const nameCounts = new Map<string, number>();
    for (const account of accountsResponse.data.accounts) {
      const key = `${pickName(account)}|${['credit', 'loan'].includes(account.type) ? 'liability' : 'asset'}`;
      nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
    }

    for (const account of accountsResponse.data.accounts) {
      const accountType = ['credit', 'loan'].includes(account.type) ? 'liability' : 'asset';
      const bestName = pickName(account);
      const nameKey = `${bestName}|${accountType}`;
      const displayName = (nameCounts.get(nameKey) || 0) > 1 && account.mask
        ? `${bestName} (${account.mask})`
        : bestName;
      const accountId = nanoid();
      const balance = account.balances.current || 0;

      // Check if account already exists (by plaid_account_id, name+type, or mask+type for reconnects)
      const existing = await tx.selectFrom('accounts')
        .where('household_id', '=', req.householdId!)
        .where(eb => eb.or([
          eb('plaid_account_id', '=', account.account_id),
          eb.and([
            eb('name', '=', displayName),
            eb('account_type', '=', accountType),
          ]),
          ...(account.mask ? [eb.and([
            eb('mask', '=', account.mask),
            eb('account_type', '=', accountType),
            eb('subtype', '=', account.subtype || null),
            eb('institution_name', '=', data.institution?.name || null),
          ])] : []),
        ]))
        .select('id')
        .executeTakeFirst();

      if (existing) {
        await tx.updateTable('accounts').set({
          name: displayName,
          plaid_item_id: effectiveItemId,
          plaid_account_id: account.account_id,
          institution_name: data.institution?.name || null,
          mask: account.mask || null,
          subtype: account.subtype || null,
          credit_limit: account.balances.limit || null,
          updated_at: new Date().toISOString(),
        }).where('id', '=', existing.id).execute();
      } else {
        // Auto-classify tax treatment from Plaid subtype
        const sub = (account.subtype || '').toLowerCase();
        const nm = displayName.toLowerCase();
        let taxTreatment: string | null = null;
        if (sub.includes('roth') || nm.includes('roth')) taxTreatment = 'roth';
        else if (['ira', '401k', '401a', '403b', '457b', 'sep', 'simple', 'keogh', 'hsa'].includes(sub) || nm.includes('401k') || nm.includes('ira') || nm.includes('hsa')) taxTreatment = 'tax_deferred';
        else if (accountType === 'asset') taxTreatment = 'taxable';

        await tx.insertInto('accounts').values({
          id: accountId,
          household_id: req.householdId!,
          name: displayName,
          account_type: accountType,
          plaid_item_id: effectiveItemId,
          plaid_account_id: account.account_id,
          institution_name: data.institution?.name || null,
          mask: account.mask || null,
          subtype: account.subtype || null,
          tax_treatment: taxTreatment,
          credit_limit: account.balances.limit || null,
          is_hidden: false,
          icon: null, color: null, parent_id: null, sort_order: 0,
          is_manual: false, owner: null,
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        }).execute();

        // Opening balance journal entry (sign-aware for liabilities)
        if (Math.abs(balance) >= 0.01) {
          const ledgerAmount = accountType === 'liability' ? -balance : balance;
          const entryId = nanoid();
          await tx.insertInto('journal_entries').values({
            id: entryId, household_id: req.householdId!,
            date: new Date().toISOString().split('T')[0],
            description: `Opening balance: ${displayName}`,
            merchant_name: null, notes: null, owner: null,
            is_verified: true, plaid_transaction_id: null,
            source: 'plaid_opening_balance',
            updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
          }).execute();

          await tx.insertInto('journal_lines').values([
            { id: nanoid(), journal_entry_id: entryId, account_id: accountId, amount: ledgerAmount, created_at: new Date().toISOString() },
            { id: nanoid(), journal_entry_id: entryId, account_id: equityId, amount: -ledgerAmount, created_at: new Date().toISOString() },
          ]).execute();
        }
      }
    }
  });

  // Fetch and store liabilities data (after accounts exist)
  try {
    const liabilitiesResponse = await plaid.liabilitiesGet({ access_token: accessToken });
    const creditCards = liabilitiesResponse.data.liabilities.credit || [];
    logger.info({ credit: creditCards }, 'Plaid liabilities data');

    for (const cc of creditCards) {
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
        .where('plaid_account_id', '=', cc.account_id)
        .execute();
    }
  } catch (err) {
    logger.info({ err }, 'Plaid liabilities not available for this item');
  }

  await syncItemTransactions(req.householdId!, effectiveItemId);

  res.json({
    item_id: effectiveItemId,
    accounts: accountsResponse.data.accounts.length,
  });
}));

plaidRouter.post('/sync', asyncHandler(async (req, res) => {
  const items = await db
    .selectFrom('plaid_items')
    .where('household_id', '=', req.householdId!)
    .where('status', '=', 'active')
    .selectAll()
    .execute();

  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;
  const errors: Array<{ item_id: string; error: string }> = [];

  for (const item of items) {
    try {
      const result = await syncItemTransactions(req.householdId!, item.id);
      totalAdded += result.added;
      totalModified += result.modified;
      totalRemoved += result.removed;
    } catch (err: any) {
      logger.error({ err, itemId: item.id }, 'Sync failed for item');
      errors.push({ item_id: item.id, error: err.message });
    }
  }

  // Run matchmaker on newly synced transactions
  let matchResult = { transfer_suggestions: 0, entries_categorized: 0 };
  if (totalAdded > 0 || totalModified > 0) {
    try {
      matchResult = await runMatchmaker(db, req.householdId!);
    } catch (err) {
      logger.error({ err }, 'Matchmaker failed');
    }
  }

  res.json({
    items_synced: items.length - errors.length,
    transactions_added: totalAdded,
    transactions_modified: totalModified,
    transactions_removed: totalRemoved,
    ...matchResult,
    ...(errors.length > 0 && { errors }),
  });
}));

plaidRouter.delete('/:itemId', asyncHandler(async (req, res) => {
  const item = await db
    .selectFrom('plaid_items')
    .where('id', '=', req.params.itemId)
    .where('household_id', '=', req.householdId!)
    .selectAll()
    .executeTakeFirst();

  if (!item) {
    return res.status(404).json({ error: 'Item not found' });
  }

  try {
    const plaid = getPlaidClient();
    const accessToken = decrypt(item.access_token_encrypted);
    await plaid.itemRemove({ access_token: accessToken });
  } catch (err) {
    logger.error({ err }, 'Failed to remove item from Plaid');
  }

  await db.transaction().execute(async (tx) => {
    const linkedAccountIds = (await tx.selectFrom('accounts')
      .where('plaid_item_id', '=', item.id)
      .select('id')
      .execute()).map(a => a.id);

    if (linkedAccountIds.length > 0) {
      // Clean up pending transactions
      await tx.deleteFrom('pending_transactions')
        .where('account_id', 'in', linkedAccountIds)
        .execute();

      // Only delete Plaid-sourced journal entries; preserve manual ones
      const plaidEntryIds = (await tx.selectFrom('journal_lines')
        .innerJoin('journal_entries', 'journal_entries.id', 'journal_lines.journal_entry_id')
        .where('journal_lines.account_id', 'in', linkedAccountIds)
        .where('journal_entries.source', 'in', ['plaid', 'plaid_opening_balance', 'plaid_reconciliation', 'plaid_removed'])
        .select('journal_lines.journal_entry_id')
        .distinct()
        .execute()).map(r => r.journal_entry_id);

      if (plaidEntryIds.length > 0) {
        await tx.deleteFrom('journal_lines')
          .where('journal_entry_id', 'in', plaidEntryIds)
          .execute();

        await tx.deleteFrom('journal_entries')
          .where('id', 'in', plaidEntryIds)
          .execute();
      }

      // Check which accounts still have journal lines (from manual entries)
      const accountsWithManualLines = new Set(
        (await tx.selectFrom('journal_lines')
          .where('account_id', 'in', linkedAccountIds)
          .select('account_id')
          .distinct()
          .execute()).map(r => r.account_id)
      );

      const deletableAccountIds = linkedAccountIds.filter(id => !accountsWithManualLines.has(id));
      const unlinkAccountIds = linkedAccountIds.filter(id => accountsWithManualLines.has(id));

      // Fully delete accounts with no remaining references
      if (deletableAccountIds.length > 0) {
        await tx.deleteFrom('accounts')
          .where('id', 'in', deletableAccountIds)
          .execute();
      }

      // Unlink accounts that still have manual entries (preserve the data)
      if (unlinkAccountIds.length > 0) {
        await tx.updateTable('accounts')
          .set({ plaid_item_id: null, plaid_account_id: null })
          .where('id', 'in', unlinkAccountIds)
          .execute();
      }
    }

    await tx.deleteFrom('plaid_items')
      .where('id', '=', item.id)
      .execute();
  });

  res.json({ ok: true });
}));

