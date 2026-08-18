# Phase 22 — Admin-Assisted Restaurant Management (Concierge Onboarding)

Paste the section below into Claude Code from the repo root.

---

## Context

Verified against the current tree: there is no admin path to create a restaurant or edit an
existing restaurant's profile/menu. `POST /restaurants` requires only a logged-in user and is the
owner's own signup flow (`/signup` → `/onboarding`); admin's role today is strictly
approve/reject/suspend on what an owner already created themselves. Prospects
(`/admin/prospects`) are pre-seeded "unclaimed" listings for outreach, but the only way to add a
new prospect is editing `prisma/seed.ts` and rerunning it — not usable during a live outreach call.
Restaurant-side menu/profile/hours/branding management (`/restaurant/menu`, `/restaurant/profile`,
etc.) is fully built, but only reachable by logging in as that restaurant.

Business context: the active goal is signing 10–20 boycotting restaurants in Bengaluru onto live
ordering links, fast, during a live boycott window. Most of these owners are busy, mid-crisis, and
not going to reliably complete a multi-step self-serve form under time pressure. The realistic
acquisition motion is concierge: someone on the platform side sits with the owner (in person, on a
call, or working from WhatsApp-forwarded menu photos) and sets the listing up directly. That is the
actual product requirement here — this is not "give admin more power" for its own sake, it is
removing the one bottleneck standing directly in front of the stated business goal.

Two adjacent gaps exist and are explicitly **not** part of this phase — do not build them:

- **Promotions admin UI.** `/admin/promotions`-equivalent backend already exists and works
  (`apps/api/src/modules/promotions/`, gated on `promotions:platform`) but has no frontend page.
  Usable via direct API call for the rare case it's needed pre-launch. Log it in `TODOS.md` as
  deferred, P3, with a one-line note that the API already exists and only the page is missing —
  do not re-investigate what already exists.
- **Admin user creation.** No endpoint, no UI, anywhere. `admin:role_manage` is declared in the
  permission table but nothing checks it. Only admin today is the one hardcoded in
  `prisma/seed.ts`. This matters once there's a team; there isn't one yet. Log it in `TODOS.md` as
  deferred, P3, noting the seed-file/direct-DB workaround as the interim path.

---

## Work item — admin can create and edit a restaurant on an owner's behalf

### Required behaviour

1. **Admin-created restaurant.** An admin can create a restaurant record directly —
   name, address, branding basics, an owning user (existing account by email/phone, or a
   placeholder pending claim, matching how Prospects already models an unclaimed listing).
   Reuse the Prospects/claim data model where it fits rather than inventing a second "unclaimed
   restaurant" concept — check `apps/api/src/modules/restaurants` and whatever backs
   `/admin/prospects` before designing new tables.
2. **Admin edit: profile, address, branding, hours.** An admin can view and edit any restaurant's
   profile, address, branding, and operating hours — the same fields the owner's own
   `/restaurant/profile` and `/restaurant/hours` pages manage, exposed on an admin-side surface.
   Do not fork the validation logic — reuse the existing service-layer methods
   (`RestaurantProfileService` and equivalents) with an admin-authorized call path, the same
   pattern already used elsewhere for admin actions on owner-owned resources (e.g. `restaurant:approve`,
   `restaurant:suspend`). An admin edit is not silent: attribute it (which admin, when) and make it
   visible in whatever the owner already sees, if anything shows edit history today — check
   `apps/api/src/platform/audit/` and follow its existing convention rather than adding a parallel
   log.
3. **Admin edit: menu.** An admin can view and edit a restaurant's menu — categories, items,
   pricing, availability — through an admin-side surface backed by the existing menu service/repo
   layer (`apps/api/src/modules/menu/`), not a rewrite. This is the highest-value single piece of
   this phase: it is what makes "load a menu from photos an owner texted you" possible without
   asking the owner to type it in themselves.
4. **Restaurant identification / matching.** When an admin creates a restaurant that may already
   correspond to an existing Prospect listing, or when a claim later arrives for a restaurant an
   admin already fully built, define and document how these reconcile — do not leave two
   divergent code paths that can produce duplicate or orphaned restaurant records. If the existing
   claim flow already has a match/dedup convention, follow it.
