import { Transaction } from 'kysely';
import { Database } from '../db/types';
import { nanoid } from 'nanoid';

/**
 * Get or create the "Opening Balances" equity account for a household.
 * Used by account creation, balance edits, Plaid onboarding, and Monarch import.
 */
export async function getOrCreateEquityAccount(
  tx: Transaction<Database>,
  householdId: string,
): Promise<string> {
  const existing = await tx.selectFrom('accounts')
    .where('household_id', '=', householdId)
    .where('account_type', '=', 'equity')
    .where('name', '=', 'Opening Balances')
    .select('id')
    .executeTakeFirst();

  if (existing) return existing.id;

  const id = nanoid();
  await tx.insertInto('accounts').values({
    id,
    household_id: householdId,
    name: 'Opening Balances',
    account_type: 'equity',
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

  return id;
}
