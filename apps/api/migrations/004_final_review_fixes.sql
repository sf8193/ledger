-- 12. Enforce single-household-per-user at DB level
CREATE UNIQUE INDEX uq_household_members_user ON household_members(user_id);

-- 13. Widen generated value column for fractional share precision
ALTER TABLE investment_holdings DROP COLUMN value;
ALTER TABLE investment_holdings ADD COLUMN value NUMERIC(18,4) GENERATED ALWAYS AS (quantity * price) STORED;

-- 14. Drop over-broad unique constraint on accounts
ALTER TABLE financial_accounts DROP CONSTRAINT IF EXISTS uq_account_household_name_type;
