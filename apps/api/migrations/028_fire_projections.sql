-- Tax treatment is a property of the account, not FIRE-specific
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tax_treatment TEXT;
-- values: 'taxable', 'tax_deferred', 'roth', NULL (unclassified)

-- FIRE projection scenarios and settings, persisted per household
CREATE TABLE IF NOT EXISTS fire_scenarios (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  inputs JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fire_settings (
  household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  settings JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-classify existing accounts by subtype
UPDATE accounts SET tax_treatment = 'roth' WHERE LOWER(subtype) LIKE '%roth%' OR LOWER(name) LIKE '%roth%';
UPDATE accounts SET tax_treatment = 'tax_deferred' WHERE tax_treatment IS NULL AND (
  LOWER(subtype) IN ('ira', '401k', '401a', '403b', '457b', 'sep', 'simple', 'keogh', 'traditional ira', 'hsa') OR
  LOWER(name) LIKE '%401k%' OR LOWER(name) LIKE '%401(k)%' OR LOWER(name) LIKE '%ira%' OR LOWER(name) LIKE '%403b%'
);
UPDATE accounts SET tax_treatment = 'taxable' WHERE tax_treatment IS NULL AND account_type = 'asset' AND (
  LOWER(subtype) IN ('checking', 'savings', 'brokerage', 'cash management', 'money market', 'cd') OR
  LOWER(name) LIKE '%checking%' OR LOWER(name) LIKE '%savings%' OR LOWER(name) LIKE '%brokerage%'
);
