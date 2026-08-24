import { Router, type Router as RouterType } from 'express';
import { db } from '../db/kysely';
import { sql } from 'kysely';
import { nanoid } from 'nanoid';
import { asyncHandler } from '../middleware/error';
import { z } from 'zod';
import { runMatchmaker, confirmTransferSuggestion, dismissSuggestion, applyOneRule } from '../services/matchmaker';

export const matchingRouter: RouterType = Router();

// --- Match Suggestions ---

// List pending suggestions
matchingRouter.get('/suggestions', asyncHandler(async (req, res) => {
  const suggestions = await db
    .selectFrom('match_suggestions as ms')
    .innerJoin('journal_entries as je_a', 'je_a.id', 'ms.entry_a_id')
    .leftJoin('journal_entries as je_b', 'je_b.id', 'ms.entry_b_id')
    .where('ms.household_id', '=', req.householdId!)
    .where('ms.status', '=', 'pending')
    .orderBy('ms.confidence', 'desc')
    .select([
      'ms.id',
      'ms.match_type',
      'ms.confidence',
      'ms.metadata',
      'ms.created_at',
      'je_a.id as entry_a_id',
      'je_a.description as entry_a_description',
      'je_a.date as entry_a_date',
      'je_a.merchant_name as entry_a_merchant',
      'je_b.id as entry_b_id',
      'je_b.description as entry_b_description',
      'je_b.date as entry_b_date',
      'je_b.merchant_name as entry_b_merchant',
    ])
    .execute();

  res.json(suggestions);
}));

// Confirm a suggestion (apply the transfer merge)
matchingRouter.post('/suggestions/:id/confirm', asyncHandler(async (req, res) => {
  await confirmTransferSuggestion(db, req.householdId!, req.params.id);
  res.json({ ok: true });
}));

// Dismiss a suggestion
matchingRouter.post('/suggestions/:id/dismiss', asyncHandler(async (req, res) => {
  await dismissSuggestion(db, req.householdId!, req.params.id);
  res.json({ ok: true });
}));

// Manually trigger matchmaker
matchingRouter.post('/run', asyncHandler(async (req, res) => {
  const result = await runMatchmaker(db, req.householdId!);
  res.json(result);
}));

// --- Uncategorized leftovers ---

// List entries still uncategorized after all matchmaker passes
matchingRouter.get('/uncategorized', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;

  // Find uncategorized account IDs (system-created, unique per household via uq_system_accounts)
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

  if (uncatAccounts.length === 0) {
    return res.json({ data: [], total: 0 });
  }

  const uncatIds = uncatAccounts.map(a => a.id);

  const entries = await db
    .selectFrom('journal_entries as je')
    .innerJoin('journal_lines as cat_line', (join) =>
      join.onRef('cat_line.journal_entry_id', '=', 'je.id')
    )
    .where('je.household_id', '=', householdId)
    .where('je.is_verified', '=', false)
    .where('cat_line.account_id', 'in', uncatIds)
    .orderBy('je.date', 'desc')
    .select([
      'je.id',
      'je.date',
      'je.description',
      'je.merchant_name',
      'je.plaid_category',
      'cat_line.amount',
    ])
    .execute();

  res.json({ data: entries, total: entries.length });
}));

// --- Category Rules ---

const createRuleSchema = z.object({
  target_account_id: z.string().min(1).optional(),
  match_field: z.enum(['description', 'merchant_name']),
  match_type: z.enum(['contains', 'equals', 'starts_with']),
  match_value: z.string().min(1).max(200),
  priority: z.number().int().min(0).default(0),
  rename_merchant: z.string().max(200).nullable().optional(),
  set_owner: z.string().max(100).nullable().optional(),
  set_exclude: z.boolean().nullable().optional(),
});

// List rules
matchingRouter.get('/rules', asyncHandler(async (req, res) => {
  const rules = await db
    .selectFrom('category_rules as cr')
    .leftJoin('accounts as a', 'a.id', 'cr.target_account_id')
    .where('cr.household_id', '=', req.householdId!)
    .orderBy('cr.priority', 'desc')
    .select([
      'cr.id',
      'cr.match_field',
      'cr.match_type',
      'cr.match_value',
      'cr.priority',
      'cr.target_account_id',
      'a.name as target_account_name',
      'a.account_type as target_account_type',
      'cr.rename_merchant',
      'cr.set_owner',
      'cr.set_exclude',
    ])
    .execute();

  res.json(rules);
}));

