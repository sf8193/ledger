import { betterAuth, type BetterAuthOptions } from 'better-auth';
import dotenv from 'dotenv';
import { pool } from '../db/pool';
import { db } from '../db/kysely';
import { nanoid } from 'nanoid';

dotenv.config();

export const authOptions: BetterAuthOptions = {
  database: pool,
  trustedOrigins: [process.env.FRONTEND_URL || 'http://localhost:5173'],
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24,
  },
  baseURL: process.env.BASE_URL || 'http://localhost:4000',
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // Auto-create household for new users (covers OAuth sign-ups)
          const existing = await db
            .selectFrom('household_members')
            .where('user_id', '=', user.id)
            .selectAll()
            .executeTakeFirst();

          if (!existing) {
            const householdId = nanoid();
            const memberId = nanoid();
            await db.transaction().execute(async (tx) => {
              await tx.insertInto('households').values({
                id: householdId,
                name: `${user.name || 'My'}'s Household`,
                created_at: new Date().toISOString(),
              }).execute();
              await tx.insertInto('household_members').values({
                id: memberId,
                household_id: householdId,
                user_id: user.id,
                role: 'owner',
                created_at: new Date().toISOString(),
              }).execute();
            });
          }
        },
      },
    },
  },
};

export const auth = betterAuth(authOptions);
