import 'dotenv/config';
import { Kysely, Migration, MigrationProvider, sql } from 'kysely';
import { promises as fs } from 'fs';
import * as path from 'path';
import { getMigrations as getBetterAuthMigrations } from 'better-auth/db/migration';
import { db } from './kysely';
import { pool } from './pool';
import { Migrator } from 'kysely';
import { authOptions } from '../lib/auth';

class HybridMigrationProvider implements MigrationProvider {
  private folder: string;

  constructor(folder: string) {
    this.folder = folder;
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    const migrations: Record<string, Migration> = {};
    const files = await fs.readdir(this.folder);

    const migrationFiles = files
      .filter((f) => f.endsWith('.sql') || (f.endsWith('.ts') && !f.endsWith('.d.ts')))
      .sort();

    for (const file of migrationFiles) {
      const filePath = path.join(this.folder, file);
      const name = file.replace(/\.(sql|ts)$/, '');

      if (migrations[name]) continue;

      if (file.endsWith('.sql')) {
        const sqlContent = await fs.readFile(filePath, 'utf8');
        migrations[name] = {
          up: async (db: Kysely<any>) => {
            await sql.raw(sqlContent).execute(db);
          },
        };
      } else {
        const module = await import(filePath);
        migrations[name] = {
          up: module.up,
          down: module.down,
        };
      }
    }

    return migrations;
  }
}

const migrator = new Migrator({
  db,
  provider: new HybridMigrationProvider(path.join(__dirname, '../../migrations')),
});

async function runBetterAuthMigrations() {
  console.log('Running better-auth migrations...');
  try {
    const { toBeCreated, toBeAdded, runMigrations } = await getBetterAuthMigrations(authOptions);

    if (toBeCreated.length === 0 && toBeAdded.length === 0) {
      console.log('No better-auth migrations to run');
      return;
    }

    if (toBeCreated.length > 0) {
      console.log(`  Tables to create: ${toBeCreated.map(t => t.table).join(', ')}`);
    }
    if (toBeAdded.length > 0) {
      console.log(`  Columns to add: ${toBeAdded.map(t => `${t.table}.${Object.keys(t.fields).join(', ')}`).join('; ')}`);
    }

    await runMigrations();
    console.log('better-auth migrations completed');
  } catch (error) {
    console.error('better-auth migration failed:', error);
    throw error;
  }
}

export async function runMigrations() {
  await runBetterAuthMigrations();

  console.log('\nRunning custom migrations...');

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.log(`✓ ${it.migrationName}`);
    } else if (it.status === 'Error') {
      console.error(`✗ ${it.migrationName}`);
    }
  });

  if (error) {
    console.error('Migration failed:', error);
    throw error;
  }

  if (!results?.length) {
    console.log('No pending migrations');
  } else {
    console.log('All migrations completed');
  }
}

export async function getMigrationStatus() {
  const migrations = await migrator.getMigrations();

  console.log('\nMigration Status:');
  console.log('─'.repeat(50));

  for (const migration of migrations) {
    const status = migration.executedAt ? '✓' : '○';
    const date = migration.executedAt
      ? new Date(migration.executedAt).toISOString().split('T')[0]
      : 'pending';
    console.log(`${status} ${migration.name.padEnd(40)} ${date}`);
  }
}

// CLI runner
if (require.main === module) {
  const command = process.argv[2];

  (async () => {
    try {
      switch (command) {
        case 'up':
        case 'migrate':
          await runMigrations();
          break;
        case 'status':
          await getMigrationStatus();
          break;
        default:
          console.log('Usage: tsx src/db/migrator.ts [command]');
          console.log('  up/migrate - Run all pending migrations');
          console.log('  status     - Show migration status');
      }
    } catch (error) {
      console.error(error);
      process.exit(1);
    } finally {
      await pool.end();
    }
  })();
}
