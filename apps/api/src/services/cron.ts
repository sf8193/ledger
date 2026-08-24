import { db } from '../db/kysely';
import { sql } from 'kysely';
import { syncAllHouseholds } from './sync';
import { isPlaidConfigured } from '../lib/plaid';
import { logger } from '../lib/logger';

const log = logger.child({ context: 'cron' });

const SYNC_INTERVAL_MS = parseInt(process.env.SYNC_INTERVAL_HOURS || '6') * 60 * 60 * 1000;

let intervalId: ReturnType<typeof setInterval> | null = null;
let syncing = false;

async function runScheduledSync() {
  if (syncing) {
    log.info('Sync already in progress, skipping');
    return;
  }
  if (!isPlaidConfigured()) return;

  syncing = true;
  const start = Date.now();
  try {
    log.info('Starting scheduled sync...');
    await syncAllHouseholds();
    log.info({ duration: Date.now() - start }, 'Sync complete');
  } catch (err: any) {
    log.error({ err }, 'Scheduled sync failed');
  } finally {
    syncing = false;
  }
}

async function shouldSkipInitialSync(): Promise<boolean> {
  // Skip initial sync if any item was synced within the last hour
  const recentSync = await db
    .selectFrom('plaid_items')
    .where('status', '=', 'active')
    .where(eb => eb(sql`last_synced`, '>', sql`NOW() - INTERVAL '1 hour'`))
    .select('id')
    .executeTakeFirst();
  return !!recentSync;
}

export function startSyncCron() {
  if (!isPlaidConfigured()) {
    log.info('Plaid not configured, skipping scheduled sync');
    return;
  }

  const hours = SYNC_INTERVAL_MS / (60 * 60 * 1000);
  log.info({ intervalHours: hours }, `Scheduling Plaid sync every ${hours}h`);

  intervalId = setInterval(runScheduledSync, SYNC_INTERVAL_MS);

  // Run initial sync after 30s, but skip if recently synced (e.g. after restart)
  setTimeout(async () => {
    if (await shouldSkipInitialSync()) {
      log.info('Skipping initial sync — items were synced recently');
      return;
    }
    runScheduledSync();
  }, 30_000);
}

export function stopSyncCron() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
