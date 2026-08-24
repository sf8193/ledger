-- 7. Prevent duplicate accounts on retry
ALTER TABLE financial_accounts ADD CONSTRAINT uq_account_household_name_type
  UNIQUE(household_id, name, type);

-- 8. FK from household_members to user table (Better Auth)
ALTER TABLE household_members ADD CONSTRAINT fk_household_members_user
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;

-- 9. Category children cascade with parent deletion
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_parent_id_fkey;
ALTER TABLE categories ADD CONSTRAINT categories_parent_id_fkey
  FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE CASCADE;

-- 10. Prevent duplicate category rules
ALTER TABLE category_rules ADD CONSTRAINT uq_category_rule
  UNIQUE(household_id, match_field, match_type, match_value);

-- 11. Missing index on plaid_items(household_id)
CREATE INDEX idx_plaid_items_household ON plaid_items(household_id);
