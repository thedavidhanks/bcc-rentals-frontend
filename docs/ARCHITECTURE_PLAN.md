# BCC Rentals — Architecture Plan

End goal: a production environment that is **hosted securely on AWS** (consolidated under a single AWS account for operational simplicity), with LibreBooking behind HTTPS, the Next.js storefront on Amplify Hosting, and all secrets validated at boot. Hard ceiling: **$30/mo total subscription-style platform spend** (excluding per-transaction Stripe/PayPal fees).

## System components

| # | Component | Role | Hosting | Owner | Monthly cost (est.) |
| - | --- | --- | --- | --- | --- |
| 1 | **Storefront (this repo)** — Next.js App Router, server actions + route handlers | Public UI, checkout, webhook receivers | **AWS Amplify Hosting** (BCC AWS account) | Dev team | $0 first 12 months (Amplify free tier on a new AWS account), ~$1–3/mo after |
| 2 | **LibreBooking** — PHP/MySQL booking system | System of record for reservations, resources, users | **AWS Lightsail** — 2 GB Linux instance, Docker (LibreBooking + co-located MySQL), Ubuntu 22.04 | Dev team (BCC AWS account) | $10 |
| 3 | **HTTPS + backup for LibreBooking** | TLS termination via Caddy + Let's Encrypt; daily snapshots for DR | **Caddy on the Lightsail instance** + **Lightsail Automatic Snapshots** (7-day retention) | Dev team | $0 + ~$1–2 |
| 4 | **Upstash Redis** | Session-token cache, pending orders (1h TTL), fulfill locks, webhook dedup keys. No SQL DB exists. | Upstash serverless (REST) | Dev team | $0 free tier (sufficient for BCC volume) |
| 5 | **Stripe** | Card payments via Stripe Checkout; webhook → `/api/webhooks/stripe` | Stripe-hosted | Dev team | 2.9% + $0.30 per transaction |
| 6 | **PayPal** | PayPal + Venmo via Smart Buttons; webhook → `/api/webhooks/paypal` | PayPal-hosted | Dev team | ~3.49% + $0.49 per transaction |
| 7 | **Resend** | Customer confirmation emails from a verified `bachmancc.org` sender. Staff notifications handled by LibreBooking's built-in "Notify on Created" | Resend-hosted | Dev team | $0 free tier (3K emails/mo) |
| 8 | **DNS / domain** | `rentals.bachmancc.org` → Amplify; `bccreservations.bachmancc.org` → Lightsail static IP | **GoDaddy** (existing registrar for `bachmancc.org`) | BCC admin | Already paid |
| 9 | **Observability** | Lightsail metrics + CloudWatch alarms; Amplify built-in build/access logs; pino logs in [lib/logger.ts](../lib/logger.ts) | AWS | Dev team | $0 (within CloudWatch free tier for a handful of alarms) |

**Estimated steady-state monthly platform spend: ~$12–15/mo** (Lightsail + Amplify dominate; all other components on free tiers). Per-transaction Stripe/PayPal fees are on top and scale with rental revenue. Well under the $30/mo cap, leaving headroom to upgrade later (e.g., to a 4 GB Lightsail at $20, or add Lightsail Managed Database at $15) if reliability needs grow.

## AWS hybrid hosting

Both compute components live in a single BCC AWS account. The total AWS bill itemizes as:

| Line | Service | Sizing | Monthly |
| --- | --- | --- | --- |
| LibreBooking compute | Lightsail Linux instance | 2 GB RAM / 1 vCPU / 60 GB SSD / 3 TB transfer | $10 |
| LibreBooking HTTPS | Caddy + Let's Encrypt on the same instance | n/a | $0 |
| LibreBooking backup | Lightsail Automatic Snapshots (daily, 7-day retention) | ~10–20 GB snapshot footprint | ~$1–2 |
| LibreBooking static IP | Lightsail Static IP attached to the instance | n/a | $0 (free while attached) |
| Storefront | Amplify Hosting (SSR) for Next.js | Build minutes + SSR compute + transfer | $0 first 12 months (free tier on a new AWS account), ~$1–3/mo after |
| Monitoring | CloudWatch alarms (instance status check + sustained high CPU) | 2–3 alarms within free tier | $0 |
| **Total AWS** | | | **~$12–15** |

### Why these choices

- **Lightsail 2 GB beats 1 GB ($5)** — co-locating MySQL on 1 GB is tight. **Beats Lightsail Managed Database ($15)** — community-center reservation volume doesn't justify $15/mo managed DB when daily snapshots cover DR.
- **Caddy beats Lightsail Load Balancer ($18/mo)** — the load balancer alone would blow most of the budget. Caddy auto-issues and renews Let's Encrypt certs with one config line.
- **Lightsail Automatic Snapshots beat AWS Backup** — built-in scheduler, one toggle, no separate service to manage.
- **GoDaddy DNS beats Route 53 ($0.50/mo per zone)** — only two subdomains need to repoint; no functional gain from migrating the whole zone.
- **Amplify Hosting beats Vercel Hobby (ToS exposure) and Vercel Pro ($20, blows budget)** — see "Storefront hosting tradeoff" below.

