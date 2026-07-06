# BCC Rentals — Architecture Plan A vs Plan B

Side-by-side comparison of the two production architectures under consideration.

- **[Plan A](./ARCHITECTURE_PLAN.md)** — Storefront on Amplify + LibreBooking on Lightsail. Off-the-shelf scheduler, PHP/MySQL backend.
- **[Plan B](./ARCHITECTURE_PLAN_B.md)** — Storefront + scheduler on Amplify, backed by Neon Postgres + Upstash Redis. Reservation logic owned in this codebase.

## TL;DR

Plan B is **cheaper, simpler operationally, and fits the modern-stack goal**, at the cost of ~3-5 extra days of upfront dev work and the need to build a staff admin UI ourselves (deferrable). Plan A has lower initial dev cost but keeps a PHP/MySQL server we'd otherwise eliminate, and can't natively model fungible inventory (chairs, tables) — those would have to be tracked in app code under either plan.

For BCC's projected scope (30+ unique items + 100+ fungible inventory units), **Plan B is recommended**.

## Cost comparison

| Line | Plan A | Plan B |
| --- | --- | --- |
| Storefront | Amplify: $0 first 12mo, ~$1–3/mo after | Same |
| Reservation system of record | Lightsail 2 GB: $10/mo | Neon Postgres: $0 (free tier) |
| HTTPS for reservation system | Caddy + Let's Encrypt: $0 | N/A (no separate server) |
| Reservation system backup | Lightsail snapshots: ~$1–2/mo | Neon automated daily backups: $0 |
| Static IP | Lightsail static IP: $0 (free while attached) | N/A |
| Monitoring | CloudWatch alarms: $0 | Amplify built-in: $0 |
| Cache / ephemeral state | Upstash: $0 | Same |
| Email | Resend: $0 | Same |
| DNS | GoDaddy: already paid | Same |
| **Total monthly** | **~$12–15** | **~$0–3** |
| **5-year platform cost** | **~$720–900** | **~$0–180** |

Savings: **~$10–12/mo or ~$120–144/yr**. Not huge in absolute terms, but the saved spend is entirely the Lightsail VM we'd otherwise have to operate.

## Operational burden

| Concern | Plan A | Plan B |
| --- | --- | --- |
| Servers to patch / monitor | 1 Lightsail VM (Ubuntu, Docker, MySQL, Caddy) | 0 |
| Runtimes to maintain | Next.js + PHP | Next.js only |
| Databases to back up | MySQL (via Lightsail snapshots) | Postgres (Neon automated) |
| TLS certs to rotate | Caddy auto-renew (1 cert) | Amplify auto-renew (1 cert) |
| CloudWatch alarms to tune | Status check + CPU | None — Amplify built-in |
| Software upgrades | LibreBooking releases, MySQL patches, Ubuntu kernels, Docker | npm packages only |
| Incident response surface | SSH to Lightsail, debug PHP/MySQL/Docker | Amplify logs + Neon status page |

Plan B removes an entire operational surface. The dev team only ever debugs TypeScript; no separate runtime, no separate database admin.

## Capabilities

| Feature | Plan A | Plan B |
| --- | --- | --- |
| Unique resource scheduling (rooms, tools, tents) | LibreBooking built-in | `items.type = 'unique'` |
| Fungible inventory (chairs, plates, tables) | Not modeled — app-side tracking required anyway | `items.type = 'fungible'` with quantity ledger |
| Buffer time between bookings | LibreBooking config | `items.buffer_minutes` |
| Min/max reservation length | LibreBooking config | `items.min_minutes` |
| Availability windows (hours/days) | LibreBooking schedules | `items.available_hours` (jsonb) |
| Lead time / booking horizon | LibreBooking config | `items.lead_hours`, `items.horizon_days` |
| Holiday / blackout dates | LibreBooking | Insert `status='block'` row |
| Recurring reservations | LibreBooking | Not modeled (defer; not needed for one-off rentals) |
| Multi-resource reservations (one event, multiple items) | LibreBooking | Defer (not needed today) |
| Staff calendar UI | LibreBooking built-in | Build it (follow-up sprint); ICS feed available at launch |
| Staff manual block UI | LibreBooking built-in | Build it (follow-up sprint) |
| Reporting / usage stats | LibreBooking built-in | Direct SQL on Postgres (build dashboards as needed) |
| Notification on created | LibreBooking "Notify on Created" | Resend email in `fulfill.ts` |

