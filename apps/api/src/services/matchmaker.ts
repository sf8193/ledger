import { Kysely, sql } from 'kysely';
import { Database } from '../db/types';
import { nanoid } from 'nanoid';
import { mapPlaidCategory, TRANSFER_CATEGORIES } from './plaid-categories';
import { logger } from '../lib/logger';

const log = logger.child({ context: 'matchmaker' });

/**
 * Post-sync matchmaking service. Runs after Plaid sync to:
 * 1. Auto-categorize from Plaid's category taxonomy
 * 2. Auto-categorize using user-defined category_rules (overrides Plaid)
 * 3. Detect transfers → auto-merge or create suggestions
 *
 * Never touches verified entries or entries with existing suggestions,
 * except verified entries in Uncategorized/Transfers (likely orphans from
 * reconnection) — these are matched via suggestions, never auto-merged.
 */

export interface MatchResult {
  plaid_categorized: number;
  transfers_auto_merged: number;
  transfer_suggestions: number;
  transfers_routed: number;
  entries_categorized: number;
  uncategorized_remaining: number;
}

interface UncategorizedEntry {
  entry_id: string;
  date: string;
  description: string;
  merchant_name: string | null;
  plaid_category: string | null;
  bank_account_id: string;
  bank_account_type: string;
  bank_institution: string | null;
  category_line_id: string;
  category_account_id: string;
  amount: number;
  is_verified: boolean;
}

/**
 * Run all matchmaking passes on a household's uncategorized entries.
 */
export async function runMatchmaker(
  db: Kysely<Database>,
  householdId: string,
): Promise<MatchResult> {
  const result: MatchResult = {
    plaid_categorized: 0,
    transfers_auto_merged: 0,
    transfer_suggestions: 0,
    transfers_routed: 0,
    entries_categorized: 0,
    uncategorized_remaining: 0,
  };

  const uncategorized = await loadEntries(db, householdId, { uncategorizedOnly: true });
  if (uncategorized.length === 0) return result;

  // Pass 1: Plaid taxonomy → bulk auto-categorize uncategorized entries
  result.plaid_categorized = await applyPlaidCategories(db, householdId, uncategorized);

  // Pass 1.5: Merchant history — if the same merchant was previously categorized, reuse it
  const afterPlaidCat = await loadEntries(db, householdId, { uncategorizedOnly: true });
  result.plaid_categorized += await applyMerchantHistory(db, householdId, afterPlaidCat);

  // Pass 2: Transfer detection — also scans Transfers account for late-arriving counterparts
  const afterPlaid = await loadEntries(db, householdId, { uncategorizedOnly: true, includeTransfers: true });
  const transferResult = await detectTransfers(db, householdId, afterPlaid);
  result.transfers_auto_merged = transferResult.autoMerged;
  result.transfer_suggestions = transferResult.suggestions;

  // Pass 2.5: Route unmatched transfers → any entry still uncategorized with a transfer
  // Plaid category gets moved to "Transfers" so it doesn't inflate spending.
  const afterTransfers = await loadEntries(db, householdId, { uncategorizedOnly: true });
  result.transfers_routed = await routeUnmatchedTransfers(db, householdId, afterTransfers);

  // Pass 3: User rules → final authority, overrides any category on all unverified entries
  const allUnverified = await loadEntries(db, householdId, { uncategorizedOnly: false });
  result.entries_categorized = await applyCategoryRules(db, householdId, allUnverified);

  // Pass 4: Surface leftovers → count entries still uncategorized after all passes
  const leftovers = await loadEntries(db, householdId, { uncategorizedOnly: true });
  result.uncategorized_remaining = leftovers.length;

  log.info({ householdId, ...result }, 'Matchmaker complete');

  return result;
}

/**
 * Load unverified journal entries with their category-side (expense/income) line.
 *
 * uncategorizedOnly=true: only entries pointing at Uncategorized/Uncategorized Income,
 *   excluding entries with pending/confirmed match suggestions.
 *   Used by Plaid categorization, merchant history, and transfer detection.
 *
 * uncategorizedOnly=false: all unverified entries with any expense/income category line.
 *   Used by user-defined rules which can override any category.
 */
