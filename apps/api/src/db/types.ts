import { Generated, ColumnType } from 'kysely';

// Better Auth managed tables (camelCase - don't touch)
export interface UserTable {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: ColumnType<Date, string, string>;
  updatedAt: ColumnType<Date, string, string>;
}

export interface SessionTable {
  id: string;
  expiresAt: ColumnType<Date, string, string>;
  token: string;
  createdAt: ColumnType<Date, string, string>;
  updatedAt: ColumnType<Date, string, string>;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string;
}

export interface AuthAccountTable {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: ColumnType<Date, string, string> | null;
  refreshTokenExpiresAt: ColumnType<Date, string, string> | null;
  scope: string | null;
  password: string | null;
  createdAt: ColumnType<Date, string, string>;
  updatedAt: ColumnType<Date, string, string>;
}

export interface VerificationTable {
  id: string;
  identifier: string;
  value: string;
  expiresAt: ColumnType<Date, string, string>;
  createdAt: ColumnType<Date, string, string> | null;
  updatedAt: ColumnType<Date, string, string> | null;
}

// Custom tables (snake_case)
export interface HouseholdTable {
  id: string;
  name: string;
  surplus_category_id: Generated<string | null>;
  created_at: ColumnType<Date, string, string>;
}

export interface HouseholdMemberTable {
  id: string;
  household_id: string;
  user_id: string;
  role: 'owner' | 'member' | 'viewer';
  created_at: ColumnType<Date, string, string>;
}

export interface PlaidItemTable {
  id: string;
  household_id: string;
  institution_id: string | null;
  institution_name: string | null;
  access_token_encrypted: string;
  item_id: string;
  cursor: string | null;
  last_synced: ColumnType<Date, string, string> | null;
  status: string;
  logo: string | null;
  primary_color: string | null;
  created_at: ColumnType<Date, string, string>;
}

// Unified accounts table (asset/liability/income/expense/equity)
export type AccountType = 'asset' | 'liability' | 'income' | 'expense' | 'equity';

export interface AccountTable {
  id: string;
  household_id: string;
  name: string;
  account_type: AccountType;
  // Bank-linked fields (asset/liability)
  plaid_item_id: string | null;
  plaid_account_id: string | null;
  institution_name: string | null;
  mask: string | null;
  subtype: string | null;
  is_hidden: boolean;
  // Category fields (income/expense)
  icon: string | null;
  color: string | null;
  parent_id: string | null;
  sort_order: number;
  // Credit card details (from Plaid Liabilities)
  credit_limit: number | null;
  apr_purchase: number | null;
  apr_cash: number | null;
  last_payment_amount: number | null;
  last_payment_date: string | null;
  minimum_payment: number | null;
  next_payment_due_date: string | null;
  last_statement_balance: number | null;
  is_overdue: boolean | null;
  // Tax treatment for FIRE/tax projections
  tax_treatment: string | null; // 'taxable' | 'tax_deferred' | 'roth' | null
  // Common
  is_manual: boolean;
  owner: string | null;
  exclude_from_totals: Generated<boolean>;
  updated_at: ColumnType<Date, string, string>;
  created_at: ColumnType<Date, string, string>;
}

export type ReimbursementStatus = 'pending' | 'reimbursed';

export interface JournalEntryTable {
  id: string;
  household_id: string;
  date: ColumnType<Date, string, string>;
  description: string;
  merchant_name: string | null;
  notes: string | null;
  owner: string | null;
  is_verified: boolean;
  plaid_transaction_id: string | null;
  source: string | null;
  reimbursement_status: ReimbursementStatus | null;
  reimbursement_group_id: string | null;
  exclude_from_totals: boolean | null;
  plaid_category: string | null;
  superseded_by: string | null;
  categorized_by: string | null;
  updated_at: ColumnType<Date, string, string>;
  created_at: ColumnType<Date, string, string>;
}

export interface JournalLineTable {
  id: string;
  journal_entry_id: string;
  account_id: string;
  amount: number;
  created_at: ColumnType<Date, string, string>;
}

export interface BalanceSnapshotTable {
  id: string;
  household_id: string;
  account_id: string;
  date: ColumnType<Date, string, string>;
  balance: number;
  created_at: ColumnType<Date, string, string>;
}

export interface ManualAccountValueTable {
  id: string;
  account_id: string;
  date: ColumnType<Date, string, string>;
  value: number;
  notes: string | null;
  created_at: ColumnType<Date, string, string>;
}

