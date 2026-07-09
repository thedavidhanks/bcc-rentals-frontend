# BCC Rentals Frontend

A Next.js storefront for the Bachman Community Center that lets the public reserve rentals (tent, popcorn machine, party room) with online payment. Reservations are written to BCC's existing **LibreBooking** instance via its REST API.

## Architecture at a glance

- **Next.js 16 App Router + TypeScript** — server actions and route handlers keep all secrets server-side.
- **Stripe Checkout** for cards and **PayPal Smart Buttons** for PayPal/Venmo.
- **LibreBooking** is the system of record for reservations. We call it from a service account.
- **Upstash Redis** caches the LibreBooking session token, holds pending orders during payment, and dedupes webhook deliveries. No SQL database.
- **Resend** sends customer confirmations. Staff notifications are handled by LibreBooking's built-in "Notify on Reservation Created".
- **Confirm-then-book**: we never write to LibreBooking until payment succeeds. If the rare race conflict happens, the customer is auto-refunded.

## Prerequisites — BCC admin tasks

These must be done before the frontend can run end-to-end.

### 1. Enable the LibreBooking REST API

Today, hitting `http://bccreservations.thedavidhanks.com/Web/Services/index.php` returns a notice that the API is disabled.

On the LibreBooking server, edit `config/config.php`:

```php
$conf['settings']['api']['enabled'] = 'true';
```

If you're running LibreBooking via Docker, ensure `config/config.php` is bind-mounted (or set the equivalent env var in your `docker-compose.yml`), then restart the container.

Verify with:

```bash
curl -X POST http://bccreservations.thedavidhanks.com/Web/Services/index.php/Authentication/Authenticate \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"..."}'
```

You should get back JSON containing `sessionToken` and `userId`.

### 2. Create the service account

In LibreBooking admin: **Application Management → Users → Add User**.
- Username: `rentals-api` (used for `LIBREBOOKING_SERVICE_USER`).
- Strong random password → `LIBREBOOKING_SERVICE_PASS`.
- Group with permissions to: read all resources, read availability, **create reservations**, **create users**.

### 3. Configure resource notifications

For each rentable resource (tent, popcorn, party room, and future items): **Resources → [resource] → Notifications → Notify on Created** → add `reservations@bachmancc.org`.

Capture each resource's numeric ID (visible in the URL or resource list) — these become the `LB_RESOURCE_ID_*` env vars.

### 4. (Strongly recommended) Put LibreBooking behind HTTPS

The LibreBooking instance is currently HTTP. Service-account credentials would traverse the wire in cleartext. Use Cloudflare Tunnel, Caddy reverse proxy, or any other TLS terminator before going live.

## Local development with VS Code Dev Containers

This project ships with a `.devcontainer/` setup. You don't need Node installed on your host.

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop) and the **Dev Containers** VS Code extension.
2. Open this folder in VS Code → command palette → **"Dev Containers: Reopen in Container"**.
3. The container builds, mounts the workspace, and runs `npm install` automatically. The Claude Code CLI and `gcloud` SDK are installed as part of the container.
4. Copy env vars: `cp .env.local.example .env.local` and fill in real values (see below).
5. Start the dev server: `npm run dev` → http://localhost:3000.

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
| `LIBREBOOKING_BASE_URL` | LibreBooking origin (no trailing `/Web`). |
| `LIBREBOOKING_SERVICE_USER` / `_PASS` | Service-account credentials. |
| `LB_RESOURCE_ID_TENT` / `_POPCORN` / `_PARTY_ROOM` | Numeric resource IDs. |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe server keys. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe client key. |
| `PAYPAL_ENV` | `sandbox` or `live`. |
| `PAYPAL_CLIENT_ID` / `_CLIENT_SECRET` / `_WEBHOOK_ID` | PayPal server config. |
| `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | PayPal client SDK config. |
| `RESEND_API_KEY` | Resend API key. |
| `EMAIL_FROM` | From address (must be a verified Resend domain). |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Upstash REST credentials. |
| `DATABASE_URL` | Neon Postgres runtime (pooled) connection — scheduler system of record. |
| `DATABASE_URL_DEV` | Neon dev-branch direct endpoint; used by `npm run db:apply` for DDL (tooling only). |

## Local end-to-end testing

1. **Stripe webhooks**: in another terminal,
   ```bash
   stripe listen --forward-to localhost:3000/api/webhooks/stripe
   ```
   Copy the printed `whsec_...` into `STRIPE_WEBHOOK_SECRET`. Use card `4242 4242 4242 4242`.
2. **PayPal sandbox**: create sandbox business + buyer accounts in the PayPal developer dashboard, set `PAYPAL_ENV=sandbox`. Expose `localhost:3000` with a **reserved** ngrok domain so the webhook URL survives restarts: sign up at https://ngrok.com → **Domains** → reserve a free `*.ngrok-free.dev` subdomain, then run
   ```bash
   ngrok http --url=<your-reserved>.ngrok-free.dev 3000
   # example: ngrok http --url=devoutly-edging-marigold.ngrok-free.dev 3000
   ```
   Register `https://<your-reserved>.ngrok-free.dev/api/webhooks/paypal` in your PayPal app's webhook settings and copy the resulting webhook ID into `PAYPAL_WEBHOOK_ID`.
