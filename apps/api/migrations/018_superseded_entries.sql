-- Support non-destructive merge: superseded entries point to their replacement
ALTER TABLE journal_entries ADD COLUMN superseded_by TEXT REFERENCES journal_entries(id) ON DELETE SET NULL;
CREATE INDEX idx_journal_entries_superseded ON journal_entries(superseded_by) WHERE superseded_by IS NOT NULL;
