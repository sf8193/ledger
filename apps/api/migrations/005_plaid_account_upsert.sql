-- Unique constraint on plaid_account_id for upsert on re-link
-- Only applies to non-null values (manual accounts have null plaid_account_id)
CREATE UNIQUE INDEX uq_financial_accounts_plaid_account_id
  ON financial_accounts(plaid_account_id) WHERE plaid_account_id IS NOT NULL;
