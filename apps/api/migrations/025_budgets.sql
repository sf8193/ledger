-- Envelope budgeting (YNAB-style: give every dollar a job)

-- Surplus routing: leftover income after filling envelopes goes here
ALTER TABLE households ADD COLUMN surplus_category_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;

-- Budget envelopes per category
CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  monthly_amount NUMERIC(14,2) NOT NULL CHECK (monthly_amount > 0),
  priority INTEGER NOT NULL DEFAULT 0,         -- lower = filled first (0 = needs, 100 = wants, 200 = savings)
  rollover_cap NUMERIC(14,2) DEFAULT NULL,     -- NULL = unlimited rollover, >0 = cap excess
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (household_id, category_id)
);

CREATE INDEX idx_budgets_household ON budgets(household_id);

-- Per-month envelope allocations: how much assigned to each category each month
CREATE TABLE budget_allocations (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  month TEXT NOT NULL,  -- 'YYYY-MM'
  assigned NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (household_id, category_id, month)
);

CREATE INDEX idx_budget_allocations_household_month ON budget_allocations(household_id, month);
