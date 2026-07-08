# BCC Rentals — Architecture Plan B

End goal: a production environment hosted entirely on **AWS Amplify**, with all reservation logic owned in this Next.js codebase, backed by **Neon Postgres** (free tier) for durable state and **Upstash Redis** for ephemeral state. No PHP, no Lightsail, no separate booking system. Hard ceiling: **$30/mo total subscription-style platform spend** (excluding per-transaction PayPal fees).

This plan is an alternative to [ARCHITECTURE_PLAN.md](./ARCHITECTURE_PLAN.md). See [ARCHITECTURE_COMPARISON.md](./ARCHITECTURE_COMPARISON.md) for a side-by-side comparison.

## Key changes from Plan A

- **No LibreBooking** — reservation logic moves into this repo as `lib/scheduler/`.
- **No Lightsail** — entire compute footprint collapses to AWS Amplify Hosting.
- **Neon Postgres** replaces LibreBooking + MySQL as the system of record for reservations.
- **Two inventory models** — unique resources (rooms, tools, tents) and fungible inventory (chairs, plates, tables) — both supported in one schema.
- **Staff admin UI** — a small `/admin` section inside this Next.js app for schedule view, manual blocks, reservation search, and inventory dashboard.
- **Email + ICS feed at launch** — staff get notification emails (via Resend) and can subscribe to per-resource ICS feeds in their personal calendars. Full admin UI ships in a follow-up sprint.

## System components

| # | Component | Role | Hosting | Owner | Monthly cost (est.) |
| - | --- | --- | --- | --- | --- |
| 1 | **Storefront + admin** (this repo) — Next.js App Router | Public UI, checkout, webhooks, staff admin pages | AWS Amplify Hosting | Dev team | $0 first 12 months (Amplify free tier on new AWS account), ~$1–3/mo after |
| 2 | **Neon Postgres** | System of record for items, reservations, manual blocks | Neon serverless (free tier) | Dev team | $0 free tier (0.5 GiB storage, ~191 compute-hours/mo — far exceeds BCC volume) |
| 3 | **Upstash Redis** | Pending orders (1h TTL), fulfill locks, webhook dedup keys | Upstash serverless (REST) | Dev team | $0 free tier |
| 4 | **PayPal** | PayPal + Venmo via Smart Buttons (BCC 501(c)(3) nonprofit rate: 1.99% + $0.49); webhook → `/api/webhooks/paypal` | PayPal-hosted | Dev team | per-transaction fees only |
| 5 | **Resend** | Customer confirmation emails + staff reservation notifications | Resend-hosted | Dev team | $0 free tier (3K emails/mo) |
| 6 | **DNS / domain** | `rentals.bachmancc.org` → Amplify | GoDaddy (existing registrar for `bachmancc.org`) | BCC admin | Already paid |
| 7 | **Observability** | Amplify built-in build/access logs; pino logs in [lib/logger.ts](../lib/logger.ts); Neon dashboard for DB metrics | AWS + Neon | Dev team | $0 |

**Estimated steady-state monthly platform spend: ~$0–3/mo** (Amplify dominates after the 12-month free tier). Per-transaction PayPal fees are on top and scale with rental revenue. Well under the $30/mo cap with significant headroom.

## Data model

The reservation system needs to handle two distinct inventory types:

| Type | Examples | Identity matters? | How it's stored | How availability is checked |
| --- | --- | --- | --- | --- |
| **Unique resources** | Party room, specific tent, specific tool | Yes — only one of it | `items` row with `total_stock = 1` | Any overlapping non-cancelled reservation = unavailable |
| **Fungible inventory** | Chairs, plates, generic tables | No — interchangeable | `items` row with `total_stock = N` (e.g., 100 chairs) | `total_stock - SUM(qty reserved during overlap) >= requested_qty` |

### Schema (initial)

