-- Entry-level exclude_from_totals override (nullable — falls back to account default)
ALTER TABLE journal_entries ADD COLUMN exclude_from_totals BOOLEAN;
