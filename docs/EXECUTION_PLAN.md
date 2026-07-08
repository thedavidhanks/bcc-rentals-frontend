# BCC Rentals — Execution Plan (Plan B)

Living document tracking execution of [ARCHITECTURE_PLAN_B.md](./ARCHITECTURE_PLAN_B.md). Update task statuses as work progresses and commit each change.

**Last updated:** 2026-07-08

---

## Architecture summary

Target production stack — all owned in this Next.js repo, no PHP, no Lightsail, no separate booking system. Hard ceiling: **$30/mo** platform spend (excl. per-transaction fees).

| # | Component | Role | Hosting |
| - | --- | --- | --- |
| 1 | **Storefront + `/admin`** (Next.js App Router, pinned to 15) | Public UI, checkout, webhooks, staff admin | AWS Amplify Hosting |
| 2 | **Neon Postgres** | System of record: `items`, `reservations` | Neon serverless (free tier) |
| 3 | **Upstash Redis** | Pending orders (1h TTL), fulfill locks, webhook dedup | Upstash (free tier) |
| 4 | **Stripe** | Card via Stripe Checkout | Stripe-hosted |
| 5 | **PayPal** | PayPal + Venmo Smart Buttons (nonprofit rate 1.99% + $0.49) | PayPal-hosted |
| 6 | **Resend** | Customer + staff notification emails | Resend-hosted |
| 7 | **DNS** | `rentals.bachmancc.org` → Amplify (GoDaddy CNAME) | GoDaddy |
| 8 | **Observability** | Amplify logs + pino + Neon dashboard | AWS + Neon |

**Estimated monthly platform spend:** ~$0–3/mo.

### Data & trust flow

```
                    rentals.bachmancc.org
                            |
                            v
             +---------------------------+
             |   AWS Amplify Hosting     |
             |   Next.js 15              |
             |   Storefront + /admin     |
             +---------------------------+
                       /  |  \
              Upstash    Neon    Stripe / PayPal / Resend
              (ephemeral) (durable)
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

- [ ] **P1.1** Provision Neon Postgres project with two branches: `main` (prod) and `dev` (shared dev/preview). Capture `DATABASE_URL` for each.
- [ ] **P1.2** Define schema in `lib/scheduler/db/schema.sql` (or Drizzle/Kysely). Tables: `items`, `reservations` + `reservations_item_time_idx`.
- [ ] **P1.3** Build `lib/scheduler/client.ts` — 4 methods: `getAvailability`, `createReservation`, `cancelReservation`, `getReservation`. Use `@neondatabase/serverless` or `pg`.
- [ ] **P1.4** Build `lib/scheduler/policy.ts` — validates buffer / min length / available hours / lead time / booking horizon.
- [ ] **P1.5** Build `lib/scheduler/types.ts` — Zod schemas matching existing LibreBooking client surface so call sites change minimally.
- [ ] **P1.6** Unit tests for `lib/scheduler/*` (mock Postgres client; mirror existing `lib/librebooking/*.test.ts` style).
- [ ] **P1.7** Seed initial items in production Neon: tent, popcorn machine, party room. (Chairs / tables / additional items per P4.)

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
- [ ] **N3.4** Register production webhook URLs in Stripe + PayPal dashboards against the Amplify HTTPS URL.

### Block 4 — Product & policy decisions (BCC admin, parallelizable with dev)

- [ ] **N4.1** Confirm final rental pricing per item.
- [ ] **N4.2** Confirm party-room hours and slot length.
- [ ] **N4.3** Confirm min lead time and max advance booking window per item.
- [ ] **N4.4** Define fungible inventory (chairs, tables, plates, etc.) with `total_stock` quantities.
- [ ] **N4.5** Verify Resend sending domain `bachmancc.org` (SPF/DKIM records).
- [ ] **N4.6** Finalize cancellation/refund policy text in the confirmation email.

### Block 5 — Production smoke test

- [ ] **N5.1** Availability respects existing reservations.
- [ ] **N5.2** Stripe → webhook → reservation written → email arrives → success page renders.
- [ ] **N5.3** PayPal equivalent (sandbox → live).
- [ ] **N5.4** Two concurrent browsers on the same slot → second sees clean error + auto-refund.
- [ ] **N5.5** Fungible item: book 50 chairs from stock of 100, verify 50 still available.

### Block 6 — Staff admin UI (follow-up sprint, ~2–3 days)

- [ ] **N6.1** Admin auth: Basic Auth via env-stored password (V1).
- [ ] **N6.2** `/admin/schedule` — FullCalendar grid per item.
- [ ] **N6.3** `/admin/reservations` — filterable list with customer search.
- [ ] **N6.4** `/admin/blocks/new` — form to insert `status='block'` reservation.
- [ ] **N6.5** `/admin/inventory` — per-item stock-vs-reserved chart.

### Block 7 — Operations (post-launch)

- [ ] **N7.1** External uptime monitor (UptimeRobot free tier or equivalent).
- [ ] **N7.2** Runbooks: "customer paid but no confirmation" + "Neon incident" (with optional `pg_dump` to S3 fallback on free tier).
- [ ] **N7.3** Credential rotation cadence for Stripe / PayPal / Resend / Neon.

---

## Completed

_None yet._

---

## Change log

- **2026-07-08** — Initial plan created from ARCHITECTURE_PLAN_B.md.