3. **LibreBooking test**: have BCC create a "Test Resource" and point the `LB_RESOURCE_ID_*` envs at its ID. Verify the booking appears in LibreBooking after a successful payment.

### Smoke checklist
- Picking a date shows availability that respects existing LibreBooking events.
- Stripe payment → webhook fires → reservation appears in LibreBooking → confirmation email arrives → success page renders.
- PayPal sandbox path equivalent.
- Two browsers attempting the same slot → second one gets a clean error and an automatic refund.

## Useful scripts

```bash
npm run dev        # next dev
npm run build      # next build
npm run typecheck  # tsc --noEmit
npm run lint       # next lint
npm run test       # vitest run
npm run test:watch
```

## Deployment (Vercel)

- Import the repo into Vercel.
- Set every env var (above) for **Production** and **Preview** (use sandbox keys + a LibreBooking test resource for Preview).
- Custom domain: `rentals.bachmancc.org`.
- Production webhook URLs must be registered in Stripe + PayPal dashboards; rotate signing secrets into Vercel.

## Adding a new rental product

This is intentionally a small, additive change:

1. Add a numeric `LB_RESOURCE_ID_<NAME>` env var (in `.env.local`, Vercel, and Zod schema in `lib/env.ts`).
2. Append an entry to `PRODUCTS` in `lib/products/config.ts`.
3. Drop a hero image into `public/images/`.

No new pages, no new API routes — `/rentals/[slug]` handles all products.

## Project layout

```
app/
  api/
    availability/                 GET availability for a product
    checkout/stripe/              POST → Stripe Checkout Session
    checkout/paypal/              POST create-order, POST capture-order
    webhooks/stripe/              Stripe webhook (signature verified)
    webhooks/paypal/              PayPal webhook (signature verified)
  rentals/[slug]/                 Product detail + BookingWidget
  rentals/confirmation/[orderId]/ Success page
  page.tsx                        Landing
lib/
  env.ts                          Zod-validated env at boot
  redis.ts                        Upstash client
  logger.ts                       pino logger
  librebooking/                   typed API wrapper, session cache
  products/                       product config + pricing logic
  orders/                         pending order store + idempotent fulfill
  payments/                       stripe, paypal, refund helper
  email/                          Resend + confirmation template
components/ui/                    shadcn-style primitives
```

## Risk areas (already mitigated)

- **Webhook idempotency** — every event ID is recorded in Redis with `SET NX`; `fulfillOrder` is idempotent and exits early if the order is already confirmed.
- **Double-booking race** — confirm-then-book pattern + per-order fulfillment lock + final availability re-check inside the lock + automatic refund on conflict.
- **LibreBooking session expiry / outage** — token cached in Redis with mutex'd refresh; 401 triggers one re-auth retry; failures after payment surface a "we'll email you" page and remain visible to BCC staff via LibreBooking's notification.

## Open TODOs

- Confirm actual rental pricing per product.
- Confirm party room hours and slot length.
- Confirm min lead time and max advance window per product.
- Verify rental resource IDs in LibreBooking.
- Verify Resend sending domain (`bachmancc.org`).
- Final cancellation/refund policy text in the confirmation email.
