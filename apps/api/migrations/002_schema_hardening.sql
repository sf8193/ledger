-- 1. Encrypt plaid access tokens (column rename signals encrypted storage)
ALTER TABLE plaid_items RENAME COLUMN access_token TO access_token_encrypted;

-- 2. TEXT date columns -> DATE
ALTER TABLE transactions ALTER COLUMN date TYPE DATE USING date::DATE;
ALTER TABLE balance_snapshots ALTER COLUMN date TYPE DATE USING date::DATE;
ALTER TABLE manual_account_values ALTER COLUMN date TYPE DATE USING date::DATE;

-- 3. NUMERIC -> NUMERIC(14,2) for all money columns
ALTER TABLE financial_accounts ALTER COLUMN current_balance TYPE NUMERIC(14,2);
ALTER TABLE financial_accounts ALTER COLUMN available_balance TYPE NUMERIC(14,2);
ALTER TABLE transactions ALTER COLUMN amount TYPE NUMERIC(14,2);
ALTER TABLE balance_snapshots ALTER COLUMN balance TYPE NUMERIC(14,2);
ALTER TABLE manual_account_values ALTER COLUMN value TYPE NUMERIC(14,2);
ALTER TABLE investment_holdings ALTER COLUMN price TYPE NUMERIC(14,4);
ALTER TABLE investment_holdings ALTER COLUMN cost_basis TYPE NUMERIC(14,2);
ALTER TABLE investment_holdings ALTER COLUMN quantity TYPE NUMERIC(18,6);

-- 4. Add updated_at to mutable tables
ALTER TABLE financial_accounts ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE transactions ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE categories ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE category_rules ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 5. Constrain household member roles
ALTER TABLE household_members ADD CONSTRAINT chk_role CHECK (role IN ('owner', 'member', 'viewer'));

-- 6. Replace stored value with generated column on investment_holdings
ALTER TABLE investment_holdings DROP COLUMN value;
ALTER TABLE investment_holdings ADD COLUMN value NUMERIC(14,2) GENERATED ALWAYS AS (quantity * price) STORED;
