import { Request, Response, NextFunction } from 'express';
import { db } from '../db/kysely';

export const householdMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!req.auth) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const requestedHouseholdId = req.headers['x-household-id'] as string | undefined;

  if (requestedHouseholdId) {
    // Verify user is a member of the requested household
    const member = await db
      .selectFrom('household_members')
      .where('user_id', '=', req.auth.userId)
      .where('household_id', '=', requestedHouseholdId)
      .select(['household_id'])
      .executeTakeFirst();

    if (!member) {
      res.status(403).json({ error: 'Not a member of this household' });
      return;
    }

    req.householdId = member.household_id;
  } else {
    // Default to first household
    const member = await db
      .selectFrom('household_members')
      .where('user_id', '=', req.auth.userId)
      .select(['household_id'])
      .executeTakeFirst();

    if (!member) {
      res.status(403).json({ error: 'No household found' });
      return;
    }

    req.householdId = member.household_id;
  }

  next();
};

declare global {
  namespace Express {
    interface Request {
      householdId?: string;
    }
  }
}
