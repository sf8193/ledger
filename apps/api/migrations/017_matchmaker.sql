-- Store Plaid's personal_finance_category on journal entries
ALTER TABLE journal_entries ADD COLUMN plaid_category TEXT;

-- Category rules for auto-categorization
CREATE TABLE category_rules (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  target_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  match_field TEXT NOT NULL CHECK (match_field IN ('description', 'merchant_name')),
  match_type TEXT NOT NULL CHECK (match_type IN ('contains', 'equals', 'starts_with')),
  match_value TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(household_id, match_field, match_type, match_value)
);

CREATE INDEX idx_category_rules_household ON category_rules(household_id);

-- Match suggestions (transfers, recurring patterns, cc payments)
CREATE TABLE match_suggestions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  match_type TEXT NOT NULL CHECK (match_type IN ('transfer', 'cc_payment', 'recurring')),
  entry_a_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  entry_b_id TEXT REFERENCES journal_entries(id) ON DELETE CASCADE,
  confidence NUMERIC(3,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'dismissed')),
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_match_suggestions_household ON match_suggestions(household_id, status);
CREATE INDEX idx_match_suggestions_entry_a ON match_suggestions(entry_a_id);
CREATE INDEX idx_match_suggestions_entry_b ON match_suggestions(entry_b_id);