export interface InvestmentHoldingTable {
  id: string;
  household_id: string;
  account_id: string;
  plaid_security_id: string | null;
  name: string;
  ticker: string | null;
  quantity: number;
  price: number;
  value: Generated<number>;
  cost_basis: number | null;
  type: string | null;
  last_updated: ColumnType<Date, string, string>;
  created_at: ColumnType<Date, string, string>;
}

export interface CategoryRuleTable {
  id: string;
  household_id: string;
  target_account_id: string | null;
  match_field: string;
  match_type: string;
  match_value: string;
  priority: number;
  rename_merchant: string | null;
  set_owner: string | null;
  set_exclude: boolean | null;
  created_at: ColumnType<Date, string, string>;
}

export type MatchSuggestionType = 'transfer' | 'cc_payment' | 'recurring';
export type MatchSuggestionStatus = 'pending' | 'confirmed' | 'dismissed';

export interface MatchSuggestionTable {
  id: string;
  household_id: string;
  match_type: MatchSuggestionType;
  entry_a_id: string;
  entry_b_id: string | null;
  confidence: number;
  status: MatchSuggestionStatus;
  metadata: any;
  created_at: ColumnType<Date, string, string>;
}

export interface PendingTransactionTable {
  id: string;
  household_id: string;
  plaid_transaction_id: string;
  plaid_account_id: string;
  account_id: string;
  date: string;
  name: string;
  merchant_name: string | null;
  amount: number;
  plaid_category: string | null;
  created_at: ColumnType<Date, string, string>;
  updated_at: ColumnType<Date, string, string>;
}

export interface HouseholdInviteTable {
  id: string;
  household_id: string;
  email: string;
  role: 'member' | 'viewer';
  invited_by: string;
  token: string;
  expires_at: ColumnType<Date, string, string>;
  accepted_at: ColumnType<Date, string, string> | null;
  created_at: ColumnType<Date, string, string>;
}

export interface BudgetTable {
  id: string;
  household_id: string;
  category_id: string;
  monthly_amount: number;
  priority: Generated<number>;
  rollover_cap: Generated<number | null>;
  created_at: ColumnType<Date, string, string>;
  updated_at: ColumnType<Date, string, string>;
}

export interface BudgetAllocationTable {
  id: string;
  household_id: string;
  category_id: string;
  month: string;
  assigned: number;
  created_at: ColumnType<Date, string, string>;
  updated_at: ColumnType<Date, string, string>;
}

export interface TagTable {
  id: string;
  household_id: string;
  name: string;
  created_at: ColumnType<Date, string, string>;
}

export interface JournalEntryTagTable {
  journal_entry_id: string;
  tag_id: string;
}

export interface Database {
  // Better Auth tables (camelCase)
  user: UserTable;
  session: SessionTable;
  account: AuthAccountTable;
  verification: VerificationTable;
  // Custom tables (snake_case)
  households: HouseholdTable;
  household_members: HouseholdMemberTable;
  plaid_items: PlaidItemTable;
  accounts: AccountTable;
  journal_entries: JournalEntryTable;
  journal_lines: JournalLineTable;
  balance_snapshots: BalanceSnapshotTable;
  manual_account_values: ManualAccountValueTable;
  investment_holdings: InvestmentHoldingTable;
  category_rules: CategoryRuleTable;
  match_suggestions: MatchSuggestionTable;
  pending_transactions: PendingTransactionTable;
  household_invites: HouseholdInviteTable;
  budgets: BudgetTable;
  budget_allocations: BudgetAllocationTable;
  tags: TagTable;
  journal_entry_tags: JournalEntryTagTable;
  fire_scenarios: FireScenarioTable;
  fire_settings: FireSettingsTable;
  tax_scenarios: TaxScenarioTable;
}

export interface FireScenarioTable {
  id: string;
  household_id: string;
  name: string;
  inputs: ColumnType<any, string, string>; // JSONB
  created_at: ColumnType<Date, string, string>;
  updated_at: ColumnType<Date, string, string>;
}

export interface FireSettingsTable {
  household_id: string;
  settings: ColumnType<any, string, string>; // JSONB
  updated_at: ColumnType<Date, string, string>;
}

export interface TaxScenarioTable {
  id: string;
  household_id: string;
  tax_year: number;
  name: string;
  inputs: ColumnType<any, string, string>; // JSONB
  created_at: ColumnType<Date, string, string>;
  updated_at: ColumnType<Date, string, string>;
}
