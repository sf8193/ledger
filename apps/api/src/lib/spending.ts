import { db } from '../db/kysely';
import { sql } from 'kysely';

interface SpendingByCategory {
  category_id: string;
  spent: number;
}

interface SpendingOptions {
  owner?: string;
}

/**
 * Canonical spending-by-category query. Single source of truth for
 * "how much was spent in each expense category during a given month."
 *
 * Used by: budget, dashboard, reports routes.
 * Encapsulates: exclude_from_totals filtering (both entry and account level),
 * account_type = 'expense', YYYY-MM date windowing.
 */
export async function getSpendingByCategory(
  householdId: string,
  month: string,
  opts?: SpendingOptions,
): Promise<SpendingByCategory[]> {
  let query = db
    .selectFrom('journal_lines as jl')
    .innerJoin('accounts as a', 'a.id', 'jl.account_id')
    .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
    .where('a.household_id', '=', householdId)
    .where('a.account_type', '=', 'expense')
    .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false)
    .where(sql`TO_CHAR(je.date, 'YYYY-MM')`, '=', month);

  if (opts?.owner) {
    query = query.where('je.owner', '=', opts.owner);
  }

  const rows = await query
    .groupBy('a.id')
    .select([
      'a.id as category_id',
      sql<number>`COALESCE(SUM(jl.amount), 0)`.as('spent'),
    ])
    .execute();

  return rows.map(r => ({ category_id: r.category_id, spent: Number(r.spent) }));
}

/**
 * Cumulative spending by category before a given month.
 * Used for envelope rollover computation.
 *
 * Performance note: this scans all journal_lines prior to `beforeMonth`.
 * For long-lived accounts (3+ years), consider materializing a
 * `rollover_balance` column on budget_allocations as an optimization.
 */
export async function getCumulativeSpendingBefore(
  householdId: string,
  beforeMonth: string,
): Promise<SpendingByCategory[]> {
  const rows = await db
    .selectFrom('journal_lines as jl')
    .innerJoin('accounts as a', 'a.id', 'jl.account_id')
    .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
    .where('a.household_id', '=', householdId)
    .where('a.account_type', '=', 'expense')
    .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false)
    .where(sql`TO_CHAR(je.date, 'YYYY-MM')`, '<', beforeMonth)
    .groupBy('a.id')
    .select([
      'a.id as category_id',
      sql<number>`COALESCE(SUM(jl.amount), 0)`.as('spent'),
    ])
    .execute();

  return rows.map(r => ({ category_id: r.category_id, spent: Number(r.spent) }));
}
