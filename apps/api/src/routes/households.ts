import { Router, type Router as RouterType } from 'express';
import { db } from '../db/kysely';
import { sql, type SqlBool } from 'kysely';
import { nanoid } from 'nanoid';
import { randomBytes } from 'crypto';
import { asyncHandler } from '../middleware/error';

export const householdsRouter: RouterType = Router();

// List all households the current user belongs to
householdsRouter.get('/', asyncHandler(async (req, res) => {
  const userId = req.auth!.userId;

  const memberships = await db
    .selectFrom('household_members')
    .innerJoin('households', 'households.id', 'household_members.household_id')
    .where('household_members.user_id', '=', userId)
    .select([
      'households.id',
      'households.name',
      'household_members.role',
      'household_members.created_at as joined_at',
    ])
    .execute();

  res.json(memberships);
}));

// List members of a household (must be a member)
householdsRouter.get('/:householdId/members', asyncHandler(async (req, res) => {
  const userId = req.auth!.userId;
  const { householdId } = req.params;

  // Verify caller is a member
  const membership = await db
    .selectFrom('household_members')
    .where('household_id', '=', householdId)
    .where('user_id', '=', userId)
    .selectAll()
    .executeTakeFirst();

  if (!membership) {
    res.status(403).json({ error: 'Not a member of this household' });
    return;
  }

  const members = await db
    .selectFrom('household_members')
    .innerJoin('user', 'user.id', 'household_members.user_id')
    .where('household_members.household_id', '=', householdId)
    .select([
      'household_members.id',
      'user.id as user_id',
      'user.name',
      'user.email',
      'household_members.role',
      'household_members.created_at as joined_at',
    ])
    .execute();

  res.json(members);
}));

// Create an invite (owner only)
householdsRouter.post('/:householdId/invites', asyncHandler(async (req, res) => {
  const userId = req.auth!.userId;
  const { householdId } = req.params;
  const { email, role = 'member' } = req.body;

  if (!email) {
    res.status(400).json({ error: 'Email is required' });
    return;
  }

  if (!['member', 'viewer'].includes(role)) {
    res.status(400).json({ error: 'Role must be member or viewer' });
    return;
  }

  // Verify caller is owner
  const membership = await db
    .selectFrom('household_members')
    .where('household_id', '=', householdId)
    .where('user_id', '=', userId)
    .where('role', '=', 'owner')
    .selectAll()
    .executeTakeFirst();

  if (!membership) {
    res.status(403).json({ error: 'Only owners can invite members' });
    return;
  }

  // Check if user is already a member
  const existingMember = await db
    .selectFrom('household_members')
    .innerJoin('user', 'user.id', 'household_members.user_id')
    .where('household_members.household_id', '=', householdId)
    .where('user.email', '=', email)
    .selectAll()
    .executeTakeFirst();

  if (existingMember) {
    res.status(409).json({ error: 'User is already a member' });
    return;
  }

  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await db.insertInto('household_invites').values({
    id: nanoid(),
    household_id: householdId,
    email,
    role,
    invited_by: userId,
    token,
    expires_at: expiresAt.toISOString(),
    created_at: new Date().toISOString(),
  }).execute();

  res.json({ token, expires_at: expiresAt.toISOString() });
}));

// List pending invites for a household (owner only)
householdsRouter.get('/:householdId/invites', asyncHandler(async (req, res) => {
  const userId = req.auth!.userId;
  const { householdId } = req.params;

  const membership = await db
    .selectFrom('household_members')
    .where('household_id', '=', householdId)
    .where('user_id', '=', userId)
    .where('role', '=', 'owner')
    .selectAll()
    .executeTakeFirst();

  if (!membership) {
    res.status(403).json({ error: 'Only owners can view invites' });
    return;
  }

  const invites = await db
    .selectFrom('household_invites')
    .where('household_id', '=', householdId)
    .where('accepted_at', 'is', null)
    .where(sql<SqlBool>`expires_at > now()`)
    .selectAll()
    .execute();

  res.json(invites);
}));

