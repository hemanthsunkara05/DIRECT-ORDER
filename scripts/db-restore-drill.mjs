#!/usr/bin/env node
// docs/13-implementation-phases.md, Phase 19: "Backup configuration
// and a completed restore drill... Report RESTORE VERIFIED only if a
// restore drill actually passed." docs/10-infrastructure-deployment.md
// §16.4: "a backup that has never been restored is not a backup."
//
// This sandbox has no `pg_dump`/`pg_restore`/`psql`/`docker` CLI
// available (checked directly — see PHASE_REPORTS.md's Phase 19 entry)
// even though the real Postgres server itself is reachable, so this
// drill uses Prisma's own schema-qualified connection strings instead
// of the shell pg_dump/pg_restore pair a real deploy would use
// (documented as the actual production mechanism in
// docs/10-infrastructure-deployment.md §16.4 — this script is a
// same-server substitute proving the underlying recoverability
// property, not a replacement for that tooling).
//
// Mechanism: extract real rows from a representative set of the
// highest-value tables (docs/09-security.md §15.1's own asset-ranking:
// payment integrity, tenant isolation, customer PII) out of the
// `public` schema, "restore" them into a freshly `prisma migrate
// deploy`-created, completely isolated `restore_drill` schema on the
// SAME database server (never touching `public`'s real rows — this is
// additive-only against a disposable, empty schema), verify row counts
// and a content checksum match exactly, then drop the disposable
// schema. A schema-level restore into the same server is a weaker
// claim than restoring onto genuinely separate infrastructure, but it
// is a REAL backup-artifact extraction and a REAL, verified
// re-insertion — not a simulation.

import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';

const envFile = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const ownerUrl = envFile.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
if (!ownerUrl) {
  console.error('DATABASE_URL not found in .env');
  process.exit(1);
}

const DRILL_SCHEMA = 'restore_drill';
const drillUrl = ownerUrl.includes('?')
  ? ownerUrl.replace(/schema=[^&]+/, `schema=${DRILL_SCHEMA}`)
  : `${ownerUrl}?schema=${DRILL_SCHEMA}`;

// Step [2] ("prisma migrate deploy" against DATABASE_URL=<drillUrl>) is
// run as a separate shell command BEFORE this script, not spawned from
// within it — nested child_process spawning of npx/.cmd from inside a
// Node script proved unreliable on this Windows sandbox (ENOENT/EINVAL
// spawning cmd.exe/npx.cmd depending on the shell/no-shell combination
// tried); a plain top-level shell command has no such issue. Readiness
// is detected automatically (query the drill schema for its migrations
// table) rather than trusted from an env var, so this script never
// silently "restores" into a schema that isn't actually migrated.
async function isDrillSchemaReady() {
  const probe = new PrismaClient({ datasources: { db: { url: drillUrl } } });
  try {
    const rows = await probe.$queryRawUnsafe(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = '_prisma_migrations'`,
      DRILL_SCHEMA,
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  } finally {
    await probe.$disconnect();
  }
}

if (!(await isDrillSchemaReady())) {
  console.error(
    [
      'The disposable drill schema is not migrated yet — run this exact prerequisite command first',
      '(from the repo root, with .env sourced):',
      '',
      `  DATABASE_URL="${drillUrl}" npx prisma migrate deploy --schema prisma/schema.prisma`,
      '',
      'Then re-run: pnpm db:restore-drill',
      '',
      'See DISASTER_RECOVERY.md for the full documented procedure.',
    ].join('\n'),
  );
  process.exit(1);
}

// Dependency-safe insertion order for this representative subset —
// every table an `Order` row can transitively reference via a
// required or populated-in-practice foreign key, so a real backed-up
// Order can actually be re-inserted (found the hard way: the first
// drill run failed on `orders_promotion_id_fkey` because `promotion`
// wasn't in this list, and `orderItem.menuItemId` needs `menuItem`/
// `menuCategory`).
const TABLES = [
  'user',
  'restaurant',
  'restaurantAddress',
  'menuCategory',
  'menuItem',
  'customer',
  'promotion',
  'order',
  'orderItem',
  'payment',
  'refund',
  'auditLog',
];

function checksum(rows) {
  const json = JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  return createHash('sha256').update(json).digest('hex');
}

async function main() {
  console.log('=== Phase 19 restore drill ===');
  const source = new PrismaClient({ datasources: { db: { url: ownerUrl } } });

  console.log('\n[1] Extracting real rows from the live `public` schema (the "backup")');
  const backup = {};
  for (const table of TABLES) {
    backup[table] = await source[table].findMany();
    console.log(`  ${table}: ${backup[table].length} rows`);
  }
  await source.$disconnect();

  console.log(`\n[2] "${DRILL_SCHEMA}" schema already migrated by the caller (see DISASTER_RECOVERY.md) — proceeding to restore.`);

  console.log('\n[3] Restoring the extracted rows into the fresh schema, in dependency order');
  const restore = new PrismaClient({ datasources: { db: { url: drillUrl } } });
  for (const table of TABLES) {
    if (backup[table].length === 0) continue;
    // createMany, not one create() per row — this drill is about
    // proving the DATA is restorable, not re-exercising this
    // codebase's own business-logic validation on each row.
    await restore[table].createMany({ data: backup[table] });
  }

  console.log('\n[4] Verifying: row counts and a content checksum match exactly, per table');
  let allPassed = true;
  for (const table of TABLES) {
    const restored = await restore[table].findMany();
    const countMatch = restored.length === backup[table].length;
    const sumChecksum = checksum(backup[table].sort((a, b) => String(a.id).localeCompare(String(b.id))));
    const restoredChecksum = checksum(restored.sort((a, b) => String(a.id).localeCompare(String(b.id))));
    const contentMatch = sumChecksum === restoredChecksum;
    const passed = countMatch && contentMatch;
    allPassed &&= passed;
    console.log(
      `  ${table}: ${passed ? 'PASS' : 'FAIL'} (backup=${backup[table].length} restored=${restored.length}, checksum ${contentMatch ? 'matches' : 'MISMATCH'})`,
    );
  }
  await restore.$disconnect();

  console.log(`\n[5] Cleaning up: dropping the disposable "${DRILL_SCHEMA}" schema`);
  const cleanup = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
  await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${DRILL_SCHEMA}" CASCADE`);
  await cleanup.$disconnect();

  console.log(allPassed ? '\n=== RESTORE VERIFIED ===' : '\n=== RESTORE DRILL FAILED ===');
  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error('Restore drill errored:', error);
  process.exit(1);
});
