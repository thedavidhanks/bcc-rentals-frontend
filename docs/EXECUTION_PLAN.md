# BCC Rentals — Execution Plan (Plan B)

Living document tracking execution of [ARCHITECTURE_PLAN_B.md](./ARCHITECTURE_PLAN_B.md). Update task statuses as work progresses and commit each change.

**Last updated:** 2026-07-13 · **Progress:** P1.1 ✅ · P1.2 ✅ · P1.3 ✅ · P1.4 ✅ · P1.5 ✅ · P1.6 ✅ · P1.7 ✅ — **Block 1 complete**

---

## Architecture summary

Target production stack — all owned in this Next.js repo, no PHP, no Lightsail, no separate booking system. Hard ceiling: **$30/mo** platform spend (excl. per-transaction fees).

| # | Component | Role | Hosting |
| - | --- | --- | --- |
| 1 | **Storefront + `/admin`** (Next.js App Router, pinned to 15) | Public UI, checkout, webhooks, staff admin | AWS Amplify Hosting |
| 2 | **Neon Postgres** | System of record: `items`, `reservations` | Neon serverless (free tier) |
| 3 | **Upstash Redis** | Pending orders (1h TTL), fulfill locks, webhook dedup | Upstash (free tier) |
| 4 | **PayPal** | PayPal + Venmo Smart Buttons (nonprofit rate 1.99% + $0.49) | PayPal-hosted |
| 5 | **Resend** | Customer + staff notification emails | Resend-hosted |
| 6 | **DNS** | `rentals.bachmancc.org` → Amplify (GoDaddy CNAME) | GoDaddy |
| 7 | **Observability** | Amplify logs + pino + Neon dashboard | AWS + Neon |

**Estimated monthly platform spend:** ~$0–3/mo.

### Data & trust flow

```mermaid
flowchart TD
    User([Customer / Staff])
    DNS[rentals.bachmancc.org<br/>GoDaddy CNAME]

    subgraph Amplify["AWS Amplify Hosting"]
        App[Next.js 15<br/>Storefront + /admin]
    end

    subgraph Ephemeral["Ephemeral state"]
        Redis[(Upstash Redis<br/>pending orders · fulfill locks · webhook dedup)]
    end

    subgraph Durable["System of record"]
        Neon[(Neon Postgres<br/>items · reservations · blocks)]
    end

    subgraph External["External services"]
        PayPal[PayPal / Venmo]
        Resend[Resend email]
    end

    User -->|HTTPS| DNS
    DNS --> App
    App -.server-only.-> Redis
    App -.server-only.-> Neon
    App -.server-only.-> PayPal
    App -.server-only.-> Resend
    PayPal -.signed webhook.-> App

    classDef ext fill:#f5f5f5,stroke:#888,color:#222
    classDef store fill:#eef6ff,stroke:#3b7dd8,color:#0b3d91
    class PayPal,Resend ext
    class Redis,Neon store
```

- Confirm-then-book invariant preserved: reservations only inserted after payment succeeds.
- Conflict guard = Redis fulfill lock + re-check inside a Postgres transaction.
- Every server module that touches secrets imports `"server-only"`; env Zod-validated at boot.
- Admin: HTTP Basic Auth (V1), Clerk free tier (V2).

### Two inventory models (single schema)

| Type | Example | `total_stock` | Availability check |
| --- | --- | --- | --- |
| Unique resource | Party room, tent | `1` | Any overlapping non-cancelled reservation = unavailable |
| Fungible inventory | Chairs, plates | `N` | `total_stock - SUM(qty reserved during overlap) >= requested_qty` |

### Module layout (target)

```
lib/scheduler/
  client.ts   # getAvailability, createReservation, cancelReservation, getReservation
  db.ts       # Neon client / pool
  policy.ts   # buffer / min length / hours / lead / horizon
  types.ts    # Zod schemas
  errors.ts   # SchedulerError, SchedulerConflictError
app/api/calendar/[itemSlug]/route.ts  # ICS feed
app/admin/…                            # follow-up sprint
```

Detailed schema, SQL queries, LibreBooking→Scheduler method map, and rationale live in [ARCHITECTURE_PLAN_B.md](./ARCHITECTURE_PLAN_B.md).

---

## Priority — do now (Block 1: build scheduler)

Blocks production cutover. Est. ~3 days.

