-- Double-entry accounting migration
-- Unifies financial_accounts + categories into accounts
-- Replaces transactions with journal_entries + journal_lines

-- 1. Create unified accounts table
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('asset', 'liability', 'income', 'expense', 'equity')),

  -- For asset/liability accounts (bank-linked)
  plaid_item_id TEXT REFERENCES plaid_items(id) ON DELETE SET NULL,
  plaid_account_id TEXT,
  institution_name TEXT,
  mask TEXT,
  subtype TEXT,
  current_balance NUMERIC(14,2) DEFAULT 0,
  is_hidden BOOLEAN NOT NULL DEFAULT FALSE,

  -- For expense/income accounts (categories)
  icon TEXT,
  color TEXT,
  parent_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,

  -- Common
  is_manual BOOLEAN NOT NULL DEFAULT FALSE,
  owner TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_accounts_household ON accounts(household_id);
CREATE INDEX idx_accounts_type ON accounts(household_id, account_type);
CREATE UNIQUE INDEX uq_accounts_plaid_account_id ON accounts(plaid_account_id) WHERE plaid_account_id IS NOT NULL;

-- 2. Create journal entries table
CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  description TEXT NOT NULL,
  merchant_name TEXT,
  notes TEXT,
  owner TEXT,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  plaid_transaction_id TEXT UNIQUE,
  source TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_journal_entries_household_date ON journal_entries(household_id, date);
CREATE INDEX idx_journal_entries_owner ON journal_entries(household_id, owner);

-- 3. Create journal lines table
CREATE TABLE journal_lines (
  id TEXT PRIMARY KEY,
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount NUMERIC(14,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_journal_lines_entry ON journal_lines(journal_entry_id);
CREATE INDEX idx_journal_lines_account ON journal_lines(account_id);

-- 4. Migrate financial_accounts -> accounts (asset/liability)
INSERT INTO accounts (id, household_id, name, account_type, plaid_item_id, plaid_account_id, mask, subtype, current_balance, is_hidden, is_manual, updated_at, created_at)
SELECT
  id, household_id, name,
  CASE
    WHEN type IN ('credit', 'loan') THEN 'liability'
    ELSE 'asset'
  END,
  plaid_item_id, plaid_account_id, mask, subtype, current_balance, is_hidden, is_manual, updated_at, created_at
FROM financial_accounts;

-- 5. Migrate categories -> accounts (expense/income)
INSERT INTO accounts (id, household_id, name, account_type, icon, color, parent_id, sort_order, updated_at, created_at)
SELECT
  id, household_id, name,
  CASE WHEN is_income THEN 'income' ELSE 'expense' END,
  icon, color, parent_id, sort_order, updated_at, NOW()
FROM categories;

-- 6. Create default equity account per household for opening balances
INSERT INTO accounts (id, household_id, name, account_type, created_at)
SELECT
  'equity_' || id, id, 'Opening Balances', 'equity', NOW()
FROM households;

-- 7. Create default Uncategorized expense account per household
INSERT INTO accounts (id, household_id, name, account_type, sort_order, created_at)
SELECT
  'uncat_' || id, id, 'Uncategorized', 'expense', 9999, NOW()
FROM households;

-- 8. Migrate transactions -> journal_entries + journal_lines
-- First create journal entries
INSERT INTO journal_entries (id, household_id, date, description, merchant_name, notes, owner, plaid_transaction_id, source, updated_at, created_at)
SELECT
  id, household_id, date,
  name,
  merchant_name,
  notes,
  owner,
  plaid_transaction_id,
  CASE
    WHEN plaid_category = 'monarch_import' THEN 'monarch_import'
    WHEN plaid_transaction_id LIKE 'monarch_%' THEN 'monarch_import'
    ELSE 'plaid'
  END,
  updated_at, created_at
FROM transactions;

-- Then create journal lines (two per transaction)
-- Line 1: the expense/income side (debit expense or credit income)
-- For positive amounts (expenses in Plaid convention): debit the category account
-- For negative amounts (income): credit the category account (amount is already negative)
INSERT INTO journal_lines (id, journal_entry_id, account_id, amount, created_at)
SELECT
  t.id || '_exp',
  t.id,
  COALESCE(t.category_id, 'uncat_' || t.household_id),
  t.amount,
  t.created_at
FROM transactions t;

-- Line 2: the asset/liability side (credit the bank account)
INSERT INTO journal_lines (id, journal_entry_id, account_id, amount, created_at)
SELECT
  t.id || '_bank',
  t.id,
  t.account_id,
  -t.amount,
  t.created_at
FROM transactions t;

-- 9. Drop old tables (order matters for FKs)
DROP TABLE IF EXISTS category_rules CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS financial_accounts CASCADE;