// Create rule
matchingRouter.post('/rules', asyncHandler(async (req, res) => {
  const data = createRuleSchema.parse(req.body);
  const householdId = req.householdId!;

  // Must have at least one action
  if (!data.target_account_id && !data.rename_merchant && data.set_owner === undefined && data.set_exclude === undefined) {
    return res.status(400).json({ error: 'Rule must have at least one action' });
  }

  // Validate target account if provided
  if (data.target_account_id) {
    const target = await db.selectFrom('accounts')
      .where('id', '=', data.target_account_id)
      .where('household_id', '=', householdId)
      .where('account_type', 'in', ['expense', 'income'])
      .select('id')
      .executeTakeFirst();

    if (!target) {
      return res.status(400).json({ error: 'Target account not found or not an expense/income account' });
    }
  }

  const rule: Record<string, unknown> = {
    id: nanoid(),
    household_id: householdId,
    match_field: data.match_field,
    match_type: data.match_type,
    match_value: data.match_value,
    priority: data.priority,
    created_at: new Date().toISOString(),
  };
  if (data.target_account_id) rule.target_account_id = data.target_account_id;
  if (data.rename_merchant !== undefined) rule.rename_merchant = data.rename_merchant;
  if (data.set_owner !== undefined) rule.set_owner = data.set_owner;
  if (data.set_exclude !== undefined) rule.set_exclude = data.set_exclude;

  await db.insertInto('category_rules').values(rule as any).execute();

  // Apply retroactively to matching unverified entries
  let applied = 0;
  try {
    applied = await applyOneRule(db, householdId, rule as any);
  } catch (err) {
    // Rule was created; retroactive apply failed — will fire on next sync
    return res.json({ ...rule, applied: 0, apply_error: 'Retroactive apply failed' });
  }

  res.json({ ...rule, applied });
}));

// Preview: count matching transactions for a rule before creating
const previewRuleSchema = z.object({
  match_field: z.enum(['description', 'merchant_name']),
  match_type: z.enum(['contains', 'equals', 'starts_with']),
  match_value: z.string().min(1).max(200),
});

matchingRouter.post('/rules/preview', asyncHandler(async (req, res) => {
  const data = previewRuleSchema.parse(req.body);
  const householdId = req.householdId!;

  // Match the same logic as applyOneRule: merchant_name falls back to description
  const fieldExpr = data.match_field === 'merchant_name'
    ? sql`LOWER(COALESCE(je.merchant_name, je.description))`
    : sql`LOWER(je.description)`;
  // Escape LIKE wildcards so % and _ in match values are literal
  const pattern = data.match_value.toLowerCase().replace(/[%_]/g, '\\$&');

  let query = db
    .selectFrom('journal_entries as je')
    .where('je.household_id', '=', householdId)
    .where('je.is_verified', '=', false)
    .where('je.superseded_by', 'is', null);

  if (data.match_type === 'contains') {
    query = query.where(fieldExpr, 'like', `%${pattern}%`);
  } else if (data.match_type === 'equals') {
    query = query.where(fieldExpr, '=', pattern);
  } else if (data.match_type === 'starts_with') {
    query = query.where(fieldExpr, 'like', `${pattern}%`);
  }

  const result = await query
    .select(sql<number>`COUNT(*)`.as('count'))
    .executeTakeFirst();

  res.json({ count: Number(result?.count || 0) });
}));

// Update rule
const updateRuleSchema = z.object({
  target_account_id: z.string().min(1).optional().nullable(),
  match_field: z.enum(['description', 'merchant_name']).optional(),
  match_type: z.enum(['contains', 'equals', 'starts_with']).optional(),
  match_value: z.string().min(1).max(200).optional(),
  rename_merchant: z.string().max(200).nullable().optional(),
  set_owner: z.string().max(100).nullable().optional(),
  set_exclude: z.boolean().nullable().optional(),
});

