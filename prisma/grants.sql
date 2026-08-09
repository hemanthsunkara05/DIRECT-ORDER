-- Run after every `prisma migrate dev` / `prisma migrate deploy`, using
-- the OWNER role (DATABASE_URL) via `pnpm db:grants` — never hand-run
-- against production without going through that script, so the two stay
-- in sync.
--
-- Grants the restricted runtime role (direct_order_app in local
-- development; production names its own equivalent) exactly the
-- privileges the running application needs, and nothing more. In
-- particular: never UPDATE or DELETE on audit_logs, which must remain
-- append-only even to the application itself
-- (PRODUCT/docs/02-database-schema.md, audit_logs;
-- PRODUCT/docs/16-execution-protocol.md rule 9 — never delete financial
-- or audit records).
--
-- Idempotent: safe to re-run after every future migration. Uses
-- ALTER DEFAULT PRIVILEGES so tables created by LATER migrations
-- (run by this same owner role) automatically pick up the same grants
-- without this file needing to change.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'direct_order_app') THEN
    RAISE EXCEPTION
      'Role "direct_order_app" does not exist. Create it first — see infrastructure/postgres/init/01-create-app-role.sql (local dev) or your production role-provisioning process.';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO direct_order_app;

-- Broad default: the application can read and write ordinary tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO direct_order_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO direct_order_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO direct_order_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO direct_order_app;

-- audit_logs is append-only, even to the application itself: only
-- SELECT and INSERT. This narrows the broad grant above. If audit_logs
-- does not exist yet (grants applied before Phase 2's migration), this
-- statement is a harmless no-op error we deliberately ignore via
-- exception handling — re-running db:grants after the migration exists
-- will apply it correctly.
DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'audit_logs') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON audit_logs FROM direct_order_app';
  END IF;
END $$;
