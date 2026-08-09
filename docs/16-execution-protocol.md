# 24–25. Execution Protocol and Definition of Done

# 24. Execution protocol for the implementing agent

You are implementing a production system that will handle real money for real restaurants. Read this before writing any code.

---

## 24.1 Before you start

1. Read [IMPLEMENTATION_HANDOFF.md](../IMPLEMENTATION_HANDOFF.md) completely.
2. Read [15-ambiguities-and-risks.md](15-ambiguities-and-risks.md) — so you do not invent business rules that were deliberately left open.
3. Read [13-implementation-phases.md](13-implementation-phases.md) — your build order.
4. Inspect the repository as it actually is. `PRODUCT/` contains this handoff and, at time of writing, nothing else.

## 24.2 The loop

For each phase:

```
READ the phase spec and its acceptance criteria
  → INSPECT existing code for what already exists
  → PLAN briefly (what changes, what breaks, what to test)
  → IMPLEMENT the whole phase
  → TEST (write tests, run them, fix root causes)
  → VALIDATE (typecheck, lint, build, full regression)
  → REVIEW the diff
  → REPORT
  → next phase
```

**Work autonomously within a phase.** Do not ask "should I continue?" between files, or after each test run, or before the obvious next step. Inspect, implement, test, fix, continue until the phase is complete.

## 24.3 When to stop and ask

Stop only for:

1. **A genuine product decision** you cannot infer — check [15-ambiguities-and-risks.md](15-ambiguities-and-risks.md) first; if it is listed with a recommended default, **implement the default and note it**, do not ask.
2. **Missing credentials or external configuration** (payment keys, provider access, domain).
3. **A destructive or irreversible action** — dropping data, force-pushing, deleting production resources.
4. **A conflict between this handoff and reality** — the spec says something that cannot work. Report it clearly rather than silently diverging.

Everything else: decide and proceed. If you are choosing between two reasonable implementations with no product implication, pick one, note it in your report, and keep moving.

## 24.4 Rules that do not bend

1. **Never trust client-supplied financial values.** Prices, discounts, totals, and points come from the database.
2. **Never trust client-supplied identity or authority.** `restaurantId`, `userId`, `role`, `isAdmin` in a request body are stripped, never honoured.
3. **Never mark a payment successful without provider verification.**
4. **Never use floating-point arithmetic for money.** Anywhere. Including the frontend.
5. **Never duplicate business logic.** One pricing engine, one availability service, one state transition service per aggregate, one loyalty ledger, one promotion engine, one notification pipeline. If you need pricing in a new place, call the existing engine.
6. **Never bypass a state machine.** No controller, worker, or admin path writes a status column directly.
7. **Never weaken a test, guard, or validation to make something pass.** A failing security or financial test is a real defect.
8. **Never commit a secret.** Not in code, config, fixtures, logs, or documentation.
9. **Never delete financial or audit records.**
10. **Never claim something works that you have not verified.** "Tests pass" means you ran them. "Production ready" means it was verified, not that it compiles.

## 24.5 Working with existing code

Before adding anything, search for it. This codebase is designed around single sources of truth, and the most likely failure mode for an implementing agent is creating a second pricing path, a second availability check, or a second notification sender because the first one was not found.

When a phase says "integrate with the existing X", that is an instruction to **call** X, not to reimplement it.

## 24.6 Scope discipline

Implement the phase you are on. Do not:

- build features from later phases because they seem related
- refactor unrelated code you happen to read
- rename things for consistency while doing something else
- upgrade dependencies opportunistically
- add abstractions for requirements that do not exist yet

A diff containing only the changes relevant to the stated task is far easier to review and far less likely to break something distant.

## 24.7 Reporting format

At the end of each phase:

```
PHASE N — <name>

IMPLEMENTED
  <what now works, in product terms>

FILES
  <significant files added or changed>

DATABASE
  <migrations, new constraints and indexes>

APIS
  <endpoints added or changed>

SECURITY
  <authorization added, isolation tests, validation>

TESTS
  <what was added; what the important tests prove>

VALIDATION
  <exact commands run and their results>

DECISIONS
  <choices made, and defaults applied from the ambiguity register>

KNOWN ISSUES
  <anything incomplete, deferred, or uncertain>

BLOCKED ON
  <external dependencies, if any>

NEXT
  <the next phase>
```

