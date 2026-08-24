import { Router, type Router as RouterType } from 'express';
import { db } from '../db/kysely';
import { syncAllItemsForHousehold } from '../services/sync';
import { z } from 'zod';
import { verifyPlaidWebhook } from '../lib/webhook-verification';
import { logger } from '../lib/logger';

const log = logger.child({ context: 'webhook' });

export const webhookRouter: RouterType = Router();

const webhookSchema = z.object({
  webhook_type: z.string(),
  webhook_code: z.string(),
  item_id: z.string(),
  error: z.any().optional(),
  new_transactions: z.number().optional(),
});

/**
 * POST /api/webhook/plaid
 *
 * Public endpoint — no auth middleware. Plaid sends webhooks here.
 * JWT signature verification via Plaid-Verification header.
 */
webhookRouter.post('/plaid', async (req, res) => {
  // Verify webhook signature (skipped in sandbox)
  const rawBody = req.rawBody || JSON.stringify(req.body);
  const verified = await verifyPlaidWebhook(
    req.headers['plaid-verification'] as string | undefined,
    rawBody,
  );

  if (!verified) {
    log.warn('Verification failed — rejecting');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Validate payload — return generic 400 on failure (no schema leaks)
  const parsed = webhookSchema.safeParse(req.body);
  if (!parsed.success) {
    log.warn('Invalid payload received');
    return res.status(400).json({ error: 'Bad request' });
  }

  const payload = parsed.data;
  log.info({ type: payload.webhook_type, code: payload.webhook_code, itemId: payload.item_id },
    `${payload.webhook_type}:${payload.webhook_code}`);

  // Find the plaid item by Plaid's item_id
  const item = await db
    .selectFrom('plaid_items')
    .where('item_id', '=', payload.item_id)
    .select(['id', 'household_id', 'status'])
    .executeTakeFirst();

  if (!item) {
    log.warn({ itemId: payload.item_id }, 'Unknown item_id');
    return res.json({ received: true });
  }

  switch (payload.webhook_type) {
    case 'TRANSACTIONS': {
      switch (payload.webhook_code) {
        case 'SYNC_UPDATES_AVAILABLE':
        case 'INITIAL_UPDATE':
        case 'HISTORICAL_UPDATE':
        case 'DEFAULT_UPDATE':
        case 'TRANSACTIONS_REMOVED':
          if (item.status !== 'active') {
            log.info({ itemId: item.id, status: item.status }, 'Skipping sync — item not active');
            break;
          }
          // Fire-and-forget: respond to Plaid immediately, sync in background
          const triggerReqId = req.reqId;
          syncAllItemsForHousehold(item.household_id, item.id)
            .then((result) => {
              log.info({ itemId: item.id, triggerReqId, ...result }, 'Webhook sync complete');
            })
            .catch((err: any) => {
              log.error({ err, itemId: item.id, triggerReqId }, 'Webhook sync failed');
            });
          break;
      }
      break;
    }

    case 'ITEM': {
      switch (payload.webhook_code) {
        case 'ERROR':
          if (payload.error?.error_code === 'ITEM_LOGIN_REQUIRED') {
            await db.updateTable('plaid_items')
              .set({ status: 'reauth_needed' })
              .where('id', '=', item.id)
              .execute();
            log.warn({ itemId: item.id }, 'Item needs re-authentication');
          } else {
            await db.updateTable('plaid_items')
              .set({ status: 'error' })
              .where('id', '=', item.id)
              .execute();
            log.error({ itemId: item.id, plaidError: payload.error }, 'Item error');
          }
          break;

        case 'PENDING_EXPIRATION':
          log.warn({ itemId: item.id }, 'Item pending expiration — user needs to re-link');
          break;
      }
      break;
    }
  }

  // Always respond 200 to Plaid — retries happen on non-2xx
  res.json({ received: true });
});
