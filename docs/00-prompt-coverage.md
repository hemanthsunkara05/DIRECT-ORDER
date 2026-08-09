# Prompt Coverage Map

Verification aid: where each of the 30 requirement prompts landed in this handoff. Use this to confirm nothing was lost in consolidation.

| Prompt | Subject | Where it lives |
|---|---|---|
| 1 | Product requirements, scope, order lifecycle | Handoff §1–2; [03-state-machines](03-state-machines.md); [06-business-rules](06-business-rules.md) |
| 2 | Technical architecture, stack selection | Handoff §3–4; [01-domain-model](01-domain-model.md); [02-database-schema](02-database-schema.md); [04-api-specification](04-api-specification.md) |
| 3 | Project foundation, engineering standards | [12-repository-structure](12-repository-structure.md); Phase 1 |
| 4 | Core database and domain backend | [01-domain-model](01-domain-model.md); [02-database-schema](02-database-schema.md); Phases 2, 5, 6 |
| 5 | Authentication and restaurant onboarding | [09-security](09-security.md) §15.2; Phases 3, 5 |
| 6 | Restaurant dashboard and menu management | [04-api-specification](04-api-specification.md) §8.5; Phases 5, 6, 10 |
| 7 | Customer-facing ordering website | [04-api-specification](04-api-specification.md) §8.3; Phase 7 |
| 8 | Checkout, pricing, orders, payments | [02-database-schema](02-database-schema.md) §6.2–6.3; [03-state-machines](03-state-machines.md) §7.1–7.3; [04-api-specification](04-api-specification.md) §8.3, §8.6; Phases 8, 9 |
| 9 | Restaurant order management, notifications | [03-state-machines](03-state-machines.md) §7.1; [08-search-and-notifications](08-search-and-notifications.md) §14; Phases 10, 12 |
| 10 | Delivery integration and fulfilment | [03-state-machines](03-state-machines.md) §7.4; [07-events-and-jobs](07-events-and-jobs.md); Phase 11; RISK-3 |
| 11 | Admin panel, platform operations | [05-authorization-matrix](05-authorization-matrix.md); [04-api-specification](04-api-specification.md) §8.7; Phase 13 |
| 12 | Security, reliability, hardening audit | [09-security](09-security.md); [11-testing-strategy](11-testing-strategy.md); Phase 18 |
| 13 | Production infrastructure, deployment, launch | [10-infrastructure-deployment](10-infrastructure-deployment.md); Phase 20 |
| 14 | End-to-end QA, UAT, bug bash | [11-testing-strategy](11-testing-strategy.md) §18.4; [14-acceptance-criteria](14-acceptance-criteria.md) |
| 15 | Production launch and post-launch operations | [10-infrastructure-deployment](10-infrastructure-deployment.md) §17.3–17.8; Phase 20 |
| 16 | Continuous monitoring, incident response | [10-infrastructure-deployment](10-infrastructure-deployment.md) §17.6–17.7; [07-events-and-jobs](07-events-and-jobs.md) queue thresholds |
| 17 | Continuous improvement, technical debt | [12-repository-structure](12-repository-structure.md); [15-ambiguities-and-risks](15-ambiguities-and-risks.md); Phase 19 |
| 18 | Controlled change and maintenance protocol | [16-execution-protocol](16-execution-protocol.md) §24 |
| 19 | Product analytics, business metrics | [01-domain-model](01-domain-model.md) §5.14; [07-events-and-jobs](07-events-and-jobs.md); Phase 17 |
| 20 | Customer support and issue resolution | [01-domain-model](01-domain-model.md) §5.12; [03-state-machines](03-state-machines.md) §7.9; Phase 17 |
| 21 | Promotions, discounts, coupons, pricing rules | [01-domain-model](01-domain-model.md) §5.8; [02-database-schema](02-database-schema.md) §6.3; [03-state-machines](03-state-machines.md) §7.7; Phase 14 |
| 22 | Ratings, reviews, restaurant reputation | [01-domain-model](01-domain-model.md) §5.11; [08-search-and-notifications](08-search-and-notifications.md) §13.5; Phase 15 |
| 23 | Customer loyalty, rewards, retention | [01-domain-model](01-domain-model.md) §5.9; [02-database-schema](02-database-schema.md) §6.3; Phase 16 |
| 24 | Referral and invite system | [01-domain-model](01-domain-model.md) §5.10; [03-state-machines](03-state-machines.md) §7.8; Phase 16 |
| 25 | Restaurant operations, staff, availability | [01-domain-model](01-domain-model.md) §5.2; [03-state-machines](03-state-machines.md) §7.5–7.6; Phases 5, 7 |
| 26 | Search, discovery, ranking | [08-search-and-notifications](08-search-and-notifications.md) §13; **AMB-1** |
| 27 | Notification centre, preferences, communication | [08-search-and-notifications](08-search-and-notifications.md) §14; Phase 12 |
| 28 | Security, privacy, compliance hardening | [09-security](09-security.md); AMB-17; Phase 18 |
| 29 | Disaster recovery, backups, observability | [10-infrastructure-deployment](10-infrastructure-deployment.md) §16.4–16.6, §17.6; Phase 19 |
| 30 | Final optimisation, performance, launch readiness | [11-testing-strategy](11-testing-strategy.md); [14-acceptance-criteria](14-acceptance-criteria.md); Phases 19, 20 |

## Deliberate consolidations

Several prompts specified separate documents that would have duplicated each other. These were merged, with all substantive content preserved:

- Prompts 12, 28 (two security audits) → one security architecture plus a Phase 18 audit
- Prompts 13, 15, 16, 29 (infrastructure, launch, monitoring, DR) → one infrastructure and deployment document
- Prompts 14, 30 (QA, final optimisation) → testing strategy plus acceptance criteria
- Prompt 17's technical-debt register → folded into the risk register and Phase 19

## Requirements deliberately not implemented as specified

| Requirement | Treatment | Reason |
|---|---|---|
| Cross-restaurant discovery (P26) | Built, feature-flagged off | Direct conflict with P1's Layer 2 prohibition — see AMB-1 |
| Customer accounts (P23, 24, 27 imply; P1, P7 forbid forcing) | Guest-first, optional account | Reconciles both — see AMB-2 |
| Admin order status override (P11) | **Not built** | Would let an admin move DELIVERED to PREPARING and destroy reconciliation. Corrections are compensating operations instead |
| Elasticsearch / external search | Postgres FTS | P26 explicitly says do not introduce one unless necessary; migration triggers documented |
| Microservices | Modular monolith | P2 and P6 both prefer the simplest architecture that satisfies requirements |
