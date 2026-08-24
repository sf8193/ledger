-- Staging table for pending Plaid transactions.
-- Pending transactions are mutable (amount, date, name can change)
-- and may be removed entirely. They don't belong in the immutable journal.
-- When a pending transaction clears, it gets promoted to a journal entry.

CREATE TABLE pending_transactions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  plaid_transaction_id TEXT NOT NULL UNIQUE,
  plaid_account_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  merchant_name TEXT,
  amount NUMERIC(14,2) NOT NULL,
  plaid_category TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pending_transactions_household ON pending_transactions(household_id);
CREATE INDEX idx_pending_transactions_account ON pending_transactions(account_id);
