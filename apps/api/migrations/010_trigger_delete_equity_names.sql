-- 1. Add DELETE to zero-sum trigger
DROP TRIGGER IF EXISTS trg_journal_balance ON journal_lines;

CREATE CONSTRAINT TRIGGER trg_journal_balance
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_journal_balance();

-- 2. The trigger function needs to handle DELETE (use OLD.journal_entry_id)
CREATE OR REPLACE FUNCTION check_journal_balance()
RETURNS TRIGGER AS $$
DECLARE
  entry_sum NUMERIC(14,2);
  check_entry_id TEXT;
BEGIN
  -- Use NEW for INSERT/UPDATE, OLD for DELETE
  IF TG_OP = 'DELETE' THEN
    check_entry_id := OLD.journal_entry_id;
  ELSE
    check_entry_id := NEW.journal_entry_id;
  END IF;

  -- Check if entry still exists (CASCADE delete of parent removes all lines)
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = check_entry_id) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    ELSE
      RETURN NEW;
    END IF;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO entry_sum
  FROM journal_lines
  WHERE journal_entry_id = check_entry_id;

  IF entry_sum != 0 THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced: sum = %', check_entry_id, entry_sum;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;
