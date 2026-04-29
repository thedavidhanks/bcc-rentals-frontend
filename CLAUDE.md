# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`README.md` is the canonical source for setup, env vars, and BCC admin prerequisites. This file only covers what isn't obvious from reading individual files.

## Commands

```bash
npm run dev        # next dev (http://localhost:3000)
npm run build      # next build
npm run typecheck  # tsc --noEmit
npm run lint       # next lint
npm run test       # vitest run
npm run test:watch # vitest in watch mode
```

Run a single Vitest file: `npx vitest run lib/products/pricing.test.ts`. Tests use jsdom + `@testing-library/react`; setup lives in [vitest.setup.ts](vitest.setup.ts).

The `@/*` path alias maps to the repo root (configured in both [tsconfig.json](tsconfig.json) and [vitest.config.ts](vitest.config.ts)).

## Architecture

Next.js 16 App Router + TypeScript. **There is no SQL database** — Upstash Redis holds all server state (LibreBooking session token, pending orders, fulfill locks, webhook dedup keys). LibreBooking is the system of record for reservations.

### Confirm-then-book invariant

Reservations are NEVER written to LibreBooking until payment succeeds. The flow:

1. **Preflight** ([lib/orders/preflight.ts](lib/orders/preflight.ts)) — re-quotes price server-side, re-checks LibreBooking availability, creates a `pending` order in Redis (1h TTL). Called by both Stripe checkout creation and PayPal create-order.
2. **Payment** — Stripe Checkout or PayPal Smart Buttons.
3. **Fulfill** ([lib/orders/fulfill.ts](lib/orders/fulfill.ts)) — `findOrCreateUser` → `createReservation` in LibreBooking → mark order `confirmed` → send Resend confirmation email. On `LibreBookingConflictError`, automatically refund and mark `refunded-conflict`.

Fulfill is **idempotent and concurrency-safe**: it can be called from both the webhook AND the synchronous capture endpoint. First caller wins via Redis `SET NX` lock (`acquireFulfillLock`); other callers either short-circuit on `status === "confirmed"` or no-op via `lost-race`. Always re-read the order *after* taking the lock — the prior caller may have flipped status between the initial read and the lock.

### Webhook idempotency

Every webhook event ID is recorded with `recordWebhookEvent` (Redis `SET NX`, 24h TTL) before processing. Duplicate deliveries from Stripe/PayPal short-circuit. Stripe webhook signature is verified with `STRIPE_WEBHOOK_SECRET`; PayPal with `PAYPAL_WEBHOOK_ID`.

### LibreBooking client ([lib/librebooking/client.ts](lib/librebooking/client.ts))

- All requests go through a single `call<T>()` helper that injects `X-Booked-SessionToken` / `X-Booked-UserId` headers and runs the response through a Zod schema.
- Session token is cached in Redis (20-min TTL) with an in-process memo and an in-flight promise to coalesce concurrent auth requests across requests in the same Node instance ([lib/librebooking/session.ts](lib/librebooking/session.ts)). A 401 invalidates the session and retries **once**.
- Conflicts surface as `LibreBookingConflictError` — fulfill catches this specifically and triggers refund. Other failures bubble.
- `createReservation` returns success-shaped JSON even on validation errors; the client inspects `result.errors` for `/conflict/i` and re-throws as `LibreBookingConflictError`.

### Env validation

[lib/env.ts](lib/env.ts) parses `process.env` through Zod at module load. The app **fails to boot** if any required var is missing or malformed. When adding a new env var, add it to: `.env.local.example`, the Zod schema in `lib/env.ts`, and the env-var table in `README.md`.

### Adding a rental product

The flow is intentionally additive — no new pages, no new API routes:

1. Add `LB_RESOURCE_ID_<NAME>` to `.env.local.example` and the Zod schema in `lib/env.ts`.
2. Append an entry to `PRODUCTS` in [lib/products/config.ts](lib/products/config.ts) (extend `ProductSlug` union too).
3. Add a hero image under `public/images/`.

`/rentals/[slug]` and the availability/checkout APIs all key off the `PRODUCTS` map.

### Server-only boundary

Files that touch secrets, Redis, LibreBooking, Stripe, PayPal, or Resend import `"server-only"` at the top — this throws at build time if accidentally pulled into a client component. Preserve this when adding new server modules. The only client-exposed env vars are the `NEXT_PUBLIC_*` ones.
