-- Better Auth 1.7+ requires an `issuer` column on the account table.
-- Populate from existing providerId values.
ALTER TABLE account ADD COLUMN IF NOT EXISTS issuer TEXT;
UPDATE account SET issuer = "providerId" WHERE issuer IS NULL;
ALTER TABLE account ALTER COLUMN issuer SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS account_issuer_accountId_idx ON account (issuer, "accountId");
