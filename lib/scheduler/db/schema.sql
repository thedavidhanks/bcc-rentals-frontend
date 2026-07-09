-- BCC Rentals scheduler schema (Plan B). System of record for items + reservations.
-- Apply with: npm run db:apply  (targets the Neon dev branch via DATABASE_URL_DEV)
--
-- Pricing and booking policy intentionally live in lib/products/config.ts (richer,
-- type-safe), NOT in this schema. `items` here is identity + inventory only.

CREATE TABLE IF NOT EXISTS items (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique not null,
  name         text not null,
  type         text not null check (type in ('unique', 'fungible')),
  total_stock  int  not null default 1 check (total_stock > 0),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

CREATE TABLE IF NOT EXISTS reservations (
  id              uuid primary key default gen_random_uuid(),
  item_id         uuid not null references items(id),
  quantity        int  not null default 1 check (quantity > 0),
  start_at        timestamptz not null,
  end_at          timestamptz not null,
  status          text not null check (status in ('confirmed', 'block', 'cancelled')),
  order_id        text,           -- Upstash order key when the reservation came from a paid booking
  customer_email  text,
  customer_name   text,
  customer_phone  text,
  notes           text,
  created_at      timestamptz not null default now(),
  check (end_at > start_at)
);

CREATE INDEX IF NOT EXISTS reservations_item_time_idx
  ON reservations (item_id, start_at, end_at)
  WHERE status <> 'cancelled';
