# BCC Rentals — Payment Provider Decision

## Decision

We use **Stripe Checkout + PayPal Smart Buttons** for rental payments. PayPal is configured under Bachman Community Center's **PayPal Confirmed Charity** account (1.99% + $0.49 per transaction). **Zeffy** and **Zettle** were considered and rejected for this rental flow.

Bachman Community Center is a verified 501(c)(3).

## Why PayPal (Charity rate)

- **Already integrated.** Smart Buttons in [BookingWidget.tsx](../app/rentals/[slug]/BookingWidget.tsx); create-order, capture-order, and webhook in [app/api/checkout/paypal/](../app/api/checkout/paypal/) and [app/api/webhooks/paypal/](../app/api/webhooks/paypal/).
- **Charity rate: 1.99% + $0.49** (vs. 3.49% + $0.49 commercial). BCC's PayPal business account is already verified as a Confirmed Charity — no env-var or code change needed for the discount to apply.
- **Covers PayPal, Venmo, and Pay Later** through one integration ([BookingWidget.tsx:253](../app/rentals/[slug]/BookingWidget.tsx#L253)).
- **Programmatic refunds** via [lib/payments/refund.ts](../lib/payments/refund.ts) support the auto-refund-on-conflict path in [lib/orders/fulfill.ts](../lib/orders/fulfill.ts).

## Why Stripe (kept alongside PayPal)

- **Card-payment UX.** Many customers don't have PayPal accounts or prefer not to log in — Stripe Checkout's hosted card form converts better for that segment.
- **Redundancy.** If one provider has an outage, the other keeps the storefront open.
- **No published US nonprofit discount,** but Stripe negotiates case-by-case. Worth emailing Stripe Support with BCC's 501(c)(3) determination letter — downside is "no."
- Already integrated: [app/api/checkout/stripe/](../app/api/checkout/stripe/), [app/api/webhooks/stripe/](../app/api/webhooks/stripe/), [lib/payments/stripe.ts](../lib/payments/stripe.ts).

## Why not Zeffy

Zeffy is **0% fees for nonprofits** (donor-tip funded) — the most appealing rate of any option. Rejected for this flow because:

- **No developer API.** Zeffy is hosted/embeddable forms. There is no programmatic way to create a checkout from server code, attach order metadata, or handle the confirm-then-book sequencing this app requires.
- **No webhooks.** [lib/orders/fulfill.ts](../lib/orders/fulfill.ts) is driven by signed payment webhooks. Without that signal, we can't safely write to LibreBooking or run the auto-refund-on-conflict path.
- **Not a rentals product.** Zeffy's "store" is positioned for merchandise fundraising; it has no concept of resource availability windows, lead times, or programmable refunds.

**Future option:** Zeffy is still the right tool if BCC wants a separate `/donate` page on this site — donations don't need the rental fulfillment machinery. That's out of scope for this decision; revisit when/if BCC wants to solicit donations through the storefront.

## Why not Zettle

Zettle is PayPal-owned in-person POS — card readers, retail kiosks, market-stall checkouts. There is no online-checkout API suitable for a website's confirm-then-book flow. Zettle would be the right tool if BCC ever wants to swipe cards at an in-person event; it's not a fit for [BookingWidget.tsx](../app/rentals/[slug]/BookingWidget.tsx).

## Fee comparison

At current prices in [lib/products/config.ts](../lib/products/config.ts):

| Booking | PayPal Charity (1.99% + $0.49) | Stripe US standard (2.9% + $0.30) |
| --- | --- | --- |
| Party room — $40 | $1.29 | $1.46 |
| Popcorn — $50 | $1.49 | $1.75 |
| Tent — $150 | $3.48 | $4.65 |

PayPal Charity beats Stripe standard on every tier — but the per-booking gap ($0.17–$1.17) is small enough that conversion lift from offering both providers is expected to outweigh the fee delta. Both stay.

Note: the cost table in [ARCHITECTURE_PLAN.md](ARCHITECTURE_PLAN.md) cites PayPal as ~3.49% + $0.49; that's the commercial rate. The Charity rate above is the actual rate BCC pays.

## Open follow-ups

- Confirm the credentials in `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` ([lib/env.ts](../lib/env.ts)) belong to the Charity-verified PayPal account (not a separate commercial account).
- Email Stripe Support and request a nonprofit rate on the BCC Stripe account; attach the 501(c)(3) determination letter and projected annual volume.
