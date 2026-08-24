-- Ensure system-created accounts (Reimbursements, Opening Balances, Uncategorized)
-- are unique per household by (household_id, account_type, name)
-- Partial index: only applies to system accounts (is_manual = false)
CREATE UNIQUE INDEX uq_system_accounts
  ON accounts(household_id, account_type, name)
  WHERE is_manual = false;
