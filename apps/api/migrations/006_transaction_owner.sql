-- First-class owner field on transactions
ALTER TABLE transactions ADD COLUMN owner TEXT;

-- Index for filtering by owner
CREATE INDEX idx_transactions_owner ON transactions(household_id, owner);
