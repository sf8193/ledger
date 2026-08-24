-- Drop 'partial' from reimbursement_status (binary: pending or reimbursed)
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_reimbursement_status_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_reimbursement_status_check
  CHECK (reimbursement_status IN ('pending', 'reimbursed'));

-- Clean up any existing partial statuses
UPDATE journal_entries SET reimbursement_status = 'pending'
  WHERE reimbursement_status = 'partial';
