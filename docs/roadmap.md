# BCC Rentals storefront — roadmap

The public website where people rent Bachman Community Center equipment
and spaces (tents, a popcorn machine, the party room), pay online with
PayPal, Venmo or a card, and get a confirmation by email.

This page holds each block's **intent**: what it is for, in plain
language. It is not a task list. Every task is a GitHub issue, and
status (open, closed, in progress, deployed) lives on GitHub: see the
[issues](https://github.com/thedavidhanks/bcc-rentals-frontend/issues),
the [milestones](https://github.com/thedavidhanks/bcc-rentals-frontend/milestones)
(one per block), and
[Project #4](https://github.com/users/thedavidhanks/projects/4), which
also tracks the companion
[admin app](https://github.com/thedavidhanks/bcc-rentals-admin).

Architecture and the archive of completed work are in
[EXECUTION_PLAN.md](./EXECUTION_PLAN.md); the admin app's requirements
are in [ADMIN_APP_SPEC.md](./ADMIN_APP_SPEC.md).

Change this page when the plan changes (a block is added, removed,
reordered, or rescoped) or when a block ships, not as issues close.
Edits ride on the branch whose change they describe, so this page can
lag GitHub by one pull request.

## Where the system is today (2026-11-12)

A renter can browse the rentals by category, open a product page, pick
a date or time the item is free, and pay with PayPal, Venmo or a guest
credit card. Once payment succeeds the booking is written to the
database, and the renter and BCC staff are both emailed. If two people
pay for the last slot at the same moment, only one booking is kept and
the other payment is refunded automatically. Staff can subscribe to a
calendar feed for each item.

The site runs on Google Cloud Run at a staging `run.app` address,
using PayPal's sandbox. The `rentals.bachmancc.org` address is not
connected yet. The site already reads and writes the live database, so
bookings made there are real. There is no staff screen in this
repository; staff tools are the separate admin app.

## Phases

### Block 1 — Build scheduler (complete)

Bookings live in BCC's own database instead of a separate booking
system, and two people can never book the last unit of an item at the
same time.

### Block 2 — Swap call sites + ICS feed (complete)

The checkout books through the new scheduler, the old booking system is
gone, staff are emailed about every booking, and each item has a
calendar feed staff can subscribe to.

### Block 2.5 — Browse rentals by category (complete)

Renters can browse rentals by category instead of scrolling one long
list.

### Block 3 — Containerize + deploy to Cloud Run

The storefront runs on Google Cloud at a public address, with its
secrets kept in Secret Manager, so it no longer depends on a
developer's machine.

### Block D — Demo state

The site is ready to show BCC and has been approved: payment works by
PayPal, Venmo or card, emails arrive, and a renter can get from the
listing to a confirmed booking without getting stuck. *Gate for
Block G.*

### Block 4 — Product & policy decisions

BCC confirms what the site sells and on what terms: prices, party-room
hours, how far ahead and how late an item can be booked, how many
chairs and tables there are, the email sending address, and the
cancellation policy. This is mostly decisions rather than code, and
runs alongside development.

### Block 5 — Production smoke test

Before real customers arrive, someone checks on the live site that
booked slots show as taken, a payment produces a booking and an email,
a race for the last slot ends cleanly, and partial bookings of chairs
leave the rest available.

### Block G — Go-live hardening

The site moves to `rentals.bachmancc.org`, its production secrets are
locked away, and every change reaches it only through a tested,
reviewed pull request. *Gated on Block D approval.*

### Block 7 — Operations

Once the site is live, staff hear about outages before renters do,
have written steps for the problems most likely to happen, and rotate
credentials on a schedule.

## Backlog

Work that belongs to no block yet lives as issues without a milestone.
When enough of it points the same way, it becomes a block on this page.
