# BCC Rentals Frontend

A Next.js storefront for the Bachman Community Center that lets the public reserve rentals (tent, popcorn machine, party room) with online payment. The product catalog and reservations live in **Neon Postgres**, managed by the in-repo scheduler (`lib/scheduler`).

## Architecture at a glance

- **Next.js 16 App Router + TypeScript** — server actions and route handlers keep all secrets server-side.
- **PayPal Smart Buttons** are the sole payment method — PayPal, Venmo, and guest credit-card checkout (nonprofit rate).
- **Neon Postgres** is the durable system of record: the product catalog (`items` + `item_prices`) and `reservations`. The scheduler (`lib/scheduler`) books race-safely with a per-item advisory lock.
- **Upstash Redis** holds only ephemeral state — pending orders during payment (1h TTL), fulfill locks, and webhook dedup keys. Losing it never corrupts a business record.
- **Resend** sends both the customer confirmation and a staff notification (to `STAFF_NOTIFICATION_EMAIL`) on each booking.
- **Confirm-then-book**: reservations are never written until payment succeeds. If the rare race conflict happens, the customer is auto-refunded.
- An **ICS calendar feed** per item is served at `/api/calendar/[itemSlug]` for staff to subscribe to.

## Prerequisites — data setup

These must be done before the frontend can run end-to-end.

### 1. Provision Neon Postgres

Create a Neon project with a `main` (prod) and `dev` branch. Capture the pooled connection string as `DATABASE_URL` and the dev-branch direct endpoint as `DATABASE_URL_DEV`.

### 2. Apply the schema and seed products

```bash
npm run db:apply        # applies lib/scheduler/db/schema.sql to the dev branch
npm run db:apply:prod   # same against the main branch
npm run db:seed         # seeds tent / popcorn / party-room into the dev branch
npm run db:seed:prod    # same against the main branch
```

The catalog is DB-owned, so adding/editing products is data, not code (see "Adding a new rental product" below).

### 3. Verify the Resend sending domain

Confirm `bachmancc.org` (SPF/DKIM) in Resend so both the customer confirmation and the `STAFF_NOTIFICATION_EMAIL` staff notification deliver.

## Local development with VS Code Dev Containers

This project ships with a `.devcontainer/` setup. You don't need Node installed on your host.

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop) and the **Dev Containers** VS Code extension.
2. Open this folder in VS Code → command palette → **"Dev Containers: Reopen in Container"**.
3. The container builds, mounts the workspace, and runs `npm install` automatically. The Claude Code CLI and `gcloud` SDK are installed as part of the container.
4. Copy env vars: `cp .env.local.example .env.local` and fill in real values (see below).
5. Start the dev server: `npm run dev` → http://localhost:3000.

### Git authentication (SSH agent forwarding)

The repo uses an SSH remote (`git@github.com:...`), so git inside the container needs your GitHub SSH key. Rather than copying the private key into the container, we rely on **SSH agent forwarding**: your key stays in your host's ssh-agent, VS Code forwards the agent socket into the container, and it re-forwards on every rebuild. The private key never enters the container, and nothing host-specific is committed to the repo.

Set up the agent **once per host** (substitute your own key filename for `id_ed25519` below).

**Windows**

1. Enable the OpenSSH agent service — **elevated** PowerShell (*Run as Administrator*):
   ```powershell
   Get-Service ssh-agent | Set-Service -StartupType Automatic
   Start-Service ssh-agent
   ```
2. Load your key — **normal, non-elevated** PowerShell (elevated puts the key in the Administrator's agent, which VS Code won't forward):
   ```powershell
   ssh-add $env:USERPROFILE\.ssh\id_ed25519
   ssh-add -l   # should list your key's fingerprint
   ```

**macOS**

1. Add your key to the agent and macOS Keychain (agent runs by default):
   ```bash
   ssh-add --apple-use-keychain ~/.ssh/id_ed25519
   ```
2. Persist it across reboots by adding to `~/.ssh/config`:
   ```
   Host github.com
     AddKeysToAgent yes
     UseKeychain yes
     IdentityFile ~/.ssh/id_ed25519
   ```

Then **Dev Containers: Reopen in Container** so VS Code captures the agent. Verify inside the container:

```bash
ssh -T git@github.com   # → "Hi <username>! You've successfully authenticated"
```

The host agent persists your key across reboots, so this is a one-time setup — it works automatically after every container rebuild, and for any other Dev Container you open on the same host. (A plain `docker run` outside VS Code does not get the forwarded agent.)

### Claude Code + Vertex auth (one-time, per container rebuild)

The project's `.claude/settings.json` configures Claude Code to use Vertex AI (`CLAUDE_CODE_USE_VERTEX=1`, project `rice-tti-pocs`). Before `claude` works end-to-end, run inside the container:

```bash
gcloud auth application-default login
```

Follow the printed URL, sign in with a Google account that has access to the `rice-tti-pocs` Vertex project, and paste the verification code back. Application Default Credentials persist in the container's home volume, so you only need to repeat this after a container rebuild.

## Environment variables

Copy `.env.local.example` to `.env.local`. All vars are validated at boot via `lib/env.ts` — the app fails fast if anything is missing.

