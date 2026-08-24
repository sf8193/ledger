-- Fix orphaned balance_snapshots FK after migration 007 dropped financial_accounts
-- Re-add FK pointing to the new accounts table

-- First clean up any orphaned snapshots (account_id not in accounts)
DELETE FROM balance_snapshots
WHERE account_id NOT IN (SELECT id FROM accounts);

-- Add FK constraint
ALTER TABLE balance_snapshots
  ADD CONSTRAINT balance_snapshots_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;

-- Also fix manual_account_values and investment_holdings FKs
DELETE FROM manual_account_values
WHERE account_id NOT IN (SELECT id FROM accounts);

ALTER TABLE manual_account_values
  ADD CONSTRAINT manual_account_values_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;

DELETE FROM investment_holdings
WHERE account_id NOT IN (SELECT id FROM accounts);

ALTER TABLE investment_holdings
  ADD CONSTRAINT investment_holdings_account_id_fkey_new
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
