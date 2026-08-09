/**
 * Applies prisma/grants.sql using the owner/migration role (DATABASE_URL).
 * Uses the `pg` driver directly rather than shelling out to `psql`, which
 * is not installed by default on every platform this might run on
 * (notably Windows) — this script only needs Node, matching the rest of
 * the toolchain.
 *
 * Run after every `pnpm db:migrate` / `pnpm db:migrate:deploy`:
 *
 *   pnpm db:migrate && pnpm db:grants
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    '[db:grants] DATABASE_URL is required (the owner/migration role connection string, same one prisma migrate uses).',
  );
  process.exit(1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const grantsPath = path.join(scriptDir, '..', 'prisma', 'grants.sql');
const sql = readFileSync(grantsPath, 'utf8');

const client = new pg.Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query(sql);
  console.log('[db:grants] Applied prisma/grants.sql successfully.');
} catch (error) {
  console.error('[db:grants] Failed to apply grants:', error);
  process.exit(1);
} finally {
  await client.end();
}