| Var | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Public site URL — used in payment redirects. |
| `PAYPAL_ENV` | `sandbox` or `live`. |
| `PAYPAL_CLIENT_ID` / `_CLIENT_SECRET` / `_WEBHOOK_ID` | PayPal server config. |
| `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | PayPal client SDK config. |
| `RESEND_API_KEY` | Resend API key. |
| `EMAIL_FROM` | From address (must be a verified Resend domain). |
| `STAFF_NOTIFICATION_EMAIL` | Recipient for new-reservation staff notifications (e.g. `reservations@bachmancc.org`). |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Upstash REST credentials. |
| `DATABASE_URL` | Neon Postgres runtime (pooled) connection — scheduler system of record. |
| `DATABASE_URL_DEV` | Neon dev-branch direct endpoint; used by `npm run db:apply` for DDL (tooling only). |

## Local end-to-end testing

1. **PayPal sandbox**: create sandbox business + buyer accounts in the PayPal developer dashboard, set `PAYPAL_ENV=sandbox`. Sandbox card payments use PayPal's guest card fields (no separate card processor). Expose `localhost:3000` with a **reserved** ngrok domain so the webhook URL survives restarts: sign up at https://ngrok.com → **Domains** → reserve a free `*.ngrok-free.dev` subdomain, then run
   ```bash
   ngrok http --url=<your-reserved>.ngrok-free.dev 3000
   # example: ngrok http --url=devoutly-edging-marigold.ngrok-free.dev 3000
   ```
   Register `https://<your-reserved>.ngrok-free.dev/api/webhooks/paypal` in your PayPal app's webhook settings and copy the resulting webhook ID into `PAYPAL_WEBHOOK_ID`.
2. **Database**: point `DATABASE_URL`/`DATABASE_URL_DEV` at your Neon branches and run the `db:apply` + `db:seed` scripts (see prerequisites). Bookings are written to the `reservations` table.

### Smoke checklist
- Picking a date shows availability that respects existing reservations (`/api/availability`).
- PayPal payment (PayPal / Venmo / guest card) → webhook fires → reservation row written to Neon → confirmation + staff emails arrive → success page renders.
- Two browsers attempting the same slot → second one gets a clean error and an automatic refund.
- `/api/calendar/[itemSlug]` returns a valid ICS feed of the item's booked windows.

## Useful scripts

```bash
npm run dev        # next dev
npm run build      # next build
npm run typecheck  # tsc --noEmit
npm run lint       # eslint .
npm run test       # vitest run
npm run test:watch
npm run db:apply / db:apply:prod   # apply schema.sql to the dev / main Neon branch
npm run db:seed  / db:seed:prod    # upsert seed products into the dev / main branch
```

## Deployment (GCP Cloud Run)

The app is containerized (`output: 'standalone'`) and deployed to Cloud Run — see Block 3 in [docs/EXECUTION_PLAN.md](docs/EXECUTION_PLAN.md) for the current cutover steps.

- Deploy the container to a Cloud Run service (min-instances 0) in a region near the Neon/Upstash `us-east-1` data (e.g. `us-east1`).
- Set every env var (above) as Cloud Run service config; keep secrets in Secret Manager.
- Custom domain: `rentals.bachmancc.org` via Cloud Run domain mapping.
- Register the production webhook URL in the PayPal dashboard against the Cloud Run HTTPS URL.

## Adding a new rental product

Products live in Postgres, so this is **data, not code** — no new pages, API routes, env vars, or deploys:

1. Insert an `items` row (+ one or more `item_prices` rows) into Neon. `scripts/db/seed-products.mjs` (`npm run db:seed`) is the reference for the row shape; it upserts by `slug`.
2. Drop a hero image into `public/images/` and set the row's `image` column to it.

`/rentals/[slug]`, the storefront listing, and the availability/checkout APIs all resolve products through `lib/products/repository.ts`, so a new active row appears automatically once the 30s catalog cache expires.

## Project layout

```
app/
  api/
    availability/                 GET availability for a product
    calendar/[itemSlug]/          GET ICS feed of an item's booked windows
    checkout/paypal/              POST create-order, POST capture-order
    webhooks/paypal/              PayPal webhook (signature verified)
  rentals/[slug]/                 Product detail + BookingWidget
  rentals/confirmation/[orderId]/ Success page
  page.tsx                        Landing
lib/
  env.ts                          Zod-validated env at boot
  redis.ts                        Upstash client (ephemeral state only)
  logger.ts                       pino logger
  scheduler/                      Neon-backed reservations (client, db, policy, types, errors)
  products/                       DB-backed catalog repository + pricing logic
  orders/                         pending order store + preflight + idempotent fulfill
  payments/                       paypal, refund helper
  email/                          Resend + confirmation template
components/ui/                    shadcn-style primitives
```

## Risk areas (already mitigated)

- **Webhook idempotency** — every event ID is recorded in Redis with `SET NX`; `fulfillOrder` is idempotent and exits early if the order is already confirmed.
- **Double-booking race** — confirm-then-book pattern + per-order fulfillment lock + a per-item `pg_advisory_xact_lock` with a capacity re-check inside the booking transaction + automatic refund on conflict.

## Open TODOs

- Confirm actual rental pricing per product.
- Confirm party room hours and slot length.
- Confirm min lead time and max advance window per product.
- Define fungible inventory (chairs, tables, plates, etc.) with `total_stock` quantities.
- Verify Resend sending domain (`bachmancc.org`).
- Final cancellation/refund policy text in the confirmation email.