5. **Permissions.** Gate all of this behind a real permission (do not reuse `restaurant:approve`,
   which is a distinct action per the reasoning already established in Phase 21). Name and scope
   it consistently with the existing catalogue in
   `apps/api/src/platform/authorization/permission.catalogue.ts` (current tail: BR-164 in
   `docs/06-business-rules.md`; continue numbering from there). Decide whether admin edit-access
   should be broader than `restaurant:approve`'s role set or the same — document the reasoning
   either way, don't default silently.
6. **Owner-side visibility.** If an admin edits a live or pending restaurant's profile/menu, the
   owner should be able to see that a change was made on their behalf (at minimum, updated-at
   changes; ideally attribution, matching whatever the audit convention from item 2 gives you for
   free). This is a trust surface, same reasoning as the settlement ledger from Phase 21b — don't
   let a restaurant discover a change to their live menu with no explanation.

### Explicitly out of scope for this phase

- Promotions admin UI (see above — log to `TODOS.md`, do not build).
- Admin user creation/`admin:role_manage` (see above — log to `TODOS.md`, do not build).
- Bulk import / CSV menu upload. If it seems clearly useful once you're in the menu-edit work,
  note it in `TODOS.md` rather than building it — this phase is "make one restaurant editable by
  an admin," not "build a bulk tooling pipeline."
- Any change to the restaurant approval state machine itself (Phase 21's territory) — this phase
  is scoped to editing restaurant content/records, not the approve/reject/suspend flow.

---

## How to work

Follow `docs/16-execution-protocol.md` §24.2, the standing loop for this repo:

```
READ the relevant specs → INSPECT existing code → PLAN → IMPLEMENT → TEST → VALIDATE → REVIEW → REPORT
```

Before writing code:

1. Read `docs/15-ambiguities-and-risks.md`, `docs/05-authorization-matrix.md`,
   `docs/06-business-rules.md`, and whatever documents the current Prospects/claim flow.
2. Inspect the existing restaurant, menu, and prospects/claim modules end to end — controller,
   service, repository, DTOs — before writing anything new. This phase should mostly be *exposing*
   existing owner-side capability through an admin-authorized path, not building new business
   logic. If you find yourself duplicating validation or pricing logic that already exists on the
   owner side, stop and reuse it instead.
3. Run `/plan-eng-review` and `/plan-design-review` on your plan before implementing, same as
   Phase 21 — this touches the same restaurant/menu data the customer-facing storefront reads
   live, so a bad edit path here is customer-visible immediately, not just an internal admin bug.
4. Extend the existing numbering conventions: business rules continue from BR-164 in
   `docs/06-business-rules.md`; add schema changes to `docs/02-database-schema.md`, endpoints to
   `docs/04-api-specification.md`, permissions to `docs/05-authorization-matrix.md`, acceptance
   criteria to `docs/14-acceptance-criteria.md`.

Work autonomously within the phase. Per §24.3, stop only for a genuine product decision you
cannot infer, missing credentials/config, or a destructive/irreversible action.

## Definition of done

- Prisma migration (if any new fields/tables) created and applied cleanly; schema documented.
- Tests covering: admin-created restaurant reaches the same states an owner-created one can,
  admin edits to profile/address/branding/hours/menu persist correctly and are attributed,
  authorization on every new endpoint (including negative cases — a non-admin, or an admin without
  the new permission, must not be able to call these), and the Prospects/claim reconciliation
  behaviour from item 4.
- Typecheck, lint, build, and the full existing test suite pass with no regressions.
- A manual browser walk: admin creates a restaurant from scratch, edits its menu, restaurant
  appears correctly on the public storefront (`/r/[slug]`) with the admin-entered menu — same
  bar as Phase 21's end-to-end verification.
- `TODOS.md` updated with the promotions-UI and admin-user-creation deferrals as specified above.
- Report what changed, what you decided where the spec was silent (especially the Prospects
  reconciliation point), and what you deliberately left out of scope.