matchingRouter.put('/rules/:id', asyncHandler(async (req, res) => {
  const data = updateRuleSchema.parse(req.body);
  const householdId = req.householdId!;

  // Verify rule belongs to household
  const existing = await db.selectFrom('category_rules')
    .where('id', '=', req.params.id)
    .where('household_id', '=', householdId)
    .selectAll()
    .executeTakeFirst();

  if (!existing) {
    return res.status(404).json({ error: 'Rule not found' });
  }

  // Validate target account if provided
  if (data.target_account_id) {
    const target = await db.selectFrom('accounts')
      .where('id', '=', data.target_account_id)
      .where('household_id', '=', householdId)
      .where('account_type', 'in', ['expense', 'income'])
      .select('id')
      .executeTakeFirst();

    if (!target) {
      return res.status(400).json({ error: 'Target account not found or not an expense/income account' });
    }
  }

  const updates: Record<string, unknown> = {};
  if (data.match_field !== undefined) updates.match_field = data.match_field;
  if (data.match_type !== undefined) updates.match_type = data.match_type;
  if (data.match_value !== undefined) updates.match_value = data.match_value;
  if (data.target_account_id !== undefined) updates.target_account_id = data.target_account_id;
  if (data.rename_merchant !== undefined) updates.rename_merchant = data.rename_merchant;
  if (data.set_owner !== undefined) updates.set_owner = data.set_owner;
  if (data.set_exclude !== undefined) updates.set_exclude = data.set_exclude;

  if (Object.keys(updates).length === 0) {
    return res.json(existing);
  }

  // Verify at least one action remains after applying updates
  const merged = { ...existing, ...updates };
  if (!merged.target_account_id && !merged.rename_merchant && !merged.set_owner && !merged.set_exclude) {
    return res.status(400).json({ error: 'Rule must have at least one action' });
  }

  await db.updateTable('category_rules')
    .set(updates)
    .where('id', '=', req.params.id)
    .where('household_id', '=', householdId)
    .execute();

  // Re-apply updated rule to matching unverified entries
  const updated = { ...existing, ...updates };
  let applied = 0;
  try {
    applied = await applyOneRule(db, householdId, updated as any);
  } catch {
    return res.json({ ...updated, applied: 0, apply_error: 'Retroactive apply failed' });
  }

  res.json({ ...updated, applied });
}));

// Delete rule
matchingRouter.delete('/rules/:id', asyncHandler(async (req, res) => {
  await db
    .deleteFrom('category_rules')
    .where('id', '=', req.params.id)
    .where('household_id', '=', req.householdId!)
    .execute();

  res.json({ ok: true });
}));

// Create a rule from an existing transaction (convenience endpoint)
// "Always categorize transactions like this one as X"
const createRuleFromEntrySchema = z.object({
  entry_id: z.string().min(1),
  target_account_id: z.string().min(1),
  match_field: z.enum(['description', 'merchant_name']).default('merchant_name'),
  match_type: z.enum(['contains', 'equals', 'starts_with']).default('contains'),
  match_value: z.string().min(1).max(200).optional(),
});

/**
 * Strip bank reference numbers and transaction-specific suffixes from a string.
 * "SCHWAB BROKERAGE MONEYLINK PPD ID: 9005586224" → "SCHWAB BROKERAGE MONEYLINK"
 * "CAPITAL ONE ONLINE PMT CA02A152CF3A048 WEB ID: 9279744391" → "CAPITAL ONE ONLINE PMT"
 */
export function stripReferenceNumbers(value: string): string {
  return value
    // Remove PPD ID, WEB ID, TEL ID patterns and everything after (ACH references)
    .replace(/\s+(PPD|WEB|TEL|CCD)\s+ID:\s*\S+.*/gi, '')
    // Remove "PURCHASE <digits>" and everything after
    .replace(/\s+PURCHASE\s+\d+.*/gi, '')
    // Remove trailing transaction IDs after * (e.g. "Amazon.com*569B61IR1")
    .replace(/\*\S+$/, '')
    // Remove trailing numeric-heavy reference codes (8+ chars, must contain a digit)
    .replace(/\s+(?=\S*\d)\S{8,}$/i, '')
    .trim();
}

matchingRouter.post('/rules/from-entry', asyncHandler(async (req, res) => {
  const data = createRuleFromEntrySchema.parse(req.body);
  const householdId = req.householdId!;

  const entry = await db.selectFrom('journal_entries')
    .where('id', '=', data.entry_id)
    .where('household_id', '=', householdId)
    .select(['description', 'merchant_name'])
    .executeTakeFirst();

  if (!entry) {
    return res.status(404).json({ error: 'Entry not found' });
  }

  // Prefer merchant_name, fall back to description. Always strip reference numbers.
  let matchValue: string;
  if (data.match_value) {
    matchValue = data.match_value;
  } else {
    const raw = (data.match_field === 'merchant_name' && entry.merchant_name)
      ? entry.merchant_name
      : (entry.merchant_name || entry.description);
    matchValue = stripReferenceNumbers(raw);
  }

  const rule = {
    id: nanoid(),
    household_id: householdId,
    target_account_id: data.target_account_id,
    match_field: data.match_field,
    match_type: data.match_type,
    match_value: matchValue,
    priority: 0,
    created_at: new Date().toISOString(),
  };

  await db.insertInto('category_rules').values(rule).execute();

  // Apply just this rule retroactively (no transfer detection side effects)
  const applied = await applyOneRule(db, householdId, rule);

  res.json({ rule, applied });
}));
