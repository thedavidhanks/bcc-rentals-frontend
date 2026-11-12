# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`README.md` is the canonical source for setup, env vars, and BCC admin prerequisites. This file only covers what isn't obvious from reading individual files.

## Working style: orchestrate, don't do it all yourself

Act as an **orchestrator**. Your job is to understand the request, plan the approach, delegate the substantial work to specialized subagents (via the Agent tool), and synthesize their results for the user. Prefer delegating over doing hands-on work yourself.

**Delegate** substantial work to the matching subagent:

- **Code changes** (features, bug fixes, refactors) → `github-workflow:code-writer`. It branches, implements, has `test-engineer` verify, and merges back only into a feature branch — work started from `main` is left on its verified branch for a pull request. Don't hand-edit source for non-trivial changes when this agent fits.
- **Tests** (writing, running, diagnosing failures) → `github-workflow:test-engineer`.
- **UI/UX, accessibility, responsive review** → `github-workflow:ui-ux-front-end-test-engineer`.
- **Broad code search / "where is X" across many files** → `Explore` (read-only fan-out).
- **Multi-step research or open-ended investigation** → `general-purpose`.
- **Implementation strategy / architectural planning** → `Plan`.
- **Quality audit of recently written code** → `github-workflow:code-improvement-advisor`.
- **Large tasks to fan out** → `github-workflow:work-distributor`.
- **Visual assets (SVG/icons/diagrams)** → `graphic-designer` (local to this repo).

**Issues, PRs, status, roadmap** → the `github-workflow` plugin skills: `/github-workflow:create-github-issue`, `/github-workflow:open-pull-request` (a hook blocks `gh pr create` until the roadmap has been checked), `/github-workflow:project-status`, `/github-workflow:next-issue`, `/github-workflow:update-roadmap`. They're shared with `bcc-rentals-admin` via the [github-workflows](https://github.com/thedavidhanks/github-workflows) marketplace; repo-specific settings live in [.claude/github-workflow.md](.claude/github-workflow.md). The plugin is enabled in `.claude/settings.json` and pre-installed by [.devcontainer/post-create.sh](.devcontainer/post-create.sh). Change shared agents and skills in that repo, not here.

Launch independent delegations **in parallel** (multiple Agent calls in one message). Subagents don't share your context, so give each a self-contained brief and the relevant `file_path:line` pointers.

