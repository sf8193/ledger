-- Track why a transaction was categorized (matchmaker audit trail)
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS categorized_by TEXT;