## Storefront hosting tradeoff

Amplify Hosting was chosen for the Next.js storefront over Vercel for three reasons:

1. **Single AWS bill** — matches the stated priority (simplicity > cost > reliability).
2. **No Vercel ToS exposure** — Vercel Hobby is "personal, non-commercial use only"; taking rental payments is arguably commercial. Amplify has no equivalent restriction.
3. **Fits the $30/mo cap** — Vercel Pro at $20/mo plus $10–12/mo Lightsail exceeds the budget.

### Hard prerequisite: pin Next.js to 15

Per [AWS Amplify SSR documentation](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html), Amplify Hosting supports Next.js versions **12 through 15**. This repo currently runs Next.js 16 (per [CLAUDE.md](../CLAUDE.md)). Before the Amplify cutover, the storefront must be downgraded to Next.js 15 — covered in Block 2 below.

### Amplify feature gaps to audit before cutover

These Next.js features are **not** supported on Amplify Hosting and must be checked for in the codebase before migrating:

- Edge runtime API routes / Edge middleware
- On-demand ISR (`revalidatePath` / `revalidateTag` from route handlers)
- Next.js streaming responses
- Running middleware on static assets or optimized images
- `unstable_after` (Next.js 15 experimental)

The current storefront uses server actions + standard REST route handlers for checkout and webhooks — nothing in the unsupported list is obviously load-bearing, but a `grep` audit is part of Block 2.

### Revisit triggers

Reconsider the storefront hosting choice if:

- Amplify adds Next.js 16 support and a re-upgrade unlocks a feature we need.
- Vercel introduces a non-profit / low-traffic tier that clears the ToS question.
- BCC volume grows enough that Amplify SSR compute exceeds the free tier meaningfully (e.g., >500K SSR requests/mo).

## AWS services considered but deferred

| Service | Why deferred | Revisit when |
| --- | --- | --- |
| **SES** (email) | Resend free tier (3K/mo) easily covers BCC volume; SES requires domain verification + sandbox-exit request, friction without near-term savings | Resend free tier exhausted or pricing changes |
| **ElastiCache for Redis** | ~$11/mo (cache.t4g.micro) vs. Upstash free tier handles BCC's command volume; ElastiCache requires VPC plumbing | Upstash free tier exhausted or VPC-private Redis becomes a requirement |
| **Route 53** (DNS) | $0.50/mo per zone for no functional gain over GoDaddy CNAMEs when only two subdomains need to repoint | BCC consolidates the full `bachmancc.org` zone at AWS for unrelated reasons |
| **Lightsail Managed Database** | $15/mo roughly doubles the Lightsail bill; snapshots + co-located MySQL is sufficient at this scale | Reservation volume grows substantially or zero-touch DB patching becomes a requirement |
| **App Runner** (Next.js) | ~$25+/mo for always-on small container; over budget when added to Lightsail | Never, at this budget |

## Data & trust boundaries

```
                          rentals.bachmancc.org
                                    |
                                    v
                       +---------------------------+
                       |   AWS Amplify Hosting     |
                       |   Next.js (pinned to 15)  |
                       +---------------------------+
       server-only modules /        |        \ server-only modules
                          /         |         \
                  Upstash Redis     |        Stripe / PayPal / Resend
                  (sess, orders,    |        (HTTPS APIs)
                   locks, dedup)    |
                                    v
                       HTTPS (Caddy + Let's Encrypt)
                                    |
                                    v
            +-------------------------------------------+
            |   AWS Lightsail (2 GB instance)           |
            |   Docker: LibreBooking + MySQL            |
            |   Caddy TLS + Lightsail Auto Snapshots    |
            +-------------------------------------------+
```

- Every server module that touches secrets imports `"server-only"` — accidental client import fails the build.
- Env vars are Zod-validated at boot in [lib/env.ts](../lib/env.ts); the app refuses to start with missing/malformed config.
- Only `NEXT_PUBLIC_*` vars (site URL, Stripe publishable key, PayPal client ID) cross to the browser.
- Webhooks verify signatures (`STRIPE_WEBHOOK_SECRET`, `PAYPAL_WEBHOOK_ID`) before any side effect.
- Confirm-then-book invariant: LibreBooking is only written after payment succeeds; conflicts trigger automatic refund.

## Production environments

| Environment | Purpose | LibreBooking target | Stripe / PayPal | Notes |
| --- | --- | --- | --- | --- |
| Local dev | Developer laptops in devcontainer | Test resource on Lightsail LibreBooking | Stripe test keys + `stripe listen`; PayPal sandbox via reserved ngrok domain | See README "Local end-to-end testing" |
| Amplify Preview | Per-PR previews | Same Lightsail box, test resource | Sandbox / test keys | Auto-deployed by Amplify on PR; one Lightsail instance serves both Preview and Production |
| Amplify Production | `rentals.bachmancc.org` | Real resource IDs on Lightsail | Live keys | Webhooks registered in Stripe + PayPal dashboards against the Amplify HTTPS URL |

## Next steps