## Tradeoffs

### Plan A — pros

- LibreBooking is an off-the-shelf system — less custom code to write/maintain
- Built-in staff calendar UI and admin tools
- Mature feature set (recurring reservations, multi-resource bookings, custom attributes)

### Plan A — cons

- $10–12/mo Lightsail line item that we otherwise wouldn't need
- Adds a PHP/MySQL server to operate
- Doesn't model fungible inventory — workaround required in app code anyway
- Two stacks to debug (Next.js + LibreBooking)
- The Lightsail VM is a single point of failure for the entire booking flow
- LibreBooking version upgrades require manual ops work
- Stack diverges from the rest of the modern TS app

### Plan B — pros

- $0 incremental hosting (Neon free tier + existing Amplify + Upstash)
- Single runtime — Next.js only
- Models both unique resources AND fungible inventory in one schema
- Per-item business rules (buffer, hours, lead time) live as data, editable without redeploy
- No separate server to patch / back up / monitor
- All logic in TypeScript, in this repo, testable with the existing Vitest setup
- Scales naturally — adding 100 items is just rows in a table

### Plan B — cons

- Staff admin UI must be built (deferrable ~2-3 day sprint)
- Recurring reservations and multi-resource bookings not modeled (not needed today)
- One more service dependency (Neon) — though Neon is standard Postgres and easy to migrate off
- Slightly more upfront dev work (~3-4 days vs ~1-2 days for the LibreBooking migration in Plan A)

## Risk comparison

| Risk | Plan A | Plan B |
| --- | --- | --- |
| Lightsail instance down | Booking flow fully blocked until restored | N/A — no Lightsail |
| MySQL corruption | Restore from snapshot (data loss up to 24h) | N/A |
| Neon outage | — | Booking flow blocked until Neon recovers (status page is public) |
| Storefront down (Amplify outage) | Same in both plans | Same |
| Stripe/PayPal webhook missed | Idempotent retry handles in both plans | Same |
| Loss of staff admin UI | LibreBooking remains functional even if storefront is down | Admin UI down if Amplify is down (acceptable — admin is non-realtime) |
| Vendor lock-in | LibreBooking export is a MySQL dump | Neon is standard Postgres — `pg_dump` and restore anywhere |

## Time-to-launch comparison

| Phase | Plan A | Plan B |
| --- | --- | --- |
| Initial setup | Provision Lightsail, install Docker, restore LibreBooking, install Caddy, configure DNS, configure notifications | Provision Neon project, build scheduler module, seed items |
| Estimated dev/admin time | ~2 days (mostly admin work) | ~3-4 days (mostly dev work) |
| Storefront refactor | Minor (LibreBooking client already exists) | Minor (4-method client swap, drop `findOrCreateUser`) |
| Staff admin UI | Out-of-the-box (LibreBooking) | Build follow-up sprint (~2-3 days) |
| **Total to fully-featured launch** | **~3-4 days** | **~5-7 days** |
| **Total to MVP launch** (email + ICS feed, defer admin UI) | n/a — LibreBooking comes bundled | **~4-5 days** |

## Recommendation

**Plan B is recommended for BCC Rentals** for the following reasons:

1. **Inventory model fit** — 100+ fungible items (chairs, tables) is the deciding factor; LibreBooking can't model these natively
2. **Operational simplicity** — single runtime, zero servers to patch
3. **Cost** — $0–3/mo vs $12–15/mo; meaningful over multi-year horizon for a nonprofit
4. **Stack alignment** — keeps the codebase in modern TypeScript end-to-end
5. **Stage-appropriate** — BCC hasn't built a staff admin workflow yet, so the "free LibreBooking admin UI" isn't load-bearing today

The main downside (building a custom staff admin UI) is **deferrable**: ship with email notifications + ICS feed, build the admin pages when the staff workflow is actually designed and the requirements are concrete.

Plan A remains the right choice if:
- BCC explicitly does not want any custom data-layer code, even small
- The staff workflow requires LibreBooking-specific features (recurring bookings, multi-resource events) we'd otherwise need to build
- Dev capacity is so constrained that ~3 extra days of upfront work is unacceptable
