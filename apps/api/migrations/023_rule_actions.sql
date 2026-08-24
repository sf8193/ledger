-- Expand category_rules with additional actions (Monarch-style rule builder)
-- Rules can now rename merchants, set owner, and hide transactions

ALTER TABLE category_rules ADD COLUMN rename_merchant TEXT;
ALTER TABLE category_rules ADD COLUMN set_owner TEXT;
ALTER TABLE category_rules ADD COLUMN set_exclude BOOLEAN;