**Handle yourself** (don't delegate): quick factual answers, reading a specific known file, trivial one-line edits, and the planning/coordination/synthesis that ties delegated work together. Relay what matters from subagent results — their output isn't shown to the user.

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

## Planning & tracking

GitHub is the source of truth for status, shared with the companion admin repo on [Project #4](https://github.com/users/thedavidhanks/projects/4). Each block is a **milestone** (`Block D — Demo state`), each step an **issue** titled with its step ID (`D3 — …`). [docs/roadmap.md](docs/roadmap.md) holds each block's intent only — never issue lists or counts; [docs/EXECUTION_PLAN.md](docs/EXECUTION_PLAN.md) holds architecture and the archive of pre-tracker work. Don't add task checklists to either doc — file an issue instead.

## Architecture

Next.js 16 App Router + TypeScript. Two data stores, split by durability (see [docs/ARCHITECTURE_PLAN_B.md](docs/ARCHITECTURE_PLAN_B.md), [docs/EXECUTION_PLAN.md](docs/EXECUTION_PLAN.md)):

- **Neon Postgres** — *durable* system of record: the product catalog (`items` + `item_prices`) and, once the migration below completes, `reservations`. Accessed via `pg` (`Pool` + `withTransaction` in [lib/scheduler/db.ts](lib/scheduler/db.ts)). Connection strings are `DATABASE_URL` (prod/`main` branch) and `DATABASE_URL_DEV` (`dev` branch).
- **Upstash Redis** — *ephemeral* state only ([lib/redis.ts](lib/redis.ts)): pending orders (1h TTL), fulfill locks, webhook dedup keys, and the LibreBooking session token. Every key is short-lived and self-expiring; losing it never corrupts a business record. It is **not** a system of record.

> **Migration status (Plan B).** LibreBooking has been **removed** — Neon is the system of record for reservations, and the order flow ([lib/orders/preflight.ts](lib/orders/preflight.ts), [lib/orders/fulfill.ts](lib/orders/fulfill.ts), [app/api/availability/route.ts](app/api/availability/route.ts)) books against `lib/scheduler`. **Stripe has also been removed** (Block D / D1): PayPal — at the nonprofit rate, covering PayPal/Venmo/guest credit-card — is the sole payment processor. No `lib/librebooking` or Stripe code remains.

### Deployment (Cloud Run)

Runbook: [docs/DEPLOY_CLOUD_RUN.md](docs/DEPLOY_CLOUD_RUN.md); history: [docs/EXECUTION_PLAN.md](docs/EXECUTION_PLAN.md) Block 3 archive; open work: the Block 3 / Block G milestones.

- **Live service (staging):** `https://bcc-rentals-78017895905.us-east1.run.app` — project `bcc-storefront-staging`, region `us-east1`, deployed from source (`Dockerfile`) via `gcloud run deploy --source .`.
- **Public access:** `allUsers` → `run.invoker` is blocked by the org policy `iam.allowedPolicyMemberDomains` (domain-restricted sharing). Worked around with `gcloud run services update bcc-rentals --region=us-east1 --no-invoker-iam-check` (per-service; no org-admin needed; reversible via `--invoker-iam-check`). Prefer this over trying to add an `allUsers` binding.
- **Env vars must be set per project.** Env vars don't carry over between projects/services — re-run [scripts/deploy/set-staging-env.sh](scripts/deploy/set-staging-env.sh) (secrets → Secret Manager, plain config → `--set-env-vars`, sourced from `.env.local`) against each new service or `lib/env.ts` Zod validation 500s at boot. Watch `PAYPAL_ENV`: it must be exactly `sandbox` or `live` (a stray char/CRLF from `.env.local` silently fails the enum).
- Custom domain (`rentals.bachmancc.org`) and Secret Manager are **deferred to Block G**, post-demo.

### Product catalog in Postgres ([lib/products/repository.ts](lib/products/repository.ts))

The catalog is DB-owned so BCC admins can add/edit products (and vary pricing by day/time) with **no redeploy** — this reversed an earlier "config file is source of truth" decision. `lib/products/config.ts` was deleted; it is now split into:

- [lib/products/types.ts](lib/products/types.ts) — client-safe `Product`/`PriceRule` types (no `server-only`).
- [lib/products/repository.ts](lib/products/repository.ts) — `server-only` async `getProduct(slug)` / `listProducts()` that map `items` + `item_prices` rows to `Product`, with a 30s per-instance cache. All catalog call sites `await` these.

Pricing rows (`item_prices`) are day/time-scoped and priority-ordered; `baseCents` picks the flat all-days/all-hours rule for the backward-compatible flat rate, and [quote()](lib/products/pricing.ts) resolves the effective rate.

### Scheduler ([lib/scheduler/client.ts](lib/scheduler/client.ts))

The Neon-backed reservation layer that replaces LibreBooking. `scheduler` exposes 4 methods: `getAvailability`, `createReservation`, `cancelReservation`, `getReservation` — keyed by `itemSlug` with the customer embedded on the reservation (no separate user record; PayPal payer is canonical).

- Supports **two inventory models** in one schema: `unique` items (`total_stock = 1`) and `fungible` items (capacity = `total_stock - SUM(quantity)` over the overlap window).
- `createReservation` is **race-safe**: inside `withTransaction` it takes a per-item `pg_advisory_xact_lock`, re-checks capacity, then inserts — so the availability check and insert cannot race. Capacity exhaustion throws `SchedulerConflictError` ([lib/scheduler/errors.ts](lib/scheduler/errors.ts)); fulfill will catch this the same way it catches `LibreBookingConflictError` today.
- An item's `bufferMinutes` widens the overlap window so bookings can't butt up against each other.
- [lib/scheduler/policy.ts](lib/scheduler/policy.ts) validates lead time / horizon / available hours / slot alignment against the DB-sourced `Product` (Eastern time, `America/New_York`); [lib/scheduler/types.ts](lib/scheduler/types.ts) holds the Zod input/output schemas.

### Confirm-then-book invariant

Reservations are NEVER written to the booking system until payment succeeds. The flow:

1. **Preflight** ([lib/orders/preflight.ts](lib/orders/preflight.ts)) — re-quotes price server-side, re-checks availability, creates a `pending` order in Redis (1h TTL). Called by the PayPal create-order endpoint.
2. **Payment** — PayPal Smart Buttons (PayPal / Venmo / guest credit-card).
3. **Fulfill** ([lib/orders/fulfill.ts](lib/orders/fulfill.ts)) — `scheduler.createReservation` → mark order `confirmed` → send Resend confirmation + staff notification emails. On a `SchedulerConflictError`, automatically refund and mark `refunded-conflict`.

The conflict guard is unchanged by the migration: the Redis fulfill lock plus a re-check inside the booking transaction. Postgres alone can't enforce no-overlap as a constraint, so this lock + read-then-write pattern is load-bearing.

Fulfill is **idempotent and concurrency-safe**: it can be called from both the webhook AND the synchronous capture endpoint. First caller wins via Redis `SET NX` lock (`acquireFulfillLock`); other callers either short-circuit on `status === "confirmed"` or no-op via `lost-race`. Always re-read the order *after* taking the lock — the prior caller may have flipped status between the initial read and the lock.

### Webhook idempotency

Every webhook event ID is recorded with `recordWebhookEvent` (Redis `SET NX`, 24h TTL) before processing. Duplicate deliveries from PayPal short-circuit. The PayPal webhook signature is verified with `PAYPAL_WEBHOOK_ID`.

### LibreBooking client ([lib/librebooking/client.ts](lib/librebooking/client.ts))

- All requests go through a single `call<T>()` helper that injects `X-Booked-SessionToken` / `X-Booked-UserId` headers and runs the response through a Zod schema.
- Session token is cached in Redis (20-min TTL) with an in-process memo and an in-flight promise to coalesce concurrent auth requests across requests in the same Node instance ([lib/librebooking/session.ts](lib/librebooking/session.ts)). A 401 invalidates the session and retries **once**.
- Conflicts surface as `LibreBookingConflictError` — fulfill catches this specifically and triggers refund. Other failures bubble.
- `createReservation` returns success-shaped JSON even on validation errors; the client inspects `result.errors` for `/conflict/i` and re-throws as `LibreBookingConflictError`.

### Env validation

[lib/env.ts](lib/env.ts) parses `process.env` through Zod at module load. The app **fails to boot** if any required var is missing or malformed. When adding a new env var, add it to: `.env.local.example`, the Zod schema in `lib/env.ts`, and the env-var table in `README.md`.

### Adding a rental product

Products live in Postgres, so adding one is **data, not code** — no new pages, API routes, env vars, or deploys:

1. Insert an `items` row (+ one or more `item_prices` rows) into Neon. The idempotent seed script [scripts/db/seed-products.mjs](scripts/db/seed-products.mjs) (`npm run db:seed` / `db:seed:prod`) is the reference for the row shape; upsert by `slug`.
2. Add a hero image under `public/images/` and set the row's `image` column to it.

`/rentals/[slug]`, the storefront listing, and the availability/checkout APIs all resolve products through [lib/products/repository.ts](lib/products/repository.ts) (`getProduct` / `listProducts`), so a new active row appears automatically once the 30s catalog cache expires. (Until Block 2 lands, an item that should be bookable through the current LibreBooking path also needs its `resource_id` column set.)

### Server-only boundary

Files that touch secrets, Redis, Neon/Postgres (`lib/scheduler/*`, `lib/products/repository.ts`), PayPal, or Resend import `"server-only"` at the top — this throws at build time if accidentally pulled into a client component. Preserve this when adding new server modules. The only client-exposed env vars are the `NEXT_PUBLIC_*` ones.