async function loadEntries(
  db: Kysely<Database>,
  householdId: string,
  opts: { uncategorizedOnly: boolean; includeTransfers?: boolean },
): Promise<UncategorizedEntry[]> {
  let query = db
    .selectFrom('journal_entries as je')
    .innerJoin('journal_lines as cat_line', (join) =>
      join.onRef('cat_line.journal_entry_id', '=', 'je.id')
    )
    .innerJoin('accounts as cat_acct', 'cat_acct.id', 'cat_line.account_id')
    .innerJoin('journal_lines as bank_line', (join) =>
      join
        .onRef('bank_line.journal_entry_id', '=', 'je.id')
        .on('bank_line.id', '!=', sql.ref('cat_line.id'))
    )
    .innerJoin('accounts as bank_acct', 'bank_acct.id', 'bank_line.account_id')
    .where('je.household_id', '=', householdId)
    .where('je.superseded_by', 'is', null)
    .where('bank_acct.account_type', 'in', ['asset', 'liability']);

  if (opts.uncategorizedOnly) {
    const uncatAccounts = await db
      .selectFrom('accounts')
      .where('household_id', '=', householdId)
      .where('account_type', 'in', ['expense', 'income'])
      .where((eb) =>
        eb.or([
          eb('name', '=', 'Uncategorized'),
          eb('name', '=', 'Uncategorized Income'),
        ])
      )
      .select('id')
      .execute();

    if (uncatAccounts.length === 0) return [];
    const uncatIds = uncatAccounts.map(a => a.id);

    // Optionally include entries routed to Transfers by a previous run's pass 2.5
    let targetIds = [...uncatIds];
    if (opts.includeTransfers) {
      const transfersAccounts = await db
        .selectFrom('accounts')
        .where('household_id', '=', householdId)
        .where('name', '=', 'Transfers')
        .where('account_type', 'in', ['expense', 'income'])
        .select('id')
        .execute();
      targetIds = [...uncatIds, ...transfersAccounts.map(a => a.id)];
    }

    // Entries in Uncategorized/Transfers are eligible regardless of is_verified —
    // verified entries in these accounts are orphans from lost merges.
    // Properly verified entries have a real category and never appear here.
    query = query
      .where('cat_line.account_id', 'in', targetIds)
      // Exclude entries with pending/confirmed suggestions
      .where('je.id', 'not in',
        db.selectFrom('match_suggestions')
          .where('household_id', '=', householdId)
          .where('status', 'in', ['pending', 'confirmed'])
          .select('entry_a_id')
      )
      .where('je.id', 'not in',
        db.selectFrom('match_suggestions')
          .where('household_id', '=', householdId)
          .where('status', 'in', ['pending', 'confirmed'])
          .where('entry_b_id', 'is not', null)
          .select('entry_b_id as id')
      )
      .orderBy('je.date', 'asc')
      .orderBy('je.id', 'asc');
  } else {
    query = query
      .where('je.is_verified', '=', false)
      .where('cat_acct.account_type', 'in', ['expense', 'income'])
      .orderBy('je.date', 'asc')
      .orderBy('je.id', 'asc');
  }

  const rows = await query
    .orderBy('cat_line.id', 'asc')
    .select([
      'je.id as entry_id',
      sql<string>`je.date::text`.as('date'),
      'je.description',
      'je.merchant_name',
      'je.plaid_category',
      'bank_line.account_id as bank_account_id',
      'bank_acct.account_type as bank_account_type',
      'bank_acct.institution_name as bank_institution',
      'cat_line.id as category_line_id',
      'cat_line.account_id as category_account_id',
      'cat_line.amount as amount',
      'je.is_verified',
    ])
    .execute();

  // Dedup by entry_id — self-join can produce multiple rows for 3+ line entries
  const seen = new Set<string>();
  return rows
    .map(r => ({
      entry_id: r.entry_id,
      date: r.date,
      description: r.description,
      merchant_name: r.merchant_name,
      plaid_category: r.plaid_category,
      bank_account_id: r.bank_account_id,
      bank_account_type: r.bank_account_type as string,
      bank_institution: r.bank_institution,
      category_line_id: r.category_line_id,
      category_account_id: r.category_account_id,
      amount: Number(r.amount),
      is_verified: r.is_verified as boolean,
    }))
    .filter(r => {
      if (seen.has(r.entry_id)) return false;
      seen.add(r.entry_id);
      return true;
    });
}

// Use the shared TRANSFER_CATEGORIES from plaid-categories.ts
// (imported above — single source of truth for transfer category detection)

