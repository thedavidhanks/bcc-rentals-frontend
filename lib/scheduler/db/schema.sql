-- BCC Rentals scheduler schema (Plan B). System of record for products + reservations.
-- Apply with: npm run db:apply  (targets the Neon dev branch via DATABASE_URL_DEV)
--             npm run db:apply:prod  (targets main via DATABASE_URL)
-- Seed with:  npm run db:seed / npm run db:seed:prod
--
-- The DATABASE is the source of truth for the full product (identity, content,
-- inventory, policy) — an admin can add/edit products with no redeploy. Pricing
-- lives in `item_prices` so it can vary by day-of-week and time-of-day.
--
-- This file is idempotent: base tables use CREATE TABLE IF NOT EXISTS and the
-- product columns added after P1.2 use ALTER TABLE ... ADD COLUMN IF NOT EXISTS,
-- so re-applying over the earlier minimal `items` table is safe.

CREATE TABLE IF NOT EXISTS items (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique not null,
  name         text not null,
  type         text not null check (type in ('unique', 'fungible')),
  total_stock  int  not null default 1 check (total_stock > 0),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Product columns added when the catalog moved into Postgres. ADD COLUMN IF NOT
-- EXISTS keeps re-apply safe on the earlier identity-only `items` table.
ALTER TABLE items ADD COLUMN IF NOT EXISTS short_description text not null default '';
ALTER TABLE items ADD COLUMN IF NOT EXISTS long_description  text not null default '';
ALTER TABLE items ADD COLUMN IF NOT EXISTS highlights        text[] not null default '{}';
ALTER TABLE items ADD COLUMN IF NOT EXISTS image             text;               -- path under public/, e.g. /images/tent.jpg
ALTER TABLE items ADD COLUMN IF NOT EXISTS pricing_unit      text not null default 'day';
ALTER TABLE items ADD COLUMN IF NOT EXISTS min_minutes       int;
ALTER TABLE items ADD COLUMN IF NOT EXISTS max_minutes       int;
ALTER TABLE items ADD COLUMN IF NOT EXISTS buffer_minutes    int  not null default 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS lead_hours        int  not null default 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS horizon_days      int  not null default 365;
ALTER TABLE items ADD COLUMN IF NOT EXISTS available_hours   jsonb;              -- {openHour,closeHour,slotMinutes}; null = unrestricted (day items)
ALTER TABLE items ADD COLUMN IF NOT EXISTS resource_id       int;                -- transitional LibreBooking id; dropped in N2.7
ALTER TABLE items ADD COLUMN IF NOT EXISTS sort_order        int  not null default 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS updated_at        timestamptz not null default now();

-- CHECK constraints (added separately so re-apply doesn't choke; guarded via DO blocks).
DO $$ BEGIN
  ALTER TABLE items ADD CONSTRAINT items_pricing_unit_chk CHECK (pricing_unit in ('hour', 'day', 'event'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE items ADD CONSTRAINT items_min_minutes_chk CHECK (min_minutes is null or min_minutes > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE items ADD CONSTRAINT items_max_minutes_chk CHECK (max_minutes is null or max_minutes > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE items ADD CONSTRAINT items_buffer_minutes_chk CHECK (buffer_minutes >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE items ADD CONSTRAINT items_lead_hours_chk CHECK (lead_hours >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE items ADD CONSTRAINT items_horizon_days_chk CHECK (horizon_days > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE items ADD CONSTRAINT items_min_max_chk CHECK (max_minutes is null or min_minutes is null or max_minutes >= min_minutes);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- item_prices: one row per day/time pricing scope for an item.
--   1 row  (days_of_week null, start/end null) = one flat rate, all days/all hours
--   2 rows                                      = weekday vs weekend
--   N rows                                      = specific days and/or hour windows
CREATE TABLE IF NOT EXISTS item_prices (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references items(id) on delete cascade,
  price_cents  int  not null check (price_cents >= 0),
  days_of_week smallint[],                                    -- 0=Sun .. 6=Sat (JS getDay / PG EXTRACT(DOW)); null = every day
  start_minute int check (start_minute between 0 and 1440),   -- local minutes since midnight (America/New_York); null = all hours
  end_minute   int check (end_minute   between 0 and 1440),
  priority     int  not null default 0,                       -- higher wins when multiple rows match
  label        text,                                          -- admin-facing, e.g. "Weekend rate"
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check ((start_minute is null) = (end_minute is null)),      -- both or neither
  check (start_minute is null or end_minute > start_minute)
);

CREATE INDEX IF NOT EXISTS item_prices_item_idx ON item_prices (item_id);

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

-- Browse categories. Distinct from items.type (unique/fungible inventory model):
-- categories are how customers browse the storefront, and a product can belong to
-- more than one (many-to-many via item_categories).
CREATE TABLE IF NOT EXISTS categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text UNIQUE NOT NULL,
  name       text NOT NULL,
  sort_order int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS item_categories (
  item_id     uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, category_id)
);

CREATE INDEX IF NOT EXISTS item_categories_category_idx ON item_categories (category_id);

-- Seed the browse categories so they always exist (idempotent).
INSERT INTO categories (slug, name, sort_order) VALUES
  ('room',         'Room',         1),
  ('tool',         'Tool',         2),
  ('accessory',    'Accessory',    3),
  ('event-add-on', 'Event Add-on', 4),
  ('furniture',    'Furniture',    5),
  ('equipment',    'Equipment',    6),
  ('decor',        'Decor',        7)
ON CONFLICT (slug) DO NOTHING;
