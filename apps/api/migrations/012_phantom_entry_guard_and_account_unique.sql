-- 1. Prevent phantom entries (zero lines remaining after partial delete)
CREATE OR REPLACE FUNCTION check_journal_balance()
RETURNS TRIGGER AS $$
DECLARE
  entry_sum NUMERIC(14,2);
  line_count INTEGER;
  check_entry_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    check_entry_id := OLD.journal_entry_id;
  ELSE
    check_entry_id := NEW.journal_entry_id;
  END IF;

  -- Check if entry still exists (CASCADE delete of parent removes all lines)
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = check_entry_id) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  SELECT COUNT(*), COALESCE(SUM(amount), 0)
  INTO line_count, entry_sum
  FROM journal_lines
  WHERE journal_entry_id = check_entry_id;

  -- Reject phantom entries (header with no lines)
  IF line_count = 0 THEN
    RAISE EXCEPTION 'Journal entry % has no lines — phantom entry', check_entry_id;
  END IF;

  -- Reject unbalanced entries
  IF entry_sum != 0 THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced: sum = %', check_entry_id, entry_sum;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

-- 2. Prevent duplicate accounts (e.g., two "Uncategorized" from concurrent syncs)
CREATE UNIQUE INDEX uq_accounts_household_name_type
  ON accounts(household_id, name, account_type);