const TRANSFER_DESCRIPTION_KEYWORDS = [
  'transfer', 'xfer', 'autopay', 'payment thank you',
  'online payment', 'ach payment', 'direct debit',
  'wire transfer', 'zelle', 'venmo',
];

function isPlaidTransfer(category: string | null): boolean {
  if (!category) return false;
  return TRANSFER_CATEGORIES.has(category);
}

function looksLikeTransferDescription(desc: string): boolean {
  const lower = desc.toLowerCase();
  return TRANSFER_DESCRIPTION_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Detect transfers between bank accounts.
 *
 * Three tiers:
 * 1. Both entries have Plaid transfer category → auto-merge (no suggestion)
 * 2. One Plaid transfer category + description match → high-confidence suggestion
 * 3. Amount + date match only → lower-confidence suggestion
 */
async function detectTransfers(
  db: Kysely<Database>,
  householdId: string,
  entries: UncategorizedEntry[],
): Promise<{ autoMerged: number; suggestions: number }> {
  const AUTO_MERGE_THRESHOLD = 0.90;
  const matched = new Set<string>();
  let autoMerged = 0;
  let suggestions = 0;

  // Exclude entries already in pending/confirmed suggestions
  const existingSuggestionEntries = await db
    .selectFrom('match_suggestions')
    .where('household_id', '=', householdId)
    .where('status', 'in', ['pending', 'confirmed'])
    .where('entry_b_id', 'is not', null)
    .select('entry_b_id')
    .execute();
  const excludedIds = new Set(existingSuggestionEntries.map(s => s.entry_b_id!));

  // Track dismissed pairs so we don't re-propose the same match
  const dismissedSuggestions = await db
    .selectFrom('match_suggestions')
    .where('household_id', '=', householdId)
    .where('status', '=', 'dismissed')
    .where('entry_b_id', 'is not', null)
    .select(['entry_a_id', 'entry_b_id'])
    .execute();
  const dismissedPairs = new Set(
    dismissedSuggestions.map(s => `${s.entry_a_id}:${s.entry_b_id}`),
  );
  const isDismissedPair = (idA: string, idB: string) =>
    dismissedPairs.has(`${idA}:${idB}`) || dismissedPairs.has(`${idB}:${idA}`);

  for (let i = 0; i < entries.length; i++) {
    if (matched.has(entries[i].entry_id)) continue;
    if (excludedIds.has(entries[i].entry_id)) continue;
    const a = entries[i];

    let bestMatch: { entry: UncategorizedEntry; confidence: number } | null = null;

    for (let j = i + 1; j < entries.length; j++) {
      if (matched.has(entries[j].entry_id)) continue;
      if (excludedIds.has(entries[j].entry_id)) continue;
      const b = entries[j];

      if (a.bank_account_id === b.bank_account_id) continue;
      if (Math.abs(a.amount + b.amount) >= 0.01) continue;
      if (isDismissedPair(a.entry_id, b.entry_id)) continue;

      const dayDiff = Math.abs(
        (new Date(a.date).getTime() - new Date(b.date).getTime()) / (1000 * 60 * 60 * 24)
      );
      if (dayDiff > 5) continue;

      // --- Confidence scoring ---
      const aIsPlaidTransfer = isPlaidTransfer(a.plaid_category);
      const bIsPlaidTransfer = isPlaidTransfer(b.plaid_category);
      const aDescTransfer = looksLikeTransferDescription(a.description);
      const bDescTransfer = looksLikeTransferDescription(b.description);

      let confidence = 0.50;

      // Plaid category is the strongest signal
      if (aIsPlaidTransfer && bIsPlaidTransfer) {
        confidence = 0.98; // Near-certain: Plaid tagged both sides
      } else if (aIsPlaidTransfer || bIsPlaidTransfer) {
        confidence = 0.85; // One side tagged by Plaid
      }

      // Description keywords as secondary signal
      if (aDescTransfer || bDescTransfer) {
        confidence = Math.max(confidence, 0.70);
        if ((aIsPlaidTransfer || bIsPlaidTransfer) && (aDescTransfer || bDescTransfer)) {
          confidence = Math.max(confidence, 0.92);
        }
      }

      // Date proximity
      if (dayDiff <= 1) confidence += 0.05;
      else if (dayDiff > 3) confidence -= 0.10;

      // Same institution
      if (a.bank_institution && b.bank_institution && a.bank_institution === b.bank_institution) {
        confidence += 0.05;
      }

      // If either entry is user-verified, cap below auto-merge threshold to force
      // a suggestion. Verified entries in Uncategorized/Transfers are likely orphans,
      // but the user explicitly marked them — give them a confirmation step.
      if (a.is_verified || b.is_verified) {
        confidence = Math.min(confidence, AUTO_MERGE_THRESHOLD - 0.01);
      }

      confidence = Math.min(Math.max(confidence, 0), 1.0);

      if (!bestMatch || confidence > bestMatch.confidence) {
        bestMatch = { entry: b, confidence };
      }
    }

    if (bestMatch) {
      matched.add(a.entry_id);
      matched.add(bestMatch.entry.entry_id);

      const isCC = (a.bank_account_type === 'asset' && bestMatch.entry.bank_account_type === 'liability') ||
                   (a.bank_account_type === 'liability' && bestMatch.entry.bank_account_type === 'asset');

      // Auto-merge if confidence >= AUTO_MERGE_THRESHOLD
      if (bestMatch.confidence >= AUTO_MERGE_THRESHOLD) {
        await mergeTransferEntries(db, a, bestMatch.entry, isCC ? 'CC Payment' : 'Transfer', householdId);
        autoMerged++;
      } else {
        // Create a suggestion for user review
        await db.insertInto('match_suggestions').values({
          id: nanoid(),
          household_id: householdId,
          match_type: isCC ? 'cc_payment' : 'transfer',
          entry_a_id: a.entry_id,
          entry_b_id: bestMatch.entry.entry_id,
          confidence: bestMatch.confidence,
          status: 'pending',
          metadata: JSON.stringify({
            amount: Math.abs(a.amount),
            date_a: a.date,
            date_b: bestMatch.entry.date,
            account_a: a.bank_account_id,
            account_b: bestMatch.entry.bank_account_id,
          }),
          created_at: new Date().toISOString(),
        }).execute();

        suggestions++;
      }
    }
  }

  return { autoMerged, suggestions };
}

/**
 * Merge two transfer entries into one.
 * Creates a NEW transfer entry with two bank-side lines,
 * then marks both originals as superseded (non-destructive).
 */
async function mergeTransferEntries(
  db: Kysely<Database>,
  a: UncategorizedEntry,
  b: UncategorizedEntry,
  label: string,
  householdId: string,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const earlier = new Date(a.date) <= new Date(b.date) ? a : b;

    // Create new transfer entry
    const newEntryId = nanoid();
    await tx.insertInto('journal_entries').values({
      id: newEntryId,
      household_id: householdId,
      date: earlier.date,
      description: `${label}: ${earlier.description}`,
      merchant_name: earlier.merchant_name,
      notes: `Auto-matched from entries`,
      owner: null,
      is_verified: true,
      plaid_transaction_id: null,
      source: 'matchmaker',
      categorized_by: 'transfer-match',
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }).execute();

    // Create two bank-side lines on the new entry
    // a's bank side had amount = -a.amount (opposite of category side)
    // b's bank side had amount = -b.amount
    await tx.insertInto('journal_lines').values([
      {
        id: nanoid(),
        journal_entry_id: newEntryId,
        account_id: a.bank_account_id,
        amount: -a.amount,
        created_at: new Date().toISOString(),
      },
      {
        id: nanoid(),
        journal_entry_id: newEntryId,
        account_id: b.bank_account_id,
        amount: -b.amount,
        created_at: new Date().toISOString(),
      },
    ]).execute();

    // Supersede both originals (non-destructive)
    await tx.updateTable('journal_entries')
      .set({
        superseded_by: newEntryId,
        exclude_from_totals: true,
        is_verified: true,
        updated_at: new Date().toISOString(),
      })
      .where('id', 'in', [a.entry_id, b.entry_id])
      .execute();
  });
}

