CREATE TABLE tax_scenarios (
  id VARCHAR(21) PRIMARY KEY,
  household_id VARCHAR(21) NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  tax_year INT NOT NULL,
  name VARCHAR(200) NOT NULL DEFAULT 'Default',
  inputs JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(household_id, tax_year, name)
);
