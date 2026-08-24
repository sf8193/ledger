-- Drop the cache column. The ledger is the single source of truth.
-- current_balance was a denormalized cache that caused every major
-- bug in the review cycle. All reads now use SUM(journal_lines.amount).

ALTER TABLE accounts DROP COLUMN current_balance;
