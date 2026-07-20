# BCC Rentals — Admin App Build Spec

Instructions for the agent building the **rentals administration app**. This is a
**separate project / repo** from the storefront ([bcc-rentals-frontend](../)), but it
shares the storefront's **Neon Postgres** database as the single source of truth for the
product catalog and reservations. Nothing here changes the storefront; the admin app is a
second writer to the same tables.

Read this whole document before starting. The three things that will bite you if skipped:

1. **Reservation writes must be race-safe** — the storefront books against these same
   rows under a per-item advisory lock. Your calendar writes must use the identical
   pattern or you will double-book. See [§8](#8-writing-to-the-calendar-race-safety).
2. **All money is integer cents, all times are minutes since local midnight in
   `America/New_York`.** There are no floats and no UTC offsets stored. See [§4](#4-existing-schema-catalog--reservations).
3. **Do not assume users have Google accounts.** Auth is via Firebase Authentication /
   Google Cloud Identity Platform with multiple social providers. See [§3](#3-authentication--authorization).

---

## 1. Scope & roles

Build an authenticated web app with **two role groups**:

| Capability | Scheduler | Admin |
|---|:--:|:--:|
| Sign in | ✅ | ✅ |
| View catalog, categories, calendar | ✅ | ✅ |
| **Commit items to dates on the calendar** (staff holds / blocks) | ✅ | ✅ |
| Create/edit/cancel reservations (incl. multi-product & recurring) | ✅ | ✅ |
| **Set / edit prices for items** (add, edit, delete `item_prices` rows) | ✅ | ✅ |
| **Add / edit / deactivate products** (`items`, incl. base price) | ❌ | ✅ |
| **Add / edit categories** (`categories`) | ❌ | ✅ |
| **Assign products to categories** (`item_categories`) | ❌ | ✅ |
| Manage users & roles | ❌ | ✅ |

Admins have **all** scheduler permissions plus catalog/category/user management. Enforce
this on the **server** (every mutating route/action checks the caller's role) — never rely
on hiding UI alone.

Out of scope: taking payments and issuing refunds (that stays in the storefront's PayPal
flow). The admin app may view storefront-created paid reservations and cancel staff blocks,
but does not touch money.

---

## 2. Architecture

- **Framework:** Next.js (App Router) + TypeScript, same as the storefront, so it deploys
  to Cloud Run identically. (You may use any stack that speaks Postgres, but the rest of
  this doc assumes Next.js + `pg`.)
- **Database:** the **same** Neon Postgres instance as the storefront. Use Neon's
  **pooled** connection string for runtime queries (`DATABASE_URL`), and the direct/dev
  endpoint (`DATABASE_URL_DEV`) only for one-off DDL/tooling. Access via `pg` `Pool`, and
  wrap multi-statement writes in a transaction (mirror
  [lib/scheduler/db.ts](../lib/scheduler/db.ts) — `getPool()` + `withTransaction()`).
- **Auth:** Firebase Authentication / GCP Identity Platform (see [§3](#3-authentication--authorization)).
- **Hosting:** GCP Cloud Run, scale-to-zero, secrets in Secret Manager — the storefront's
  runbook [docs/DEPLOY_CLOUD_RUN.md](./DEPLOY_CLOUD_RUN.md) applies almost verbatim. See
  [§10](#10-deployment-gcp-cloud-run).
- **Money & time conventions (do not deviate):**
  - Prices are **integer cents** (`price_cents`). Never store dollars/floats.
  - `days_of_week` is a `smallint[]`, `0=Sun … 6=Sat` (matches JS `getDay()` and PG
    `EXTRACT(DOW)`). `null` = every day.
  - `start_minute` / `end_minute` are **minutes since local midnight in
    `America/New_York`** (0–1440), **both null or both set**, and `end_minute >
    start_minute`.
  - Reservation `start_at` / `end_at` are `timestamptz` — store real instants (UTC under
    the hood); convert to/from Eastern only for display and for validating against
    `available_hours`.

> The admin app and storefront must agree on these conventions because they read each
> other's rows. When in doubt, match what [scripts/db/seed-products.mjs](../scripts/db/seed-products.mjs)
> and [lib/products/repository.ts](../lib/products/repository.ts) do.

---

## 3. Authentication & authorization

**Do not assume users have Google accounts.** Schedulers and admins are church staff and
volunteers who may only have a GitHub, Facebook, Apple, or Google login. Use **Firebase
Authentication** (a.k.a. **Google Cloud Identity Platform** — same product, Identity
Platform is the GCP-console face of it) so multiple social identity providers are available
from one integration:

- Enable these providers in the Firebase/Identity Platform console: **Google, GitHub,
  Facebook, Apple** (add email/password only if BCC wants it). Each provider needs its own
  OAuth app/keys configured in that provider's developer console and pasted into
  Firebase — document those steps in the admin app's README as you set them up.
- **Client:** the Firebase Web SDK renders the sign-in UI and returns a signed **ID token**
  (a JWT) after login. Firebase gives every user a stable **UID** that is the same
  regardless of which provider they used (when identities are linked / email matches).
- **Server:** verify the ID token with the **Firebase Admin SDK** on every request
  (`verifyIdToken`), or — preferred for a server-rendered Next.js app — exchange the ID
  token for a **session cookie** via `createSessionCookie()` and verify that cookie in
  middleware. Never trust a token that hasn't been verified server-side.

### Where account IDs and permissions live

**The Firebase UID is the durable account identifier; the app's own `app_users` table is
the source of truth for group membership (role).** Do not rely on the email as the key
(a user can change providers / emails) and do not treat Firebase itself as the permission
store beyond identity.

1. **Account id** → `app_users.uid` = the Firebase UID (`text`, unique). Store email + name
   alongside it for display/contact, but authorize off the UID.
2. **Permissions (group)** → `app_users.role` (`'scheduler' | 'admin'`). This DB column is
   the **canonical** permission store. On each request: verify the token → get the UID →
   look up `app_users` by UID → load `role`. If no active row exists, **deny access** (do
   not auto-provision; an admin adds people first).
3. **Optional fast-path:** mirror the role into a Firebase **custom claim**
   (`admin.auth().setCustomUserClaims(uid, { role })`) whenever an admin changes it, so the
   role rides inside the verified token and you can gate middleware without a DB hit. If you
   do this, the DB row remains authoritative and the claim is just a cache — re-sync it on
   every role change, and still fall back to the DB lookup.

Every server action / API route re-checks the role:
- scheduler-level mutations require `role IN ('scheduler','admin')`
- admin-level mutations require `role = 'admin'`

Bootstrap the first admin by inserting one `app_users` row by hand after that person signs
in once (so you have their UID). See [§5](#5-new-schema-you-must-add).

---

## 4. Existing schema (catalog + reservations)

These tables already exist and are owned by the storefront. The canonical DDL is
[lib/scheduler/db/schema.sql](../lib/scheduler/db/schema.sql) — read it. Summary of what
you'll read and write:

### `items` — one row per product (Admin-managed)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `slug` | text unique | URL/id key, e.g. `party-room` |
| `name` | text | display name |
| `type` | text | `'unique'` (stock 1) or `'fungible'` (stock N) — **inventory model**, distinct from browse category |
| `total_stock` | int > 0 | capacity; `1` for unique items |
| `active` | boolean | storefront lists only `active = true`; **deactivate instead of deleting** |
| `short_description` | text | |
| `long_description` | text | |
| `highlights` | text[] | bullet list |
| `image` | text | path under storefront `public/`, e.g. `/images/tent.jpg` |
| `pricing_unit` | text | `'hour'`, `'day'`, or `'event'` |
| `min_minutes` | int? | min booking length (1440 = 1 day) |
| `max_minutes` | int? | max booking length; null = unbounded |
| `buffer_minutes` | int ≥ 0 | widens overlap window between bookings |
| `lead_hours` | int ≥ 0 | min lead time before a booking may start |
| `horizon_days` | int > 0 | how far ahead bookings are allowed |
| `available_hours` | jsonb? | `{openHour,closeHour,slotMinutes}` for hourly items; null = unrestricted (day items) |
| `resource_id` | int? | transitional/legacy; leave null for new items |
| `sort_order` | int | display order |
| `updated_at` | timestamptz | **set to `now()` on every edit** |

Check constraints exist for `pricing_unit`, min/max minutes, buffer/lead/horizon; respect
them or inserts throw.

### `item_prices` — day/time-scoped pricing (Scheduler + Admin managed)
One item has **one or more** price rows; the effective rate for a booking is the
highest-`priority` row whose day/time scope matches.
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `item_id` | uuid FK → items | `ON DELETE CASCADE` |
| `price_cents` | int ≥ 0 | **cents** |
| `days_of_week` | smallint[]? | `0=Sun..6=Sat`; null = every day |
| `start_minute` | int? | 0–1440, local Eastern minutes; null = all hours |
| `end_minute` | int? | must be null iff `start_minute` is null; `> start_minute` |
| `priority` | int | higher wins on overlap |
| `label` | text? | admin-facing, e.g. `"Weekend rate"` |
| `created_at`,`updated_at` | timestamptz | |

Common shapes: **1 row** (all days/all hours) = one flat rate = the product's **base
price**; **2 rows** = weekday vs weekend; **N rows** = specific days and/or hour windows.
There must always be at least one matching row or the item can't be quoted — a good UI
keeps one all-days/all-hours "base" row. The "base price" collected on the Add Product page
is exactly this first all-days/all-hours row.

### `categories` — browse categories (Admin-managed)
`id` uuid PK · `slug` text unique · `name` text · `sort_order` int · `created_at`. Seeded
with `room, tool, accessory, event-add-on, furniture, equipment, decor` (schema.sql
`INSERT ... ON CONFLICT DO NOTHING`).

### `item_categories` — product↔category join (Admin-managed)
`(item_id, category_id)` composite PK, both FKs `ON DELETE CASCADE`. Many-to-many: a
product can be in several categories.

### `reservations` — bookings & staff blocks (Scheduler-writable)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `item_id` | uuid FK → items | |
| `quantity` | int > 0 | for fungible items; 1 for unique |
| `start_at`,`end_at` | timestamptz | `end_at > start_at` |
| `status` | text | `'confirmed'` (paid storefront booking), `'block'` (**staff hold — what schedulers create**), `'cancelled'` |
| `order_id` | text? | Redis order key for paid bookings; null for staff blocks |
| `customer_email/name/phone` | text? | optional; for blocks use to note who/why |
| `notes` | text? | free text |
| `created_at` | timestamptz | |

Capacity for a window = `total_stock - SUM(quantity)` of non-cancelled overlapping
reservations. The partial index `reservations_item_time_idx` covers `status <>
'cancelled'`. **You will add nullable `group_id` / `series_id` columns to this table** in
§5 to support multi-product and recurring bookings; the storefront ignores them.

---

## 5. New schema you must add

Add these against the same Neon DB. Keep them idempotent (`CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`) so re-applying is safe alongside the storefront's schema. Ship
this as the admin app's own `schema.sql` + an apply script (mirror
[scripts/db/apply-schema.mjs](../scripts/db/apply-schema.mjs)).

```sql
-- Admin/scheduler accounts. Firebase UID is the durable account id; role is the
-- canonical permission store (see §3). Email/name are for display only.
CREATE TABLE IF NOT EXISTS app_users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uid        text UNIQUE NOT NULL,           -- Firebase Authentication UID
  email      text,                           -- lowercase; for display/contact, not the key
  name       text,
  role       text NOT NULL CHECK (role IN ('scheduler', 'admin')),
  active     boolean NOT NULL DEFAULT true,
  last_login timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_users_email_idx ON app_users (lower(email));

-- A reservation "booking" groups multiple item reservations that were made together
-- (e.g. Auditorium + 2 rooms + 200 chairs for one Sunday event). One group → many
-- rows in `reservations`.
CREATE TABLE IF NOT EXISTS reservation_groups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text,                        -- e.g. "Sunday service"
  contact_name   text,
  contact_email  text,
  contact_phone  text,
  notes          text,
  series_id      uuid REFERENCES reservation_series(id) ON DELETE SET NULL,
  occurrence_at  timestamptz,                 -- anchor date of this occurrence (null = one-off)
  created_by     text,                        -- app_users.uid of the scheduler/admin
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Recurrence rule for a repeating booking. Each occurrence materializes as one
-- reservation_group + its reservation rows (see §9).
CREATE TABLE IF NOT EXISTS reservation_series (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  freq           text NOT NULL CHECK (freq IN ('daily','weekly','monthly','yearly')),
  interval       int  NOT NULL DEFAULT 1 CHECK (interval > 0),   -- "every X" → interval = X
  by_weekday     smallint[],                  -- weekly-on-these-days; 0=Sun..6=Sat; null = anchor's weekday
  starts_on      date NOT NULL,               -- first occurrence date (Eastern)
  until_date     date,                        -- inclusive end; null if using count
  count          int,                         -- max occurrences; null if using until_date
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  check (until_date IS NOT NULL OR count IS NOT NULL)   -- must terminate somehow
);

-- Link individual reservation rows to their group and (optionally) series.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS group_id  uuid REFERENCES reservation_groups(id) ON DELETE CASCADE;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS series_id uuid REFERENCES reservation_series(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS reservations_group_idx  ON reservations (group_id);
CREATE INDEX IF NOT EXISTS reservations_series_idx ON reservations (series_id);

-- Audit trail: who changed prices, committed dates, edited products.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_uid   text NOT NULL,                  -- app_users.uid
  actor_email text,
  action      text NOT NULL,                  -- e.g. 'price.create', 'reservation.create', 'item.update'
  entity      text NOT NULL,                  -- e.g. 'item_prices', 'reservations', 'items'
  entity_id   text,                           -- affected row id/slug
  detail      jsonb,                          -- before/after or payload
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx ON admin_audit_log (created_at DESC);
```

> **Ordering note:** `reservation_groups` references `reservation_series`, and vice-versa
> conceptually. Create `reservation_series` first, then `reservation_groups`, then the
> `ALTER TABLE reservations` (which references both). Adjust the order in your `schema.sql`
> accordingly, or add the cross-FK with a separate `ALTER TABLE ... ADD CONSTRAINT` guarded
> by a `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL $$` block like schema.sql does.

**Bootstrap the first admin** (after they've signed in once so you have their UID):

```sql
INSERT INTO app_users (uid, email, name, role)
VALUES ('FIREBASE_UID_HERE', 'you@example.org', 'Your Name', 'admin')
ON CONFLICT (uid) DO UPDATE SET role = 'admin', active = true;
```

---

## 6. Feature requirements

### Scheduler features
- **Weekly calendar** of committed reservations (see [§7](#7-ui--pages) for the view spec).
- **Create reservations** — single or **multi-product**, one-off or **recurring** (see
  [§9](#9-grouped--recurring-reservations)). Each item row is `status = 'block'` and must go
  through the race-safe write in [§8](#8-writing-to-the-calendar-race-safety).
- **Edit / cancel reservations** — including "delete this occurrence" vs "delete the whole
  series" for recurring bookings ([§9](#9-grouped--recurring-reservations)). Cancelling sets
  `status = 'cancelled'` (don't hard-delete — keeps history & frees capacity via the partial
  index).
- **Set prices** — full CRUD on `item_prices` for any item. Validate: `price_cents >= 0`;
  `days_of_week` entries in 0–6; `start_minute`/`end_minute` both-or-neither, in 0–1440,
  end > start. Warn if the edit would leave the item with **no** all-days/all-hours base row.

### Admin features (all of the above, plus)
- **Products** — create/edit `items`, including the **base price** on the create form
  (writes the first all-days/all-hours `item_prices` row). Enforce the check constraints;
  set `updated_at = now()` on edit; **deactivate** (`active = false`) rather than delete so
  historical reservations keep their FK. Slug must be unique and URL-safe.
- **Categories** — create/edit `categories` (unique slug, name, sort_order).
- **Assign products to categories** — manage `item_categories` join rows.
- **User management** — CRUD `app_users` (set role, deactivate). Guard against removing the
  last active admin. If mirroring roles to Firebase custom claims, re-sync on every change.

The storefront caches the catalog for **30 seconds** per instance
([lib/products/repository.ts](../lib/products/repository.ts)), so catalog/price/category
edits appear on the storefront within ~30s automatically — no redeploy, no cache-bust.

---

## 7. UI & pages

**Global layout:** every page has a **menu bar** to reach the other pages (Calendar,
Products, Add Reservation, Update Prices, and — for admins — Categories & Users). It is
**responsive**: below a small-screen breakpoint it collapses into a **hamburger menu**.
Hide admin-only entries for schedulers, but still enforce access on the server.

### Main page — weekly calendar
- **Weekly view** (7 day columns) of reservations that have been assigned/committed.
- **Multi-day rentals span the gap of more than one day** — a Monday→Tuesday rental renders
  as a single bar spanning both the Monday and Tuesday blocks, not two separate entries.
- **Reservations that extend beyond the displayed week** show a **continuation indicator**
  (e.g. a `<` on the left edge if it started before this week, a `>` on the right edge if it
  runs into the next week).
- Distinguish `confirmed` (paid, from storefront) from `block` (staff) visually; omit or
  grey `cancelled`.
- Week navigation (prev/next/today).
- A **`+` button** on the weekly view opens the **Add Reservation** page/flow (optionally
  pre-filled with the day the user clicked).

### Products
- **Add Product page** — all `items` fields (§4) **including base price** (the first
  all-days/all-hours `item_prices` row). Admin only.
- **Edit Product page** — edit any `items` field; deactivate instead of delete. Admin only.

### Add Reservation page
- Schedule one or more products for chosen calendar day(s)/time(s).
- **Multiple products in one reservation** — the form lets the scheduler add several
  line items (product + quantity + the shared or per-item date/time window) to a single
  booking. Example: "the church has the Auditorium, 2 rental rooms, and 200 chairs for
  Sunday operating hours." All line items are saved under one `reservation_group`.
- **Recurring option** — a toggle that reveals recurrence controls:
  - Frequency: **daily, weekly, monthly, annually**, or **every X** (days / weeks / months).
    Map to `reservation_series.freq` + `interval` (e.g. "every 2 weeks" = `weekly`,
    interval `2`).
  - Optional: which weekday(s) for weekly (`by_weekday`).
  - End condition: an **until** date or a **count** of occurrences.
- On submit: run the race-safe capacity check for **every** item across **every** generated
  occurrence before committing (see [§8](#8-writing-to-the-calendar-race-safety) and
  [§9](#9-grouped--recurring-reservations)); surface any conflict clearly and don't
  partially commit.

### Edit Reservation page
- Edit the group's line items, dates, contact info, notes.
- **Delete** control. For a recurring booking it offers **delete all** (whole series) vs
  **delete this instance** (just this occurrence) — see the semantics in
  [§9](#9-grouped--recurring-reservations). Deleting = set `status = 'cancelled'` on the
  affected reservation rows (and cascade-cancel the group's rows for a group delete).

### Update Prices page
- Per item, CRUD its `item_prices` rows with the validation in §6. Show the effective/base
  rate prominently and any day/time-scoped overrides.

---

## 8. Writing to the calendar (race safety)

**This is the one place you can corrupt shared data.** The storefront creates reservations
under a **per-item Postgres advisory lock** so the availability check and the insert are
atomic ([lib/scheduler/client.ts](../lib/scheduler/client.ts), `createReservation`). Every
reservation row you write **must use the same pattern**, or a staff block and a customer
booking can both claim the last unit.

Replicate exactly, inside a single transaction, **per item**:

```sql
-- 1. Serialize all writers for this item until commit/rollback
SELECT pg_advisory_xact_lock(hashtext($itemSlug), 0);

-- 2. Re-check capacity over the buffered window (half-open interval).
--    Overlap predicate: status <> 'cancelled' AND NOT (end_at <= $start OR start_at >= $end)
--    Widen [$start,$end) by the item's buffer_minutes on each side before comparing.
SELECT COALESCE(SUM(quantity),0)::int AS reserved
  FROM reservations
 WHERE item_id = $itemId
   AND status <> 'cancelled'
   AND NOT (end_at <= $bufferedStart OR start_at >= $bufferedEnd);

-- 3. If reserved + requestedQty > total_stock  → reject (no capacity). Else:
INSERT INTO reservations (item_id, quantity, start_at, end_at, status, notes, customer_name, group_id, series_id)
VALUES ($itemId, $qty, $start, $end, 'block', $notes, $committedBy, $groupId, $seriesId);
-- 4. COMMIT (lock releases automatically)
```

Notes:
- Intervals are **half-open** `[start, end)` — a booking ending exactly at another's start
  does **not** overlap.
- `buffer_minutes` from the item widens the window on both sides before the overlap test.
- For `unique` items `total_stock = 1`; for `fungible` items respect the real stock.
- **Multi-product / multi-occurrence bookings:** wrap the whole booking in ONE transaction,
  take the advisory lock for each distinct item, check capacity for every (item × occurrence)
  window, and only then insert all rows. If any window has no capacity, roll back the entire
  booking (all-or-nothing) and report which item/date failed. To avoid deadlocks when a
  booking touches several items, **acquire the per-item locks in a stable order** (e.g. sort
  by `item_slug`).
- Optionally reuse the storefront's `lib/scheduler` module by copying it into the admin app
  — it already implements the single-item path correctly. Copying is safer than
  reimplementing.

For **policy** validation (lead time, horizon, available-hours, slot alignment, Eastern
time), mirror [lib/scheduler/policy.ts](../lib/scheduler/policy.ts). Staff blocks may
reasonably bypass lead-time/horizon rules (staff can block any date) but must still respect
the overlap/capacity check above.

---

## 9. Grouped & recurring reservations

**Grouping (multiple products in one booking).** Create one `reservation_groups` row, then
one `reservations` row per line item with that `group_id`. The Edit Reservation page loads a
booking by `group_id` and shows all its item rows together. Cancelling the group cancels all
its rows.

**Recurrence.** Materialize occurrences up front rather than storing only a rule:

1. Create a `reservation_series` row (freq, interval, by_weekday, starts_on, until/count).
2. **Expand** the rule into concrete occurrence dates (Eastern time). Cap expansion at a
   sane bound (e.g. the item's `horizon_days`, or a hard max like 104 occurrences) and
   `log`/surface if you truncate — never silently drop occurrences.
3. For **each** occurrence, create a `reservation_groups` row (`series_id` set,
   `occurrence_at` = that date) and its `reservations` rows (each carrying both `group_id`
   and `series_id`), all through the race-safe write in §8.

This makes availability queries trivial (the storefront just sees ordinary reservation rows)
and makes the two delete modes clean:
- **Delete this instance** → cancel the rows for that one occurrence's `group_id`.
- **Delete the whole series** → cancel all rows where `series_id = $id` (typically only
  future occurrences; leave past ones as history).

Editing a series is the same idea: cancel the affected future occurrences and re-expand, or
edit a single occurrence's group in place. Keep it simple — occurrence-level and
series-level operations, nothing finer.

---

## 10. Deployment (GCP Cloud Run)

Deploy exactly like the storefront — see [docs/DEPLOY_CLOUD_RUN.md](./DEPLOY_CLOUD_RUN.md)
for the full command set. Key points:

- Containerize with a standalone Next.js build (`output: 'standalone'`, a `Dockerfile`,
  `.dockerignore`) — copy these from the storefront repo.
- `gcloud run deploy $SERVICE --source . --region us-east1 --port 8080 --min-instances 0`.
  Keep Cloud Run in **`us-east1`** (Neon + Upstash live in AWS `us-east-1`; co-locate).
- **Auth model:** keep `--allow-unauthenticated` at the Cloud Run layer and let the **app**
  be the gate — Firebase verifies the user in middleware and the `app_users` lookup
  authorizes. (Firebase/Identity Platform runs in the same GCP project, so the Cloud Run
  runtime service account can use Application Default Credentials for the Admin SDK — no key
  file needed.) Do **not** rely on Cloud Run IAM `--no-allow-unauthenticated` for user
  login; that gates Google service accounts, not your social-login users.
- Secrets → **Secret Manager** via `--set-secrets`; plain config → `--set-env-vars`. Grant
  the runtime service account `roles/secretmanager.secretAccessor` on each secret (the
  storefront runbook shows the loop).
- Custom domain: map e.g. `admin.bachmancc.org` via `gcloud beta run domain-mappings create`
  and a GoDaddy CNAME. **Add that domain to Firebase Auth's Authorized Domains** and to each
  social provider's allowed redirect/callback list.
- `NEXT_PUBLIC_*` vars are inlined at **build time** — pass them as build env vars, not just
  runtime (see the storefront runbook's `NEXT_PUBLIC_PAYPAL_CLIENT_ID` note).

---

## 11. Environment variables

Validate at boot with Zod (mirror [lib/env.ts](../lib/env.ts) — the app should **fail to
start** if any required var is missing). Import `"server-only"` in any module that touches
the DB or secrets.

| Var | Required | Where | Notes |
|---|:--:|---|---|
| `DATABASE_URL` | ✅ | secret | Neon **pooled** endpoint, **`main` (prod) branch** — same DB as storefront |
| `DATABASE_URL_DEV` | ➖ | secret | Neon dev-branch direct endpoint for DDL/tooling only |
| `NODE_ENV` | ✅ | config | `production` on Cloud Run |
| `NEXT_PUBLIC_SITE_URL` | ✅ | config | admin app's own URL, e.g. `https://admin.bachmancc.org` |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | ✅ | **build** + config | Firebase Web SDK config (client) |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | ✅ | **build** + config | e.g. `bcc-rentals.firebaseapp.com` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | ✅ | **build** + config | Firebase/GCP project id |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | ✅ | **build** + config | Firebase Web app id |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | ➖ | **build** + config | only if used |
| `FIREBASE_PROJECT_ID` | ✅ | config | server Admin SDK project id (same project) |
| `GOOGLE_APPLICATION_CREDENTIALS` / SA JSON | ➖ | secret | Admin SDK creds **for local dev only**; on Cloud Run use the runtime SA's ADC (no key) |
| `ALLOWED_EMAIL_DOMAIN` | ➖ | config | optional extra guard on top of the `app_users` check |

Notes:
- The `NEXT_PUBLIC_FIREBASE_*` values are **not secrets** (they ship to the browser), but
  they are inlined at **build time** — pass them as build env vars *and* runtime config.
- The **Admin SDK** (server-side token/cookie verification) needs credentials. On Cloud Run
  in the same GCP project, use **Application Default Credentials** from the runtime service
  account — no JSON key. Only set `GOOGLE_APPLICATION_CREDENTIALS` for local development.
- Enable each social provider (Google, GitHub, Facebook, Apple) in the Firebase console and
  register each provider's OAuth app; add the admin app's domain to Firebase **Authorized
  Domains**.
- The admin app does **not** need PayPal, Resend, or Upstash Redis vars — it doesn't take
  payments, send customer emails, or use ephemeral order state.
- Keep a `.env.local.example` listing every var and document them in the README — same
  discipline as the storefront ([CLAUDE.md](../CLAUDE.md) "Env validation").

---

## 12. Build checklist

1. Scaffold Next.js + TypeScript; add `Dockerfile`, `.dockerignore`, `output:
   'standalone'` (copy from storefront).
2. Add `pg` pool + `withTransaction` helper (copy [lib/scheduler/db.ts](../lib/scheduler/db.ts)).
3. Add Zod env validation (shape of [lib/env.ts](../lib/env.ts)) with the vars in §11.
4. Create the admin app's `schema.sql` + apply script; apply §5 to the Neon **dev** branch.
5. Set up Firebase/Identity Platform: enable Google/GitHub/Facebook/Apple providers; wire
   the Web SDK sign-in and Admin SDK verification (§3). Implement UID→`app_users`→role
   lookup and deny unknown users. Bootstrap one admin (§5).
6. Build server-side role guards (`requireScheduler`, `requireAdmin`) used in **every**
   mutating route/action; add responsive nav + hamburger (§7).
7. Weekly calendar page with multi-day spanning + cross-week `<`/`>` indicators + `+` button (§7).
8. Add/Edit Reservation pages: multi-product line items + recurrence, all through the
   race-safe write (§8) and the grouped/recurring model (§9).
9. Edit Reservation delete modes: delete-instance vs delete-series (§9).
10. Products (Add w/ base price, Edit), Categories, Update Prices, User management (§6).
11. Write to `admin_audit_log` on every mutation.
12. Verify against the storefront: create a block/reservation in the admin app → confirm the
    storefront availability API reflects it within ~30s and won't double-book that window.
13. Deploy to Cloud Run (§10), map `admin.bachmancc.org`, add it to Firebase Authorized
    Domains, apply schema to **prod**, bootstrap the prod admin.

---

## References (storefront repo)
- Catalog schema: [lib/scheduler/db/schema.sql](../lib/scheduler/db/schema.sql)
- Race-safe reservation writes: [lib/scheduler/client.ts](../lib/scheduler/client.ts)
- Booking policy (lead/horizon/hours, Eastern time): [lib/scheduler/policy.ts](../lib/scheduler/policy.ts)
- DB pool / transaction helper: [lib/scheduler/db.ts](../lib/scheduler/db.ts)
- Schema apply script: [scripts/db/apply-schema.mjs](../scripts/db/apply-schema.mjs)
- Product types & pricing shapes: [lib/products/types.ts](../lib/products/types.ts), [lib/products/repository.ts](../lib/products/repository.ts)
- Seed / row-shape reference: [scripts/db/seed-products.mjs](../scripts/db/seed-products.mjs)
- Env validation pattern: [lib/env.ts](../lib/env.ts)
- Cloud Run deploy runbook: [docs/DEPLOY_CLOUD_RUN.md](./DEPLOY_CLOUD_RUN.md)
- Architecture context: [docs/ARCHITECTURE_PLAN_B.md](./ARCHITECTURE_PLAN_B.md), [CLAUDE.md](../CLAUDE.md)
