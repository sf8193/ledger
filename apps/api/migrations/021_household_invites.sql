-- Allow users to belong to multiple households
DROP INDEX IF EXISTS uq_household_members_user;

-- Invite tokens for joining a household
CREATE TABLE household_invites (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  invited_by TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_invite_role CHECK (role IN ('member', 'viewer'))
);

CREATE INDEX idx_household_invites_token ON household_invites(token);
CREATE INDEX idx_household_invites_email ON household_invites(email);
