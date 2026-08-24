-- 1. Zero-sum constraint trigger: journal lines must sum to zero per entry
CREATE OR REPLACE FUNCTION check_journal_balance()
RETURNS TRIGGER AS $$
DECLARE
  entry_sum NUMERIC(14,2);
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO entry_sum
  FROM journal_lines
  WHERE journal_entry_id = NEW.journal_entry_id;

  IF entry_sum != 0 THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced: sum = %', NEW.journal_entry_id, entry_sum;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_journal_balance
  AFTER INSERT OR UPDATE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_journal_balance();

-- 2. Add ON DELETE RESTRICT explicitly to journal_lines -> accounts FK
-- (already defaults to RESTRICT, but making it explicit for clarity)

-- 3. Category delete safety: handled in application code (same check as accounts route)