/**
 * Route remaining uncategorized entries that have a transfer Plaid category
 * to a "Transfers" account. This catches single-sided transfers that
 * detectTransfers couldn't pair (e.g. mortgage payments, brokerage moves
 * where the other side isn't connected).
 */
async function routeUnmatchedTransfers(
  db: Kysely<Database>,
  householdId: string,
  entries: UncategorizedEntry[],
): Promise<number> {
  const transferEntries = entries.filter(e => isPlaidTransfer(e.plaid_category));
  if (transferEntries.length === 0) return 0;

  // Get or create "Transfers" account (not expense — won't inflate spending)
  let transferAccount = await db.selectFrom('accounts')
    .where('household_id', '=', householdId)
    .where('name', '=', 'Transfers')
    .where('account_type', 'in', ['expense', 'income'])
    .select('id')
    .executeTakeFirst();

  if (transferAccount) {
    // Ensure flags are set even on pre-existing account
    await db.updateTable('accounts')
      .set({ is_hidden: true, exclude_from_totals: true })
      .where('id', '=', transferAccount.id)
      .execute();
  } else {
    const id = nanoid();
    await db.insertInto('accounts').values({
      id,
      household_id: householdId,
      name: 'Transfers',
      account_type: 'expense',
      plaid_item_id: null,
      plaid_account_id: null,
      institution_name: null,
      mask: null,
      subtype: null,
      is_hidden: true,
      exclude_from_totals: true,
      icon: null,
      color: null,
      parent_id: null,
      sort_order: 9998,
      is_manual: false,
      owner: null,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }).execute();
    transferAccount = { id };
  }

  const lineIds = transferEntries.map(e => e.category_line_id);
  await db.updateTable('journal_lines')
    .set({ account_id: transferAccount.id })
    .where('id', 'in', lineIds)
    .execute();

  return transferEntries.length;
}