Ordered by dependency. Blocks 1 and 2 must complete before production cutover.

### Block 1 — Migrate LibreBooking to Lightsail (BCC admin + dev)

1. **Enable the REST API** on LibreBooking (`config/config.php` → `api.enabled = true`); confirm `POST /Web/Services/index.php/Authentication/Authenticate` returns `sessionToken` + `userId` against the *current* host before migrating.
2. **Create the `rentals-api` service account** with permissions to read all resources/availability and create reservations + users. Capture the password into `LIBREBOOKING_SERVICE_PASS`.
3. **Provision Lightsail 2 GB instance** in the nearest region; attach a Lightsail Static IP (free while attached).
4. **Install Docker + LibreBooking** on the instance; deploy LibreBooking + MySQL as sibling containers on a shared Docker network. Restore data via `mysqldump` from the current host.
5. **Install Caddy** with `bccreservations.bachmancc.org { reverse_proxy localhost:80 }`; verify Let's Encrypt cert issuance and HTTPS reachability.
6. **Cut DNS** at GoDaddy: lower the TTL on `bccreservations.bachmancc.org` ahead of time, then CNAME (or A record) it to the Lightsail static IP.
7. **Enable Lightsail Automatic Snapshots** — daily, 7-day retention.
8. **Add CloudWatch alarms** for instance status check failure and sustained CPU > 80%.
9. **Configure resource notifications** in LibreBooking: for tent, popcorn, party room, add `reservations@bachmancc.org` to "Notify on Created". Record each numeric resource ID for the `LB_RESOURCE_ID_*` env vars.
10. **Update `LIBREBOOKING_BASE_URL`** in Amplify Production env to the new HTTPS URL; redeploy.
11. **Re-verify** the service account + `LB_RESOURCE_ID_*` against the migrated DB end-to-end.

### Block 2 — Migrate the storefront to Amplify Hosting (dev)

The Next.js 15 downgrade is gating — do it first.

1. **Downgrade Next.js from 16 → 15** in `package.json`; run `npm install`, `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` and resolve any 16-only API usage.
2. **Audit the codebase for Amplify-unsupported features**: `grep` for `revalidatePath`, `revalidateTag`, `unstable_after`, `runtime = "edge"`, streaming responses. Refactor any usage off these patterns.
3. **Create the Amplify app** from the GitHub repo; Amplify auto-detects Next.js SSR.
4. **Port all env vars** (from `.env.local.example` / Zod schema in [lib/env.ts](../lib/env.ts)) into Amplify Production and Preview environments. Use the Amplify env store; never commit `.env.local`.
5. **Add the `rentals.bachmancc.org` custom domain** in Amplify; cut the GoDaddy CNAME (low TTL first).
6. **Register production webhook URLs** in Stripe + PayPal dashboards against the Amplify HTTPS URL; rotate signing secrets into Amplify env.

### Block 3 — Product & policy decisions (open TODOs from README)

7. Confirm final rental pricing per product.
8. Confirm party-room hours and slot length.
9. Confirm min lead time and max advance booking window per product.
10. Verify rental resource IDs in LibreBooking match what's wired in env.
11. Verify Resend sending domain `bachmancc.org` (SPF/DKIM records).
12. Finalize cancellation/refund policy text in the confirmation email.

### Block 4 — Production smoke test

13. Walk the README "Smoke checklist" against production:
    - Availability respects existing LibreBooking events.
    - Stripe → webhook → reservation written → email arrives → success page renders.
    - PayPal sandbox/live equivalent.
    - Two concurrent browsers on the same slot → second sees a clean error and an auto-refund.
14. Swap test resource IDs out for real resource IDs in Amplify Production env, redeploy, repeat one live booking per product.

### Block 5 — Operations (post-launch)

15. Decide on uptime monitoring beyond the CloudWatch alarms (e.g., external pinger like UptimeRobot — free tier).
16. Document the runbook for: a customer reporting "I paid but no confirmation" (check `pending` order in Redis, manual fulfill or refund); LibreBooking outage (orders stay `pending`, auto-fulfill on next webhook retry or via manual replay); Lightsail instance failure (restore from latest snapshot).
17. Decide rotation cadence for Stripe / PayPal / Resend / Lightsail service-account credentials.

## Security posture summary

- TLS everywhere — Amplify Hosting provides automatic HTTPS for the storefront; Caddy + Let's Encrypt on the Lightsail box covers LibreBooking.
- No SQL DB to harden in the storefront — all state is in Upstash (REST + token auth) or LibreBooking (which now has its own backups).
- Secrets only in the Amplify env store and devcontainer-local `.env.local` (gitignored); Zod-validated at boot.
- Webhook signature verification on Stripe and PayPal; event IDs deduped via Redis `SET NX` (24h TTL).
- Service-account principle of least privilege in LibreBooking (read resources/availability, create reservations + users — nothing else).
- Idempotent, lock-guarded fulfillment prevents double-booking even under concurrent webhook + capture callbacks.
- Lightsail Automatic Snapshots (daily, 7-day retention) provide rapid DR for LibreBooking; CloudWatch alarms surface instance failures.