Be accurate. If a test fails, say so and show the output. If a step was skipped, say so. If something is mocked rather than real — delivery in particular — say that plainly. A report that overstates completion is worse than no report, because it removes the human's ability to catch the gap.

---

# 25. Definition of Done

The application is complete when all of the following hold. Each is verifiable; none is a judgement call.

## Functional

- [ ] Restaurant can register, onboard, and go live without engineering assistance
- [ ] Restaurant can manage menu, categories, availability, hours, branding, settings, and staff
- [ ] Customer can open a restaurant link, browse, cart, checkout, and pay without an account
- [ ] Payment is verified server-side and the order reaches the restaurant in real time
- [ ] Restaurant can accept, reject, prepare, and mark ready, with the customer seeing each change
- [ ] Delivery dispatches automatically on ready and tracks to completion (or is honestly reported as mock-mode)
- [ ] Rejection triggers an automatic full refund the customer can see
- [ ] Notifications reach customers and restaurants on every significant state change
- [ ] Admin can operate the platform: approve, suspend, investigate, refund, reconcile, moderate
- [ ] Support cases can be raised, assigned, discussed, and resolved
- [ ] Promotions, loyalty, referrals, and reviews function per their business rules
- [ ] Analytics dashboards reconcile with transactional data

## Financial integrity

- [ ] Every monetary value is integer minor units; no float appears in any money path
- [ ] Every payable amount is server-computed; client values cannot influence a charge
- [ ] `refunded <= captured` holds for every payment, enforced in the database
- [ ] `payable_total >= 0` and the total identity holds for every order, enforced by CHECK
- [ ] Every data-integrity assertion in §18.6 returns zero rows
- [ ] Duplicate webhooks, retries, and concurrent requests produce exactly one financial effect
- [ ] Loyalty ledger sums reconcile with cached balances for every customer

## Security

- [ ] Every endpoint enforces authentication, permission, and tenant scope
- [ ] Cross-tenant access returns 404 and is logged, for read and write, on every tenant-scoped endpoint
- [ ] No privilege-escalation path exists from customer or restaurant roles to admin
- [ ] All webhooks verify signatures on raw bodies
- [ ] No secrets in source control, logs, URLs, or the client bundle
- [ ] Security audit complete with zero unresolved critical or high findings
- [ ] Every fixed vulnerability has a regression test

## Reliability

- [ ] Backups configured **and a restore drill has passed**
- [ ] Disaster recovery documented with RPO/RTO stated honestly
- [ ] Graceful shutdown loses no in-flight work
- [ ] Provider outages degrade gracefully without corrupting state
- [ ] Every alert has a runbook
- [ ] Dead-letter queues are visible and monitored

## Quality

- [ ] Full regression suite passes
- [ ] Both applications build for production
- [ ] Typecheck, lint, and format pass with no suppressions added to force them
- [ ] Customer flows work on mobile at 375 px
- [ ] Core customer flow is completable by keyboard alone
- [ ] No console errors in normal operation

## Operational

- [ ] Production deployed with health checks green and smoke tests passing
- [ ] Monitoring and alerting verified as firing
- [ ] Runbooks written for every alert
- [ ] Environment variables documented
- [ ] README gets a new developer running locally

## Honesty gate

The system is **not** done — regardless of code completeness — while any of these is true:

- A critical or high security finding is unresolved
- Payment settlement structure (AMB-3) is undecided and real payments are enabled
- Tax treatment (AMB-13) is unconfirmed and real money is being taken
- Backups have never been restore-tested
- Delivery is in mock mode but reported as production-ready
- Any test is skipped or weakened to make CI pass

**Report status as one of:** `READY` · `READY WITH ACCEPTED RISKS` (risks documented and accepted by the product owner) · `NOT READY` (with blockers named) · `BLOCKED ON EXTERNAL DEPENDENCY` (named).

Never report "100% production ready". That claim cannot be substantiated, and the credibility of every other statement in the report depends on not making it.
