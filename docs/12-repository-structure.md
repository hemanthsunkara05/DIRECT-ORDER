# 19. Repository Structure and Conventions

## 19.1 Layout

pnpm workspaces monorepo. One repository, three deployables (web, api, worker), shared contracts.

```
direct-order/
├── apps/
│   ├── web/                        # Next.js 15
│   │   ├── src/app/
│   │   │   ├── (public)/r/[slug]/  # SSR restaurant ordering page
│   │   │   ├── (public)/checkout/
│   │   │   ├── (public)/order/[orderNumber]/
│   │   │   ├── (dashboard)/dashboard/
│   │   │   ├── (admin)/admin/
│   │   │   └── (auth)/
│   │   ├── src/components/{ui,public,dashboard,admin}/
│   │   ├── src/lib/{api-client,auth,money,format}/
│   │   ├── src/hooks/
│   │   └── e2e/                    # Playwright
│   │
│   ├── api/                        # NestJS
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── platform/           # config, logging, errors, guards, health
│   │   │   └── modules/            # see below
│   │   └── test/
│   │
│   └── worker/                     # BullMQ consumers, imports api modules
│       └── src/{processors,schedulers}/
│
├── packages/
│   ├── contracts/                  # Zod schemas + inferred types, shared
│   ├── money/                      # minor-unit arithmetic + formatting
│   └── config/                     # shared eslint, tsconfig, prettier
│
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
│
├── docs/                           # this handoff + runbooks + ADRs
├── infrastructure/                 # docker-compose, Dockerfiles, IaC
├── .github/workflows/
└── package.json
```

### Module internals (uniform across all modules)

```
modules/ordering/
├── ordering.module.ts
├── controllers/          # HTTP only: parse, delegate, serialise. No business logic
├── services/             # business logic, transactions
│   ├── checkout.service.ts
│   └── order-state.service.ts
├── repositories/         # data access; tenant scoping enforced here
├── dto/                  # Zod schemas + inferred types
├── events/               # emitted event definitions
└── __tests__/
```

**Layering:** Controller → Service → Repository → Prisma. A controller never touches Prisma. A repository never contains business rules. Services own transactions.

## 19.2 Naming

| Thing | Convention | Example |
|---|---|---|
| Files | kebab-case | `order-state.service.ts` |
| Classes | PascalCase | `OrderStateService` |
| Functions, variables | camelCase | `calculateOrderTotal` |
| Constants | SCREAMING_SNAKE | `MAX_ITEM_QUANTITY` |
| Database | snake_case | `order_items` |
| Money fields | `*_minor` / `*Minor` | `payableTotalMinor` |
| Booleans | `is` / `has` / `can` | `isAvailable` |
| Enums | SCREAMING_SNAKE values | `PENDING_PAYMENT` |
| React components | PascalCase | `MenuItemCard.tsx` |
| Event types | SCREAMING_SNAKE past tense | `ORDER_DELIVERED` |

## 19.3 Money handling

```ts
// packages/money — the only place money arithmetic lives
export type Minor = bigint;

export function toMinor(rupees: string): Minor;   // "250.50" -> 25050n
export function formatINR(m: Minor): string;      // 25050n -> "₹250.50"
export function percentageOf(m: Minor, pct: number): Minor;  // half-up, once
export function sum(...values: Minor[]): Minor;
```

Rules: `bigint` end to end; JSON transports money as a **number of minor units**, never a formatted string or decimal; the frontend formats for display only and never computes an authoritative total; `Math.round`, `toFixed`, and float multiplication on money are banned by lint rule.

## 19.4 Error handling

```ts
export class AppError extends Error {
  constructor(
    readonly code: string,         // stable, client-branchable
    readonly httpStatus: number,
    message: string,               // safe for display
    readonly details?: unknown,    // structured
  ) { super(message); }
}

export class ConflictError extends AppError { /* 409 */ }
export class ForbiddenError extends AppError { /* 403 */ }
export class NotFoundError extends AppError { /* 404 */ }
export class ValidationError extends AppError { /* 422 */ }
export class ProviderError extends AppError { /* 502/503 */ }
```

A global exception filter maps these to the standard envelope, attaches the request ID, logs with correlation, and returns an opaque message for unexpected errors in production. Never `throw new Error('something went wrong')` on a path a user can reach.

## 19.5 Service conventions

- One public method per use case, named for the business action (`acceptOrder`, not `updateOrderStatus`).
- Transactions are explicit and owned by services; repositories accept an optional transaction handle.
- Side effects are emitted as events **after commit** via the outbox — never fired inside a transaction.
- Services never read `req`/`res`. The authenticated principal is passed as a typed argument.
- Every money-touching method re-reads state; it never trusts a passed-in amount.

## 19.6 API client (frontend)

All HTTP goes through `src/lib/api-client`. Components never call `fetch` directly. The client handles credentials, correlation ID injection, timeout (10s default), typed error mapping to `code`, and a single 401 refresh-and-retry. Server state uses TanStack Query; the cart is client state; forms use React Hook Form.

## 19.7 Logging

```ts
logger.info({ correlationId, orderId, restaurantId, event: 'order.accepted', durationMs }, 'Order accepted');
```

Structured objects, never string interpolation of data. Redaction is configured at the logger, not at call sites. Levels: `error` (needs attention), `warn` (unexpected but handled), `info` (business events), `debug` (development only).

## 19.8 Tooling

ESLint with type-aware rules plus custom rules enforcing: no float arithmetic on `*Minor` values, no raw SQL concatenation, no `dangerouslySetInnerHTML`, no cross-module imports that violate the dependency direction. Prettier, 100 columns. Strict TypeScript with `noUncheckedIndexedAccess`. Husky pre-commit: format, lint changed files, typecheck.

## 19.9 Git

Trunk-based off `main`, short-lived branches (`feat/…`, `fix/…`, `chore/…`). Conventional Commits. Every PR states what changed, what was tested, and any security or financial implications. `main` is protected: CI must pass, no direct pushes.