/**
 * Auto-categorize entries by looking at how the same merchant_name was
 * categorized in previous verified or already-categorized entries.
 * Only applies when the merchant has been consistently categorized
 * (single category for that merchant).
 */
async function applyMerchantHistory(
  db: Kysely<Database>,
  householdId: string,
  entries: UncategorizedEntry[],
): Promise<number> {
  const withMerchant = entries.filter(e => e.merchant_name);
  if (withMerchant.length === 0) return 0;

  const merchantNames = [...new Set(withMerchant.map(e => e.merchant_name!))];

  // Find the most common non-uncategorized category for each merchant
  const uncatAccounts = await db
    .selectFrom('accounts')
    .where('household_id', '=', householdId)
    .where('account_type', 'in', ['expense', 'income'])
    .where((eb) =>
      eb.or([
        eb('name', '=', 'Uncategorized'),
        eb('name', '=', 'Uncategorized Income'),
      ])
    )
    .select('id')
    .execute();
  const uncatIds = new Set(uncatAccounts.map(a => a.id));

  const history = await db
    .selectFrom('journal_entries as je')
    .innerJoin('journal_lines as jl', 'jl.journal_entry_id', 'je.id')
    .innerJoin('accounts as a', 'a.id', 'jl.account_id')
    .where('je.household_id', '=', householdId)
    .where('je.merchant_name', 'in', merchantNames)
    .where('a.account_type', 'in', ['expense', 'income'])
    .where('je.superseded_by', 'is', null)
    .where(eb => eb.or([
      eb('je.exclude_from_totals', '=', false),
      eb('je.exclude_from_totals', 'is', null),
    ]))
    .select(['je.merchant_name', 'jl.account_id', sql<string>`count(*)`.as('cnt')])
    .groupBy(['je.merchant_name', 'jl.account_id'])
    .execute();

  // Build merchant → most-used category map (exclude uncategorized)
  const merchantCategory = new Map<string, string>();
  const merchantCounts = new Map<string, { accountId: string; count: number }>();

  for (const row of history) {
    if (uncatIds.has(row.account_id)) continue;
    const name = row.merchant_name!;
    const count = Number(row.cnt);
    const existing = merchantCounts.get(name);
    if (!existing || count > existing.count) {
      merchantCounts.set(name, { accountId: row.account_id, count });
    }
  }

  for (const [name, { accountId }] of merchantCounts) {
    merchantCategory.set(name, accountId);
  }

  // Batch updates by target account to avoid N+1 writes
  const updatesByTarget = new Map<string, string[]>();
  for (const entry of withMerchant) {
    const targetId = merchantCategory.get(entry.merchant_name!);
    if (targetId && targetId !== entry.category_account_id) {
      const ids = updatesByTarget.get(targetId) || [];
      ids.push(entry.category_line_id);
      updatesByTarget.set(targetId, ids);
    }
  }

  // Build lineId→entryId map for setting categorized_by
  const lineToEntryMH = new Map(withMerchant.map(e => [e.category_line_id, e.entry_id]));

  let categorized = 0;
  for (const [targetId, lineIds] of updatesByTarget) {
    await db.updateTable('journal_lines')
      .set({ account_id: targetId })
      .where('id', 'in', lineIds)
      .execute();

    const entryIds = [...new Set(lineIds.map(id => lineToEntryMH.get(id)!))];
    if (entryIds.length > 0) {
      await db.updateTable('journal_entries')
        .set({ categorized_by: 'merchant-history' })
        .where('id', 'in', entryIds)
        .execute();
    }

    categorized += lineIds.length;
  }

  return categorized;
}