```sql
CREATE TABLE items (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,
  name            text not null,
  type            text not null check (type in ('unique', 'fungible')),
  total_stock     int not null default 1,
  description     text,
  price_cents     int not null,
  pricing_unit    text not null check (pricing_unit in ('hour', 'day', 'event')),
  min_minutes     int,
  buffer_minutes  int not null default 0,
  lead_hours      int not null default 0,
  horizon_days    int not null default 365,
  available_hours jsonb,  -- per-day-of-week windows, e.g. {"sat": [[9,21]], "sun": [[9,21]]}
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

CREATE TABLE reservations (
  id              uuid primary key default gen_random_uuid(),
  item_id         uuid not null references items(id),
  quantity        int not null default 1,
  start_at        timestamptz not null,
  end_at          timestamptz not null,
  status          text not null check (status in ('confirmed', 'block', 'cancelled')),
  order_id        text,  -- references Upstash order key when reservation came from a paid booking
  customer_email  text,
  customer_name   text,
  customer_phone  text,
  notes           text,
  created_at      timestamptz not null default now()
);

CREATE INDEX reservations_item_time_idx
  ON reservations(item_id, start_at, end_at)
  WHERE status <> 'cancelled';
```

### Availability queries

```sql
-- Unique item: 0 free, >0 blocked
SELECT COUNT(*) FROM reservations
WHERE item_id = $1
  AND status <> 'cancelled'
  AND NOT (end_at <= $2 OR start_at >= $3);

-- Fungible item: how much is already reserved in the requested window
SELECT COALESCE(SUM(quantity), 0) FROM reservations
WHERE item_id = $1
  AND status <> 'cancelled'
  AND NOT (end_at <= $2 OR start_at >= $3);
```

### Per-item policy validation

Buffer time, min/max slot length, available hours, lead time, and booking horizon are stored as columns on `items` and validated in `lib/scheduler/policy.ts` before any insert. These were LibreBooking config in Plan A; in Plan B they're per-item business rules in the database, editable without a redeploy.

## Module structure

```
lib/
  scheduler/
    client.ts        # 4-method surface: getAvailability, createReservation, cancelReservation, getReservation
    db.ts            # Neon client / connection pool
    policy.ts        # Validates buffer / min length / hours / lead / horizon
    types.ts         # Zod schemas for inputs/outputs
    errors.ts        # SchedulerError, SchedulerConflictError
  orders/
    preflight.ts     # unchanged shape; imports lib/scheduler instead of lib/librebooking
    fulfill.ts       # unchanged shape; same Redis fulfill lock pattern
app/
  admin/             # (deferred to follow-up sprint)
    layout.tsx
    page.tsx
    schedule/page.tsx
    reservations/page.tsx
    blocks/new/page.tsx
    inventory/page.tsx
  api/
    calendar/[itemSlug]/route.ts  # ICS feed for staff calendar subscription (ships at cutover)
```

The 4 LibreBooking-era methods map cleanly:

| Plan A (LibreBooking) | Plan B (Scheduler) |
| --- | --- |
| `librebooking.authenticate()` | none — Neon uses standard `DATABASE_URL` connection pool |
| `librebooking.getResourceAvailability(id, start, end)` | `scheduler.getAvailability(itemSlug, start, end, qty)` |
| `librebooking.findOrCreateUser(...)` | none — customer email/name embedded on reservation; PayPal payer ID is canonical |
| `librebooking.createReservation(...)` | `scheduler.createReservation({ itemSlug, qty, start, end, customer, orderId })` |
| `LibreBookingConflictError` | `SchedulerConflictError` |

[lib/orders/preflight.ts](../lib/orders/preflight.ts) and [lib/orders/fulfill.ts](../lib/orders/fulfill.ts) change only their imports and drop the `findOrCreateUser` call.

## Staff admin UX

