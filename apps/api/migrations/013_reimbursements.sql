-- Reimbursement tracking system
-- Adds exclude_from_totals on accounts (general reporting filter)
-- Adds reimbursement lifecycle fields on journal_entries

-- 1. General exclusion flag on accounts
ALTER TABLE accounts ADD COLUMN exclude_from_totals BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Reimbursement lifecycle on journal entries
ALTER TABLE journal_entries ADD COLUMN reimbursement_status TEXT
  CHECK (reimbursement_status IN ('pending', 'partial', 'reimbursed'));
ALTER TABLE journal_entries ADD COLUMN reimbursement_group_id TEXT;

-- Index for pending reimbursement queries
CREATE INDEX idx_journal_entries_reimbursement_status
  ON journal_entries(household_id, reimbursement_status)
  WHERE reimbursement_status IS NOT NULL;

-- Index for grouping linked reimbursements
CREATE INDEX idx_journal_entries_reimbursement_group
  ON journal_entries(reimbursement_group_id)
  WHERE reimbursement_group_id IS NOT NULL;