/**
 * Auto-categorize entries using Plaid's personal_finance_category.
 * Creates expense/income accounts as needed from the Plaid taxonomy.
 * Skips transfer categories (handled by transfer detection).
 */
async function applyPlaidCategories(
  db: Kysely<Database>,
  householdId: string,
  entries: UncategorizedEntry[],
): Promise<number> {
  const entriesWithPlaidCat = entries.filter(e => e.plaid_category);
  if (entriesWithPlaidCat.length === 0) return 0;

  // Build a cache of existing expense/income accounts by name
  const existingAccounts = await db
    .selectFrom('accounts')
    .where('household_id', '=', householdId)
    .where('account_type', 'in', ['expense', 'income'])
    .select(['id', 'name', 'account_type'])
    .execute();

  const accountByName = new Map(
    existingAccounts.map(a => [`${a.account_type}:${a.name.toLowerCase()}`, a.id])
  );

  // First pass: resolve target accounts (creating any that don't exist)
  const lineToTarget = new Map<string, string>();

  for (const entry of entriesWithPlaidCat) {
    const mapping = mapPlaidCategory(entry.plaid_category);
    if (!mapping) continue;

    const key = `${mapping.accountType}:${mapping.accountName.toLowerCase()}`;
    let targetAccountId = accountByName.get(key);

    if (!targetAccountId) {
      targetAccountId = nanoid();
      await db.insertInto('accounts').values({
        id: targetAccountId,
        household_id: householdId,
        name: mapping.accountName,
        account_type: mapping.accountType,
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
        is_manual: false,
        owner: null,
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      }).execute();
      accountByName.set(key, targetAccountId);
    }

    lineToTarget.set(entry.category_line_id, targetAccountId);
  }

  // Second pass: batch updates by target account
  const updatesByTarget = new Map<string, string[]>();
  for (const [lineId, targetId] of lineToTarget) {
    const ids = updatesByTarget.get(targetId) || [];
    ids.push(lineId);
    updatesByTarget.set(targetId, ids);
  }

  let categorized = 0;
  // Build lineId→entryId map for setting categorized_by
  const lineToEntry = new Map(entriesWithPlaidCat.map(e => [e.category_line_id, e.entry_id]));

  for (const [targetId, lineIds] of updatesByTarget) {
    await db.updateTable('journal_lines')
      .set({ account_id: targetId })
      .where('id', 'in', lineIds)
      .execute();

    // Set categorized_by on the journal entries
    const entryIds = [...new Set(lineIds.map(id => lineToEntry.get(id)!))];
    if (entryIds.length > 0) {
      await db.updateTable('journal_entries')
        .set({ categorized_by: 'plaid' })
        .where('id', 'in', entryIds)
        .execute();
    }

    categorized += lineIds.length;
  }

  return categorized;
}

/**
 * Apply user-defined category rules to uncategorized entries.
 * These override Plaid categories — runs after applyPlaidCategories.
 * Updates the category-side journal line's account_id directly.
 */