- [x] **P1.1** ✅ Provision Neon Postgres project with two branches: `main` (prod) and `dev` (shared dev/preview). Capture `DATABASE_URL` for each. — Both branches live in `us-east-1` (prod endpoint `ep-rough-shadow`, dev endpoint `ep-cool-field`). Local `.env.local` holds `DATABASE_URL` (prod) + `DATABASE_URL_DEV` (dev); credentials never committed. Follow-up during P1.2/P1.3: standardize pooled (runtime) vs. direct/unpooled (DDL) endpoints across both.
- [x] **P1.2** ✅ Define schema in `lib/scheduler/db/schema.sql` (or Drizzle/Kysely). Tables: `items`, `reservations` + `reservations_item_time_idx`. — Raw SQL + `pg` (no ORM). `items` kept **minimal** (identity + inventory: `slug`, `name`, `type`, `total_stock`, `active`); pricing/policy stay in `lib/products/config.ts` to avoid a lossy dual source of truth. **⚠️ Reversed 2026-07-10** (see the "products in DB" Change log entry): the **database is now the source of truth for the full product** — `items` gained content/policy columns, pricing moved to a new `item_prices` table, `config.ts` was replaced by the async `lib/products/repository.ts`, so an admin can add/edit products with no redeploy and pricing can vary by day/time. Applied to **both** Neon branches — `dev` via `npm run db:apply` (direct/unpooled `DATABASE_URL_DEV`) and `main` via `npm run db:apply:prod` (`DATABASE_URL`), since `main` is not yet exposed/in use and keeping the branches in sync avoids drift. `DATABASE_URL`/`DATABASE_URL_DEV` added to `lib/env.ts` + README. Pooled-vs-direct: dev DDL uses the direct endpoint; `main`'s DDL currently runs over the pooled endpoint (fine for `CREATE TABLE IF NOT EXISTS`) — standardizing a direct prod endpoint remains the P1.1 follow-up; runtime pooled wiring lands in P1.3.
- [x] **P1.3** ✅ Build `lib/scheduler/client.ts` — 4 methods: `getAvailability`, `createReservation`, `cancelReservation`, `getReservation`. Use `@neondatabase/serverless` or `pg`. — Uses `pg` (`Pool` + `withTransaction` in `lib/scheduler/db.ts`). `createReservation` re-checks capacity and inserts atomically under a per-item `pg_advisory_xact_lock` (works for both `unique` and `fungible` via `SUM(quantity)` vs `total_stock`); capacity exhaustion → `SchedulerConflictError` (`lib/scheduler/errors.ts`). `referenceNumber` = `reservations.id` (uuid). Verified end-to-end against Neon with a throwaway integration test (booking/overlap/adjacency/cancel-frees, fungible aggregation/exhaustion, unknown-item + bad-window validation) — deleted after run; real mocked units are P1.6.
- [x] **P1.4** ✅ Build `lib/scheduler/policy.ts` — validates lead time / booking horizon / available hours / slot alignment. — Pure module over the DB-sourced `Product` (`import type`, unit-tested). `validateBooking(product, startISO, endISO, now?)` throws a typed `PolicyError` (`code`: `lead-time` | `horizon` | `available-hours` | `slot-alignment`); hourly checks use `Intl.DateTimeFormat` in `America/New_York` (BCC is Eastern; the legacy LibreBooking client's `America/Chicago` is inconsistent and dropped in N2.7). **Length** stays in `quote()` (already runs in preflight); **buffer** is applied in the scheduler overlap: `bufferMinutes` added to both scheduler input schemas and used to widen the `OVERLAP` window in `getAvailability`/`createReservation`. Wiring `validateBooking` + `product.bufferMinutes` into `preflight`/availability is Block 2 (N2.3).
- [x] **P1.5** ✅ Build `lib/scheduler/types.ts` — Zod schemas matching existing LibreBooking client surface so call sites change minimally. — Done alongside P1.3: `lib/scheduler/types.ts` holds Zod input schemas (`getAvailabilityInputSchema`, `createReservationInputSchema`, with `endISO > startISO` refinement) + output types (`Reservation`, `Availability`). Surface is `itemSlug`-based with embedded customer (no `resourceId`/`userId`), per the Plan B method map — call sites still swap in Block 2 (N2.3/N2.4).
- [x] **P1.6** ✅ Unit tests for `lib/scheduler/*` (mock Postgres client). — Added `lib/scheduler/client.test.ts` (4 methods: capacity math, buffer-window widening, advisory-lock→re-check→INSERT ordering, `SchedulerConflictError`/`SchedulerError`, null-on-bad-UUID, row→camelCase mapping) and `lib/products/repository.test.ts` (item/price → `Product` mapping, `baseCents` priority selection, `hourlyConstraints`, 30s cache). Both mock the `getPool`/`withTransaction` seam in `lib/scheduler/db.ts` via `vi.mock` (no real `pg`/env boot) — the repo's first mocked-dependency tests, since no `lib/librebooking/*.test.ts` ever existed; style follows `policy.test.ts`/`pricing.test.ts`. 25 new tests; full suite 43 pass, typecheck clean. No config change needed (existing `server-only` alias suffices).
- [x] **P1.7** ✅ Seed initial items in production Neon: tent, popcorn machine, party room. — `scripts/db/seed-products.mjs` (idempotent upsert by `slug`, replaces each item's price rows) + `npm run db:seed` / `db:seed:prod`. Seeded to **both** branches; values match the pre-migration config (tent $150/day, popcorn $50/day, party-room $40/hr). (Chairs / tables / additional items per N4.4.)

---

## Next

### Block 2 — Swap call sites + ship ICS feed (~1 day)

- [ ] **N2.1** Downgrade Next.js 16 → 15 (Amplify Hosting supports Next 12–15 only).
- [ ] **N2.2** Audit codebase for Amplify-unsupported features: `revalidatePath`, `revalidateTag`, `unstable_after`, `runtime = "edge"`, streaming responses, middleware on optimized images.
- [ ] **N2.3** Swap imports in `app/api/availability/route.ts`, `lib/orders/preflight.ts`, `lib/orders/fulfill.ts` from `lib/librebooking` → `lib/scheduler`.
- [ ] **N2.4** Drop `findOrCreateUser` in `fulfill.ts`; pass customer email/name directly into `createReservation`.
- [ ] **N2.5** Add ICS feed route at `app/api/calendar/[itemSlug]/route.ts` using the `ics` npm package.
- [ ] **N2.6** Add staff notification email to `reservations@bachmancc.org` in `fulfill.ts` (Resend) if not already present.
- [ ] **N2.7** Delete `lib/librebooking/` and all `LIBREBOOKING_*` / `LB_RESOURCE_ID_*` env vars; remove from `lib/env.ts`, `.env.local.example`, README env table.

### Block 3 — Deploy to Amplify (~half day)

- [ ] **N3.1** Create Amplify app from GitHub repo.
- [ ] **N3.2** Port env vars into Amplify Production + Preview environments (add `DATABASE_URL`, drop LibreBooking vars).
- [ ] **N3.3** Add `rentals.bachmancc.org` custom domain in Amplify; cut GoDaddy CNAME (lower TTL first).
- [ ] **N3.4** Register production webhook URLs in the PayPal dashboard against the Amplify HTTPS URL.

### Block 4 — Product & policy decisions (BCC admin, parallelizable with dev)

- [ ] **N4.1** Confirm final rental pricing per item.
- [ ] **N4.2** Confirm party-room hours and slot length.
- [ ] **N4.3** Confirm min lead time and max advance booking window per item.
- [ ] **N4.4** Define fungible inventory (chairs, tables, plates, etc.) with `total_stock` quantities.
- [ ] **N4.5** Verify Resend sending domain `bachmancc.org` (SPF/DKIM records).
- [ ] **N4.6** Finalize cancellation/refund policy text in the confirmation email.

### Block 5 — Production smoke test

- [ ] **N5.1** Availability respects existing reservations.
- [ ] **N5.2** PayPal (sandbox → live) → webhook → reservation written → email arrives → success page renders.
- [ ] **N5.3** Two concurrent browsers on the same slot → second sees clean error + auto-refund.
- [ ] **N5.4** Fungible item: book 50 chairs from stock of 100, verify 50 still available.

### Block 6 — Staff admin UI (follow-up sprint, ~2–3 days)

- [ ] **N6.1** Admin auth: Basic Auth via env-stored password (V1).
- [ ] **N6.2** `/admin/schedule` — FullCalendar grid per item.
- [ ] **N6.3** `/admin/reservations` — filterable list with customer search.
- [ ] **N6.4** `/admin/blocks/new` — form to insert `status='block'` reservation.
- [ ] **N6.5** `/admin/inventory` — per-item stock-vs-reserved chart.

### Block 7 — Operations (post-launch)

- [ ] **N7.1** External uptime monitor (UptimeRobot free tier or equivalent).
- [ ] **N7.2** Runbooks: "customer paid but no confirmation" + "Neon incident" (with optional `pg_dump` to S3 fallback on free tier).
- [ ] **N7.3** Credential rotation cadence for PayPal / Resend / Neon.

---

## Completed

- **P1.1** (2026-07-08) — Neon project provisioned with `main` (prod) + `dev` branches in `us-east-1`; connection strings captured in `.env.local` as `DATABASE_URL` / `DATABASE_URL_DEV`.
- **P1.2** (2026-07-09) — Scheduler schema (`items` minimal + `reservations` + partial index) authored in `lib/scheduler/db/schema.sql` and applied to **both** Neon branches (`dev` via `npm run db:apply`, `main` via `npm run db:apply:prod`; both idempotent, both empty and verified). Overlap query + integrity CHECKs verified in a rolled-back transaction; `DATABASE_URL`/`DATABASE_URL_DEV` registered in `lib/env.ts` + README.
- **P1.3 + P1.5** (2026-07-09) — Scheduler client (`lib/scheduler/{client,db,types,errors}.ts`) built on `pg` with an advisory-lock transaction for race-safe booking; 4 methods verified end-to-end against Neon. `pg`/`@types/pg` added; `vitest.config.ts` aliases `server-only` for tests.
- **P1.6** (2026-07-13) — Unit tests for the DB-backed data layer: `lib/scheduler/client.test.ts` (all 4 scheduler methods) + `lib/products/repository.test.ts` (item/price→`Product` mapping + cache), both mocking the `lib/scheduler/db.ts` seam via `vi.mock`. 25 new tests; full suite 43 pass; typecheck clean. **Block 1 (build scheduler) complete** — next up is Block 2 (swap call sites + ICS feed).
- **Products in DB + P1.4 + P1.7** (2026-07-10) — Reversed the P1.2 "config is source of truth" decision: the **database now owns the full product**. `items` expanded (content, policy, `available_hours` jsonb, transitional `resource_id`) + new `item_prices` table (day/time-scoped rows; flat now, variable-pricing-ready). `lib/products/config.ts` replaced by client-safe `lib/products/types.ts` + async `lib/products/repository.ts` (DB→`Product` mapper, 30s per-instance cache); the 6 `getProduct`/`ALL_PRODUCTS` call sites now `await`. `quote()` resolves the rate from price rows (`resolveRate`). `lib/scheduler/policy.ts` (P1.4) + buffer plumbing added. Seed script + `db:seed`/`db:seed:prod` seeded both Neon branches (P1.7). Typecheck clean (only pre-existing BookingWidget errors remain), 18 tests pass, storefront verified rendering products from the DB.

---

## Change log

- **2026-07-08** — Initial plan created from ARCHITECTURE_PLAN_B.md.
- **2026-07-08** — Data & trust flow diagram converted from ASCII to Mermaid.
- **2026-07-08** — Removed Stripe; PayPal (nonprofit rate) is the sole payment processor, matching BCC's existing setup.
- **2026-07-08** — P1.1 complete: Neon `main`/`dev` branches provisioned in `us-east-1`.
- **2026-07-09** — P1.2 complete: scheduler schema defined (raw SQL + `pg`, minimal `items`) and applied to both Neon branches (`dev` + `main`).
- **2026-07-09** — P1.3 + P1.5 complete: `lib/scheduler/` client (`getAvailability`/`createReservation`/`cancelReservation`/`getReservation`) on `pg` with advisory-lock booking, plus Zod types; verified against Neon.
- **2026-07-10** — Products moved into Postgres (reverses the P1.2 minimal-`items` decision): DB is source of truth for the full product; `items` expanded + new `item_prices` table (variable-pricing-ready). P1.4 (`lib/scheduler/policy.ts` + buffer plumbing) and P1.7 (seed script, both branches seeded) complete.
- **2026-07-13** — P1.6 complete: mocked-`pg` unit tests for `lib/scheduler/client.ts` + `lib/products/repository.ts` (25 tests; suite 43 pass). Block 1 done.
