-- Normalize existing owner values to title case for consistency
UPDATE journal_entries SET owner = initcap(lower(owner))
WHERE owner IS NOT NULL;
