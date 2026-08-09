# Direct-Order

Commission-free direct-ordering platform for independent Indian restaurants. Each restaurant gets a branded ordering link, a real-time order dashboard, online payments, and transparent visibility into every rupee — without giving up 25–35% of order value to an aggregator.

**Status:** Phase 1 (Foundation) — see [PRODUCT/docs/13-implementation-phases.md](PRODUCT/docs/13-implementation-phases.md). No product features exist yet; this phase establishes the engineering foundation everything else builds on.

Full specification: [PRODUCT/IMPLEMENTATION_HANDOFF.md](PRODUCT/IMPLEMENTATION_HANDOFF.md).

---

## Stack

TypeScript everywhere. Next.js 15 (frontend) · NestJS on Fastify (API) · PostgreSQL 16 + Prisma · Redis + BullMQ (from Phase 12) · pnpm workspaces monorepo.

See [PRODUCT/IMPLEMENTATION_HANDOFF.md §4](PRODUCT/IMPLEMENTATION_HANDOFF.md#4-technology-stack) for the full stack with rationale.

## Repository layout

```
apps/
  api/       NestJS backend — REST API, webhooks (from Phase 9)
  web/       Next.js frontend — public ordering site, dashboard, admin
  worker/    Background job processor (BullMQ consumers, from Phase 12)
packages/
  contracts/ Shared Zod schemas + inferred types (API request/response shapes)
  money/     BigInt minor-unit money arithmetic — the only place money math happens
  config/    Shared ESLint/TypeScript/Prettier configuration
prisma/      Database schema and migrations (single schema, shared by api + worker)
docs/        Phase reports, runbooks (added as later phases produce them)
```

See [PRODUCT/docs/12-repository-structure.md](PRODUCT/docs/12-repository-structure.md) for conventions.

## Prerequisites

- Node.js 22+
- pnpm 9+ (`npm install -g pnpm`)
- Docker (for local Postgres, Redis, MinIO via `docker-compose.yml`)

## Getting started

```bash
git clone <repo-url>
cd PRODUCT
pnpm install

cp .env.example .env
# Edit .env if you need non-default values. The defaults match
# docker-compose.yml, so a fresh clone works with zero edits.

docker compose up -d
# Starts Postgres (5432), Redis (6379), MinIO (9000/9001).
# Wait ~10s for health checks to pass, or run: docker compose ps

pnpm db:generate   # Generates the Prisma client
pnpm db:migrate    # Creates and applies migrations (empty in Phase 1)

pnpm dev
# Starts api (http://localhost:4000), web (http://localhost:3000),
# and worker in parallel, with file watching.
```

Verify the stack is up:

```bash
curl http://localhost:4000/health   # {"status":"ok"}
curl http://localhost:4000/ready    # {"status":"ready","checks":{"database":{"status":"ok",...}}}
open http://localhost:3000          # "Direct-Order" placeholder page
```

## Common commands

Run from the repository root unless noted.

| Command                  | What it does                                                         |
| ------------------------ | -------------------------------------------------------------------- |
| `pnpm dev`               | Start api + web + worker in parallel, watching for changes           |
| `pnpm build`             | Build every app and package for production                           |
| `pnpm test`              | Run every workspace's test suite (Vitest)                            |
| `pnpm test:e2e`          | Run Playwright end-to-end tests against apps/web                     |
| `pnpm typecheck`         | Type-check every workspace (`tsc --noEmit`)                          |
| `pnpm lint`              | Lint the whole repo (fails on any warning)                           |
| `pnpm lint:fix`          | Lint and auto-fix what's fixable                                     |
| `pnpm format`            | Format the whole repo with Prettier                                  |
| `pnpm format:check`      | Check formatting without writing (used in CI)                        |
| `pnpm db:generate`       | Regenerate the Prisma client after a schema change                   |
| `pnpm db:migrate`        | Create + apply a new migration (local development)                   |
| `pnpm db:migrate:deploy` | Apply existing migrations without creating a new one (CI/production) |
| `pnpm db:seed`           | Run `prisma/seed.ts`                                                 |

Scope a command to one workspace with `--filter`, e.g.:

```bash
pnpm --filter=@direct-order/api run test
pnpm --filter=@direct-order/money run test
```

## Environment variables

See [.env.example](.env.example) for the complete list, grouped by concern, each annotated with the phase that introduces the code reading it. Only the variables under `[PHASE 1]` are read by anything that exists today; the rest are documented ahead of time so the full production configuration surface is visible from day one.

**Never commit `.env` or any file containing real secrets.** `.env.example` contains variable names and formats only.

In production (`APP_ENV=production`), the API refuses to start if `DATABASE_URL`, `API_BASE_URL`, or `WEB_BASE_URL` are missing — it names the exact variable rather than failing later with an obscure error.

## Testing

- **Unit / integration:** Vitest, per workspace (`apps/api/test`, `packages/money/test`, ...). API integration tests boot a real NestJS + Fastify application over real HTTP (via supertest); `PrismaService` is overridden with a controllable stub rather than requiring a live database in every environment that runs the suite — see the note at the top of `apps/api/test/health.e2e.test.ts`.
- **End-to-end:** Playwright, in `apps/web/e2e`. Builds and starts the real Next.js app, then drives it with a real browser.
- **Full-stack / live database:** CI runs a dedicated job (`live-database-smoke-test`) that starts a real PostgreSQL service and the actual compiled API against it, then polls `/health` and `/ready` — this is the closest equivalent to `docker compose up -d && pnpm db:migrate && pnpm dev` that runs automatically on every change. See `.github/workflows/ci.yml`.

## Money

Every monetary value in this codebase is an integer number of minor units (paise) represented as a `bigint`. There is no floating-point representation of money anywhere. `packages/money` is the only place money arithmetic happens — see its source for `toMinor`, `formatINR`, `percentageOf`, and `sum`. A repo-wide ESLint rule bans `Math.round`, `.toFixed`, and `parseFloat` outside legitimate, individually-justified exceptions (grep for `eslint-disable.*no-restricted-syntax` to review every one).

## Non-negotiable invariants

These hold everywhere in the codebase, from Phase 1 onward. See [PRODUCT/IMPLEMENTATION_HANDOFF.md](PRODUCT/IMPLEMENTATION_HANDOFF.md#non-negotiable-invariants) for the full list and rationale — in short: money is server-computed and integer-only; payment success is only ever established by provider-verified confirmation; every retryable financial operation is idempotent at the database level; authorization is derived from the authenticated principal, never a client-supplied ID; audit records are append-only.

## Contributing

Follow [PRODUCT/docs/16-execution-protocol.md](PRODUCT/docs/16-execution-protocol.md): understand the existing implementation before changing it, implement the smallest change that satisfies the requirement, never weaken a test or guard to make something pass, and report accurately — "tests pass" means you ran them.
