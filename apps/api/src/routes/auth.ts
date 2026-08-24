import { Router, type Router as RouterType } from 'express';
import { db } from '../db/kysely';
import { nanoid } from 'nanoid';
import { authMiddleware } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';

export const authRouter: RouterType = Router();

authRouter.post('/setup', authMiddleware, asyncHandler(async (req, res) => {
  const userId = req.auth!.userId;

  // Check if already set up
  const existing = await db
    .selectFrom('household_members')
    .where('user_id', '=', userId)
    .selectAll()
    .executeTakeFirst();

  if (existing) {
    return res.json({ householdId: existing.household_id });
  }

  const householdId = nanoid();
  const memberId = nanoid();

  try {
    await db.transaction().execute(async (tx) => {
      await tx.insertInto('households').values({
        id: householdId,
        name: req.body.name || 'My Household',
        created_at: new Date().toISOString(),
      }).execute();

      await tx.insertInto('household_members').values({
        id: memberId,
        household_id: householdId,
        user_id: userId,
        role: 'owner',
        created_at: new Date().toISOString(),
      }).execute();
    });
  } catch (err: any) {
    // Race condition: another request already created the household
    if (err.code === '23505') {
      const member = await db
        .selectFrom('household_members')
        .where('user_id', '=', userId)
        .selectAll()
        .executeTakeFirst();
      return res.json({ householdId: member?.household_id });
    }
    throw err;
  }

  res.json({ householdId });
}));
