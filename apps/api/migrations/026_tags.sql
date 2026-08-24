-- Transaction tags: freeform user-created labels
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive uniqueness: "Groceries" and "groceries" are the same tag
CREATE UNIQUE INDEX idx_tags_household_name ON tags(household_id, LOWER(name));

CREATE TABLE journal_entry_tags (
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (journal_entry_id, tag_id)
);

CREATE INDEX idx_journal_entry_tags_tag ON journal_entry_tags(tag_id);