async function applyCategoryRules(
  db: Kysely<Database>,
  householdId: string,
  entries: UncategorizedEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;

  const rules = await db
    .selectFrom('category_rules')
    .where('household_id', '=', householdId)
    .orderBy('priority', 'desc')
    .selectAll()
    .execute();

  if (rules.length === 0) return 0;

  // Collect updates: category line changes + entry-level action updates
  const updatesByTarget = new Map<string, string[]>();
  const entryActions: { entryId: string; rename?: string; owner?: string; exclude?: boolean }[] = [];
  const entryRuleMatch = new Map<string, string>(); // entryId → rule match_value

  for (const entry of entries) {
    for (const rule of rules) {
      const value = (rule.match_field === 'merchant_name'
        ? entry.merchant_name || entry.description
        : entry.description
      ).toLowerCase();
      const pattern = rule.match_value.toLowerCase();

      let matched = false;
      switch (rule.match_type) {
        case 'contains': matched = value.includes(pattern); break;
        case 'equals': matched = value === pattern; break;
        case 'starts_with': matched = value.startsWith(pattern); break;
      }

      if (matched) {
        entryRuleMatch.set(entry.entry_id, rule.match_value);

        // Category update
        if (rule.target_account_id && entry.category_account_id !== rule.target_account_id) {
          const ids = updatesByTarget.get(rule.target_account_id) || [];
          ids.push(entry.category_line_id);
          updatesByTarget.set(rule.target_account_id, ids);
        }

        // Entry-level actions
        if (rule.rename_merchant || rule.set_owner !== null || rule.set_exclude !== null) {
          const action: typeof entryActions[number] = { entryId: entry.entry_id };
          if (rule.rename_merchant) action.rename = rule.rename_merchant;
          if (rule.set_owner !== null && rule.set_owner !== undefined) action.owner = rule.set_owner;
          if (rule.set_exclude !== null && rule.set_exclude !== undefined) action.exclude = rule.set_exclude;
          entryActions.push(action);
        }

        break; // first matching rule wins
      }
    }
  }

  let categorized = 0;
  for (const [targetId, lineIds] of updatesByTarget) {
    await db.updateTable('journal_lines')
      .set({ account_id: targetId })
      .where('id', 'in', lineIds)
      .execute();
    categorized += lineIds.length;
  }

  // Set categorized_by for all rule-matched entries (including those with only entry-level actions)
  // Group by rule match_value to batch updates
  const idsByRule = new Map<string, string[]>();
  for (const [entryId, matchValue] of entryRuleMatch) {
    const ids = idsByRule.get(matchValue) || [];
    ids.push(entryId);
    idsByRule.set(matchValue, ids);
  }
  for (const [matchValue, entryIds] of idsByRule) {
    await db.updateTable('journal_entries')
      .set({ categorized_by: `rule:${matchValue}` })
      .where('id', 'in', entryIds)
      .execute();
  }

  // Apply entry-level actions (rename, owner, exclude)
  for (const action of entryActions) {
    const updates: Record<string, unknown> = {};
    if (action.rename) updates.merchant_name = action.rename;
    if (action.owner !== undefined) updates.owner = action.owner;
    if (action.exclude !== undefined) updates.exclude_from_totals = action.exclude;

    if (Object.keys(updates).length > 0) {
      await db.updateTable('journal_entries')
        .set(updates as any)
        .where('id', '=', action.entryId)
        .execute();
    }
  }

  return categorized + entryActions.length;
}

/**
 * Apply a single category rule retroactively to all matching unverified entries.
 * Used by the "create rule from entry" endpoint — no transfer detection side effects.
 */
export async function applyOneRule(
  db: Kysely<Database>,
  householdId: string,
  rule: {
    match_field: string;
    match_type: string;
    match_value: string;
    target_account_id?: string | null;
    rename_merchant?: string | null;
    set_owner?: string | null;
    set_exclude?: boolean | null;
  },
): Promise<number> {
  const entries = await loadEntries(db, householdId, { uncategorizedOnly: false });
  const matchedEntryIds: string[] = [];
  const lineIds: string[] = [];

  for (const entry of entries) {
    const value = (rule.match_field === 'merchant_name'
      ? entry.merchant_name || entry.description
      : entry.description
    ).toLowerCase();
    const pattern = rule.match_value.toLowerCase();

    let matched = false;
    switch (rule.match_type) {
      case 'contains': matched = value.includes(pattern); break;
      case 'equals': matched = value === pattern; break;
      case 'starts_with': matched = value.startsWith(pattern); break;
    }

    if (matched) {
      matchedEntryIds.push(entry.entry_id);
      if (rule.target_account_id && entry.category_account_id !== rule.target_account_id) {
        lineIds.push(entry.category_line_id);
      }
    }
  }

  // Apply category change
  if (lineIds.length > 0 && rule.target_account_id) {
    await db.updateTable('journal_lines')
      .set({ account_id: rule.target_account_id })
      .where('id', 'in', lineIds)
      .execute();
  }

  // Apply entry-level actions (rename merchant, set owner, exclude)
  if (matchedEntryIds.length > 0) {
    const updates: Record<string, unknown> = {};
    if (rule.rename_merchant) updates.merchant_name = rule.rename_merchant;
    if (rule.set_owner !== undefined && rule.set_owner !== null) updates.owner = rule.set_owner;
    if (rule.set_exclude !== undefined && rule.set_exclude !== null) updates.exclude_from_totals = rule.set_exclude;

    if (Object.keys(updates).length > 0) {
      await db.updateTable('journal_entries')
        .set(updates as any)
        .where('id', 'in', matchedEntryIds)
        .execute();
    }
  }

  return matchedEntryIds.length;
}