| Need | Solution | When it ships |
| --- | --- | --- |
| "I want to know when a booking comes in" | Resend email to `reservations@bachmancc.org` from [lib/orders/fulfill.ts](../lib/orders/fulfill.ts) | At cutover |
| "I want to see the schedule on my phone" | Per-item ICS feed at `/api/calendar/[itemSlug]`; staff subscribe URL in personal Google/Apple/Outlook Calendar | At cutover (+~2 hours dev) |
| "I want to block a date for maintenance" | Admin page: `/admin/blocks/new` | Follow-up sprint |
| "I want to see this month at a glance" | Admin page: `/admin/schedule` with [FullCalendar](https://fullcalendar.io/) grid | Follow-up sprint |
| "How many chairs are reserved Saturday?" | Admin page: `/admin/inventory` per-item stock-vs-reserved chart | Follow-up sprint |
| "Customer called — what time did they book?" | Admin page: `/admin/reservations` filterable list with search | Follow-up sprint |

Admin auth: HTTP Basic Auth with a shared password in env at launch; upgrade to Clerk free tier (10K MAU, $0) if/when individual staff accounts are needed.

## AWS hosting

Single AWS Amplify app. No Lightsail, no VPC, no security groups, no Docker, no MySQL.

| Line | Service | Sizing | Monthly |
| --- | --- | --- | --- |
| Storefront + admin | Amplify Hosting (SSR) for Next.js | Build minutes + SSR compute + transfer | $0 first 12 months (free tier), ~$1–3/mo after |
| Monitoring | Amplify built-in build & access logs | n/a | $0 |
| **Total AWS** | | | **~$0–3** |

### Why these choices

- **Neon over Supabase / RDS** — Neon's free tier is generous and serverless-scales-to-zero; Supabase pauses free projects after 7 days inactivity (a problem for a low-traffic site); RDS has no free tier after the first 12 months. Standard Postgres with the `pg` driver — no lock-in.
- **Postgres over Upstash for reservations** — Reservations need range queries (`WHERE NOT (end_at <= ? OR start_at >= ?)`) and quantity aggregations (`SUM(quantity)`). Both are trivial in SQL; both are awkward in Redis past the smallest scale. Inventory is also naturally relational.
- **Upstash for ephemeral state only** — Pending orders, fulfill locks, webhook dedup keys — short-lived key/value, perfect Redis fit.
- **Amplify Hosting over Vercel** — Same reasoning as Plan A: no ToS exposure for commercial use, single AWS bill, fits budget.

### Hard prerequisite: pin Next.js to 15

Same as Plan A — Amplify Hosting supports Next.js 12–15 per [AWS Amplify SSR documentation](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html), so the repo's current Next.js 16 must be downgraded before cutover.

### Amplify feature gaps to audit before cutover

Same list as Plan A: `grep` for `revalidatePath`, `revalidateTag`, `unstable_after`, `runtime = "edge"`, streaming responses, middleware on optimized images.

## Data & trust boundaries

```
                          rentals.bachmancc.org
                                    |
                                    v
                       +---------------------------+
                       |   AWS Amplify Hosting     |
                       |   Next.js (pinned to 15)  |
                       |   Storefront + /admin     |
                       +---------------------------+
       server-only modules /        |        \ server-only modules
                          /         |         \
                  Upstash Redis    Neon        PayPal / Resend
                  (ephemeral:      Postgres    (HTTPS APIs)
                   pending orders, (durable:
                   locks, dedup)    items,
                                    reservations,
                                    blocks)
```

- Every server module that touches secrets imports `"server-only"`.
- Env vars are Zod-validated at boot in [lib/env.ts](../lib/env.ts).
- Only `NEXT_PUBLIC_*` vars (site URL, PayPal client ID) cross to the browser.
- Webhooks verify signatures before any side effect.
- Confirm-then-book invariant unchanged: reservation rows are only inserted after payment succeeds.
- Conflict guard is the existing Redis fulfill lock + a re-check inside a Postgres transaction (Postgres alone can't enforce no-overlap as a constraint; the lock + read-then-write pattern is load-bearing, same as today).
- Admin pages behind Basic Auth (V1) / Clerk (V2); admin mutations write directly to Postgres.

## Production environments

| Environment | Purpose | Postgres | PayPal | Notes |
| --- | --- | --- | --- | --- |
| Local dev | Devcontainer | Neon branch (preview) or local Postgres | PayPal sandbox via reserved ngrok domain | See README "Local end-to-end testing" |
| Amplify Preview | Per-PR previews | Neon branch (auto-created per PR) | Sandbox keys | Neon's branching maps cleanly to Amplify preview environments |
| Amplify Production | `rentals.bachmancc.org` | Neon main branch | Live keys | Webhooks registered against the Amplify HTTPS URL |

## Next steps

Ordered by dependency. Blocks 1–3 must complete before production cutover.

### Block 1 — Build the scheduler module (dev, ~3 days)

1. **Provision Neon Postgres project** with two branches: `main` (production) and `dev` (shared dev/preview). Capture `DATABASE_URL` for each.
2. **Define schema** in `lib/scheduler/db/schema.sql` (or via Drizzle/Kysely if a migration tool is preferred). Initial tables: `items`, `reservations`.
3. **Build `lib/scheduler/client.ts`** with 4 methods: `getAvailability`, `createReservation`, `cancelReservation`, `getReservation`. Use `pg` or `@neondatabase/serverless`.
4. **Build `lib/scheduler/policy.ts`** for buffer / min length / hours / lead / horizon validation.
5. **Build `lib/scheduler/types.ts`** with Zod schemas matching the existing client surface shape so call sites change minimally.
6. **Unit tests** in the same style as the existing tests (mock the Postgres client).
7. **Seed initial items** in production: tent, popcorn machine, party room. Add chairs / tables / additional items per Block 4 decisions.

### Block 2 — Swap call sites + ship ICS feed (dev, ~1 day)

8. **Downgrade Next.js 16 → 15** (same as Plan A Block 2.1).
9. **Audit codebase for Amplify-unsupported features** (same as Plan A Block 2.2).
10. **Swap imports** in [app/api/availability/route.ts](../app/api/availability/route.ts), [lib/orders/preflight.ts](../lib/orders/preflight.ts), [lib/orders/fulfill.ts](../lib/orders/fulfill.ts) from `lib/librebooking` to `lib/scheduler`.
11. **Drop the `findOrCreateUser` call** in fulfill.ts; pass customer email/name directly into `createReservation`.
12. **Add ICS feed route** at `app/api/calendar/[itemSlug]/route.ts` using the `ics` npm package.
13. **Add staff notification email** in fulfill.ts (Resend) if not already present.
14. **Delete `lib/librebooking/`** and all `LIBREBOOKING_*` / `LB_RESOURCE_ID_*` env vars; remove from [lib/env.ts](../lib/env.ts), `.env.local.example`, and the README env table.

### Block 3 — Deploy to Amplify (dev, ~half day)

15. **Create the Amplify app** from the GitHub repo.
16. **Port env vars** into Amplify Production and Preview environments (now includes `DATABASE_URL`; no LibreBooking vars).
17. **Add the `rentals.bachmancc.org` custom domain** in Amplify; cut the GoDaddy CNAME (lower TTL first).
18. **Register production webhook URLs** in the PayPal dashboard against the Amplify HTTPS URL.

### Block 4 — Product & policy decisions

19. Confirm final rental pricing per item.
20. Confirm party-room hours and slot length.
21. Confirm min lead time and max advance booking window per item.
22. Define fungible inventory (chairs, tables, plates, etc.) with `total_stock` quantities.
23. Verify Resend sending domain `bachmancc.org` (SPF/DKIM records).
24. Finalize cancellation/refund policy text in the confirmation email.

### Block 5 — Production smoke test

25. Walk the README "Smoke checklist" against production:
    - Availability respects existing reservations
    - PayPal (sandbox → live) → webhook → reservation written → email arrives → success page renders
    - Two concurrent browsers on the same slot → second sees a clean error and an auto-refund
    - Fungible item: book 50 chairs from a stock of 100, verify 50 still available

### Block 6 — Staff admin UI (follow-up sprint, ~2-3 days)

26. **Admin auth**: Basic Auth via env-stored password (V1).
27. **`/admin/schedule`**: FullCalendar grid per item.
28. **`/admin/reservations`**: filterable list with customer search.
29. **`/admin/blocks/new`**: form to insert a `status='block'` reservation.
30. **`/admin/inventory`**: per-item stock-vs-reserved chart.

### Block 7 — Operations (post-launch)

31. External uptime monitor (UptimeRobot free tier or equivalent).
32. Runbooks: "customer paid but no confirmation" (check Upstash pending order, manual fulfill or refund); "Neon incident" (Neon's status page + automated backups; on free tier, periodic `pg_dump` to S3 as a fallback if needed).
33. Credential rotation cadence for PayPal / Resend / Neon.

## Security posture summary

- TLS everywhere — Amplify Hosting provides automatic HTTPS; Neon enforces TLS for Postgres connections.
- No self-managed server — no SSH keys, no OS patching, no Docker, no MySQL admin.
- Secrets only in Amplify env store and devcontainer-local `.env.local` (gitignored); Zod-validated at boot.
- Webhook signature verification on PayPal; event IDs deduped via Redis `SET NX` (24h TTL).
- Idempotent, lock-guarded fulfillment prevents double-booking even under concurrent webhook + capture callbacks.
- Admin pages behind Basic Auth (V1) / Clerk (V2); no public surface.
- Neon includes automated daily backups; PITR available on paid tier if/when reservation volume justifies it.