// Accept an invite by token
householdsRouter.post('/join/:token', asyncHandler(async (req, res) => {
  const userId = req.auth!.userId;
  const { token } = req.params;

  // Verify the accepting user's email
  const user = await db
    .selectFrom('user')
    .where('id', '=', userId)
    .select('email')
    .executeTakeFirst();

  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }

  // Atomic: claim the invite and insert membership in one transaction
  const result = await db.transaction().execute(async (tx) => {
    // Atomically claim the invite (UPDATE ... WHERE accepted_at IS NULL)
    const claimed = await tx.updateTable('household_invites')
      .set({ accepted_at: new Date().toISOString() })
      .where('token', '=', token)
      .where('accepted_at', 'is', null)
      .where('email', '=', user.email)
      .where(sql<SqlBool>`expires_at > now()`)
      .returningAll()
      .executeTakeFirst();

    if (!claimed) {
      return null;
    }

    // Insert membership (unique constraint on (household_id, user_id) prevents duplicates)
    try {
      await tx.insertInto('household_members').values({
        id: nanoid(),
        household_id: claimed.household_id,
        user_id: userId,
        role: claimed.role,
        created_at: new Date().toISOString(),
      }).execute();
    } catch (err: any) {
      if (err.code === '23505') {
        return { household_id: claimed.household_id, already_member: true };
      }
      throw err;
    }

    return { household_id: claimed.household_id };
  });

  if (!result) {
    res.status(404).json({ error: 'Invalid or expired invite, or email mismatch' });
    return;
  }

  if ('already_member' in result) {
    res.status(409).json({ error: 'Already a member of this household' });
    return;
  }

  res.json({ household_id: result.household_id });
}));

// Remove a member (owner only, can't remove self if sole owner)
householdsRouter.delete('/:householdId/members/:memberId', asyncHandler(async (req, res) => {
  const userId = req.auth!.userId;
  const { householdId, memberId } = req.params;

  const callerMembership = await db
    .selectFrom('household_members')
    .where('household_id', '=', householdId)
    .where('user_id', '=', userId)
    .where('role', '=', 'owner')
    .selectAll()
    .executeTakeFirst();

  if (!callerMembership) {
    res.status(403).json({ error: 'Only owners can remove members' });
    return;
  }

  const target = await db
    .selectFrom('household_members')
    .where('id', '=', memberId)
    .where('household_id', '=', householdId)
    .selectAll()
    .executeTakeFirst();

  if (!target) {
    res.status(404).json({ error: 'Member not found' });
    return;
  }

  // Don't allow removing the sole owner
  if (target.role === 'owner') {
    const ownerCount = await db
      .selectFrom('household_members')
      .where('household_id', '=', householdId)
      .where('role', '=', 'owner')
      .select(db.fn.countAll<number>().as('count'))
      .executeTakeFirst();

    if (Number(ownerCount?.count) <= 1) {
      res.status(400).json({ error: 'Cannot remove the sole owner' });
      return;
    }
  }

  await db.deleteFrom('household_members')
    .where('id', '=', memberId)
    .execute();

  res.json({ ok: true });
}));

// Transfer ownership (owner only)
householdsRouter.post('/:householdId/transfer/:memberId', asyncHandler(async (req, res) => {
  const userId = req.auth!.userId;
  const { householdId, memberId } = req.params;

  const callerMembership = await db
    .selectFrom('household_members')
    .where('household_id', '=', householdId)
    .where('user_id', '=', userId)
    .where('role', '=', 'owner')
    .selectAll()
    .executeTakeFirst();

  if (!callerMembership) {
    res.status(403).json({ error: 'Only owners can transfer ownership' });
    return;
  }

  const target = await db
    .selectFrom('household_members')
    .where('id', '=', memberId)
    .where('household_id', '=', householdId)
    .selectAll()
    .executeTakeFirst();

  if (!target) {
    res.status(404).json({ error: 'Member not found' });
    return;
  }

  if (target.role === 'owner') {
    res.status(400).json({ error: 'Member is already an owner' });
    return;
  }

  await db.updateTable('household_members')
    .set({ role: 'owner' })
    .where('id', '=', memberId)
    .execute();

  res.json({ ok: true });
}));

// Revoke an invite (owner only)
householdsRouter.delete('/:householdId/invites/:inviteId', asyncHandler(async (req, res) => {
  const userId = req.auth!.userId;
  const { householdId, inviteId } = req.params;

  const membership = await db
    .selectFrom('household_members')
    .where('household_id', '=', householdId)
    .where('user_id', '=', userId)
    .where('role', '=', 'owner')
    .selectAll()
    .executeTakeFirst();

  if (!membership) {
    res.status(403).json({ error: 'Only owners can revoke invites' });
    return;
  }

  const deleted = await db.deleteFrom('household_invites')
    .where('id', '=', inviteId)
    .where('household_id', '=', householdId)
    .where('accepted_at', 'is', null)
    .executeTakeFirst();

  if (Number(deleted.numDeletedRows) === 0) {
    res.status(404).json({ error: 'Invite not found or already accepted' });
    return;
  }

  res.json({ ok: true });
}));