/**
 * Confirm a match suggestion — creates a new transfer entry and supersedes both originals.
 */
export async function confirmTransferSuggestion(
  db: Kysely<Database>,
  householdId: string,
  suggestionId: string,
): Promise<void> {
  const suggestion = await db
    .selectFrom('match_suggestions')
    .where('id', '=', suggestionId)
    .where('household_id', '=', householdId)
    .where('status', '=', 'pending')
    .selectAll()
    .executeTakeFirst();

  if (!suggestion) throw new Error('Suggestion not found or already processed');
  if (!suggestion.entry_b_id) throw new Error('Transfer suggestion requires two entries');

  await db.transaction().execute(async (tx) => {
    const entryA = await tx.selectFrom('journal_entries')
      .where('id', '=', suggestion.entry_a_id)
      .selectAll()
      .executeTakeFirst();
    const entryB = await tx.selectFrom('journal_entries')
      .where('id', '=', suggestion.entry_b_id!)
      .selectAll()
      .executeTakeFirst();

    if (!entryA || !entryB) throw new Error('One or both entries no longer exist');

    const linesA = await tx.selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .where('jl.journal_entry_id', '=', entryA.id)
      .select(['jl.id', 'jl.account_id', 'jl.amount', 'a.account_type'])
      .execute();
    const linesB = await tx.selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .where('jl.journal_entry_id', '=', entryB.id)
      .select(['jl.id', 'jl.account_id', 'jl.amount', 'a.account_type'])
      .execute();
    const bankLineA = linesA.find(l => ['asset', 'liability'].includes(l.account_type));
    const bankLineB = linesB.find(l => ['asset', 'liability'].includes(l.account_type));

    if (!bankLineA || !bankLineB) throw new Error('Could not find bank-side lines');

    const earlier = new Date(entryA.date as unknown as string) <= new Date(entryB.date as unknown as string)
      ? entryA : entryB;

    // Create new transfer entry
    const newEntryId = nanoid();
    const matchType = suggestion.match_type === 'cc_payment' ? 'CC Payment' : 'Transfer';
    await tx.insertInto('journal_entries').values({
      id: newEntryId,
      household_id: householdId,
      date: earlier.date as unknown as string,
      description: `${matchType}: ${earlier.description}`,
      merchant_name: earlier.merchant_name,
      notes: 'Confirmed transfer match',
      owner: null,
      is_verified: true,
      plaid_transaction_id: null,
      source: 'matchmaker',
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }).execute();

    // Two bank-side lines on the new entry
    await tx.insertInto('journal_lines').values([
      {
        id: nanoid(),
        journal_entry_id: newEntryId,
        account_id: bankLineA.account_id,
        amount: Number(bankLineA.amount),
        created_at: new Date().toISOString(),
      },
      {
        id: nanoid(),
        journal_entry_id: newEntryId,
        account_id: bankLineB.account_id,
        amount: Number(bankLineB.amount),
        created_at: new Date().toISOString(),
      },
    ]).execute();

    // Supersede both originals + exclude from totals
    await tx.updateTable('journal_entries')
      .set({
        superseded_by: newEntryId,
        exclude_from_totals: true,
        is_verified: true,
        updated_at: new Date().toISOString(),
      })
      .where('id', 'in', [entryA.id, entryB.id])
      .execute();

    // Mark suggestion as confirmed
    await tx.updateTable('match_suggestions')
      .set({ status: 'confirmed' })
      .where('id', '=', suggestionId)
      .execute();
  });
}

/**
 * Dismiss a match suggestion.
 */
export async function dismissSuggestion(
  db: Kysely<Database>,
  householdId: string,
  suggestionId: string,
): Promise<void> {
  const result = await db.updateTable('match_suggestions')
    .set({ status: 'dismissed' })
    .where('id', '=', suggestionId)
    .where('household_id', '=', householdId)
    .where('status', '=', 'pending')
    .executeTakeFirst();

  if (BigInt(result.numUpdatedRows) === 0n) {
    throw new Error('Suggestion not found or already processed');
  }
}
