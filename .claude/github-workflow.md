# GitHub workflow config

<!--
Read by the github-workflow plugin (thedavidhanks/github-workflows).
Values here override CLAUDE.md and auto-detection. Names and locations
of secrets only — never values.
-->

## Repository

- **Base branch:** main
- **Companion repos:** thedavidhanks/bcc-rentals-admin — the staff admin app. It writes to the same Neon database (`items`, `item_prices`, `categories`, `reservations`). File an issue there when the change is to staff screens, roles or Firebase auth; file here for the public storefront, checkout, PayPal, emails and the ICS feed. If a change spans both (for example the shared schema or the race-safe write pattern), file it in the repo that must change and cross-link.
- **Default assignee:** thedavidhanks
- **Audience:** renters (members of the public booking BCC equipment and spaces) and Bachman Community Center staff who receive booking notifications

## Planning

- **Board:** user:thedavidhanks / 4
- **Phase source:** milestone
- **Phase ID in titles:** the step ID from the block, then ` — `: `N3.5 — `, `D3 — `, `N4.1 — `, `G1 — `. Milestones are named `Block <id> — <title>` (`Block D — Demo state`).
- **Board fields:** Status (Backlog, Ready, In progress, In review, Blocked, Done), Priority (High, Medium, Low), Size (XS–XL), Owner (code-writer, test-engineer, graphic-designer, human)
- **Roadmap:** docs/roadmap.md
- **Spec:** docs/ARCHITECTURE_PLAN_B.md (architecture and rationale); docs/EXECUTION_PLAN.md holds architecture plus the archive of pre-tracker work
- **Critical path:** Block D (demo gate: N3.5, D3, D4) outranks everything, then Block G (go-live). Block 4 items are decisions BCC must make, so they're for the developer to chase rather than for an agent.

## Checks

```bash
npm run lint
npm run typecheck
npm run test
```

- **Caveats:** `npm run build` needs real env vars or `SKIP_ENV_VALIDATION=1` (`lib/env.ts` validates at module load). Vitest runs jsdom and does collect `.tsx` tests, but nothing exercises PayPal, Resend, Redis or Neon for real: all of those are mocked, so payment, email and booking-race changes also need a manual check (sandbox or the Neon dev branch).

## Sensitive data

- **Secrets (by name and location, never value):** `.env.local` (`DATABASE_URL`, `DATABASE_URL_DEV`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `RESEND_API_KEY`, `UPSTASH_REDIS_REST_TOKEN`); Secret Manager in `bcc-storefront-staging`. Local `DATABASE_URL` points at Neon **prod** `main`.
- **Customer / staff data:** `reservations` (renter name, email, phone, notes); Redis pending orders (`order:*`, same fields plus PayPal order IDs); `STAFF_NOTIFICATION_EMAIL`
- **Synthetic example row:** `Jane Example | jane@example.com | 555-0100`
- **Unpatched-vulnerability examples for this app:** a way to confirm a reservation without a captured PayPal payment; a webhook accepted without signature verification; a public endpoint (`/api/availability`, `/api/calendar/*`) leaking renter PII; a refund triggerable by an unauthenticated caller

## Human-only changes

| Path / action | What a human must do |
|---|---|
| `lib/scheduler/db/schema.sql` | run `npm run db:apply` (dev branch first), then `npm run db:apply:prod` |
| `scripts/db/*` seed data | run `npm run db:seed` / `db:seed:prod` |
| `Dockerfile`, `next.config.ts`, `scripts/deploy/*`, new or changed env vars | redeploy Cloud Run; re-run `scripts/deploy/set-staging-env.sh` for new vars |
| PayPal webhook, Resend domain, DNS, Cloud Run settings | change in the provider console |
| new dependency in `package.json` | approve before it is added |

## Deploy targets

| Environment | Read-only command that shows what is running | Commit stamp |
|---|---|---|
| Staging | `gcloud run services describe bcc-rentals --project bcc-storefront-staging --region us-east1 --format 'value(status.url,status.latestReadyRevisionName)'` | none yet (deploy with `--labels commit-sha=$(git rev-parse --short HEAD)`) |
| Production | none yet; `rentals.bachmancc.org` is not mapped (Block G) | — |

- **Access:** staging is public via `--no-invoker-iam-check` (the org policy blocks an `allUsers` binding). It talks to PayPal **sandbox** but writes the **prod** Neon database, so bookings made there are real.

## Labels

- **ops**: needs a change to live infrastructure (GCP, DNS, Secret Manager, PayPal/Resend console, deploy); used alongside a kind label
- **verification**: a manual check of a live system that changes nothing

## Agent-prompt constraints

Carry the relevant CLAUDE.md rules, especially:

- Confirm-then-book: never write a reservation before payment is captured.
- Fulfill stays idempotent: Redis `SET NX` lock, re-read the order after taking it.
- `createReservation` keeps advisory lock → capacity re-check → insert in one transaction; the admin app is a second writer.
- `import "server-only"` in anything touching secrets, Redis, Neon, PayPal or Resend; new env vars go in `.env.local.example`, `lib/env.ts` and the README table.
- No DDL, no deploys and no merges by an agent (`git merge` and `gh pr merge` are denied).
