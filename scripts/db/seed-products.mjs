// Seeds the initial BCC rental products into the `items` + `item_prices` tables.
//
//   npm run db:seed        # dev branch  (DATABASE_URL_DEV)
//   npm run db:seed:prod   # main branch (DATABASE_URL)
//
// Idempotent: upserts each item by slug and replaces that item's price rows, so
// re-running converges to the definitions below. Reads LB_RESOURCE_ID_* from env
// for the transitional resource_id column (dropped in N2.7). Run via Node's
// --env-file so .env.local is loaded (see package.json).

import pg from "pg";

const isProd = process.argv.includes("--prod");
const target = isProd ? "main (prod)" : "dev";
const envVar = isProd ? "DATABASE_URL" : "DATABASE_URL_DEV";
const connectionString = process.env[envVar];
if (!connectionString) {
  console.error(`${envVar} is not set. Run via npm run db:seed${isProd ? ":prod" : ""} (loads .env.local).`);
  process.exit(1);
}

const num = (name) => {
  const v = process.env[name];
  return v ? Number(v) : null;
};

// Flat rates (one all-days/all-hours price row each) matching the pre-migration
// config. Add more price rows (weekday/weekend, hour windows) here or via the
// admin UI later; the schema supports it.
const PRODUCTS = [
  {
    slug: "tent",
    name: "Outdoor Tent",
    type: "unique",
    total_stock: 1,
    short_description: "Large outdoor tent for events on the BCC grounds.",
    long_description:
      "A weather-rated outdoor tent suitable for birthdays, gatherings, and community events. Setup and takedown coordinated with BCC staff.",
    highlights: ["Weather-rated", "Seats up to 60", "Setup included"],
    image: "/images/tent.jpg",
    pricing_unit: "day",
    min_minutes: 1440,
    max_minutes: null,
    buffer_minutes: 0,
    lead_hours: 48,
    horizon_days: 180,
    available_hours: null,
    resource_id: num("LB_RESOURCE_ID_TENT"),
    sort_order: 1,
    categories: ["event-add-on", "accessory"],
    prices: [{ price_cents: 15000, days_of_week: null, start_minute: null, end_minute: null, priority: 0, label: null }],
  },
  {
    slug: "popcorn-machine",
    name: "Popcorn Machine",
    type: "unique",
    total_stock: 1,
    short_description: "Classic theater-style popcorn machine for parties.",
    long_description:
      "A theater-style popcorn machine perfect for movie nights, parties, or fundraisers. Pickup and return at the BCC.",
    highlights: ["Includes starter kit", "Easy pickup", "Movie-night favorite"],
    image: "/images/popcorn.jpg",
    pricing_unit: "day",
    min_minutes: 1440,
    max_minutes: null,
    buffer_minutes: 0,
    lead_hours: 24,
    horizon_days: 180,
    available_hours: null,
    resource_id: num("LB_RESOURCE_ID_POPCORN"),
    sort_order: 2,
    categories: ["event-add-on", "equipment"],
    prices: [{ price_cents: 5000, days_of_week: null, start_minute: null, end_minute: null, priority: 0, label: null }],
  },
  {
    slug: "party-room",
    name: "Birthday Party Room",
    type: "unique",
    total_stock: 1,
    short_description: "Indoor space for birthday parties — tables and chairs included.",
    long_description:
      "Our dedicated birthday party room comes set up with tables and chairs. Reserve hourly blocks; the space is yours start to finish.",
    highlights: ["Tables and chairs included", "Indoor", "Hourly booking"],
    image: "/images/party-room.jpg",
    pricing_unit: "hour",
    min_minutes: 120,
    max_minutes: 360,
    buffer_minutes: 0,
    lead_hours: 24,
    horizon_days: 90,
    available_hours: { openHour: 9, closeHour: 21, slotMinutes: 60 },
    resource_id: num("LB_RESOURCE_ID_PARTY_ROOM"),
    sort_order: 3,
    categories: ["room"],
    prices: [{ price_cents: 4000, days_of_week: null, start_minute: null, end_minute: null, priority: 0, label: null }],
  },
  {
    slug: "meeting-room",
    name: "Meeting Room",
    type: "unique",
    total_stock: 1,
    short_description: "Quiet indoor room for meetings, classes, and small gatherings.",
    long_description:
      "A comfortable meeting room with tables, chairs, and a whiteboard. Ideal for community groups, classes, and small business meetings. Reserve by the hour.",
    highlights: ["Whiteboard included", "Seats up to 20", "Hourly booking"],
    image: "/images/meeting-room.jpg",
    pricing_unit: "hour",
    min_minutes: 60,
    max_minutes: 480,
    buffer_minutes: 0,
    lead_hours: 24,
    horizon_days: 90,
    available_hours: { openHour: 8, closeHour: 21, slotMinutes: 60 },
    resource_id: null,
    sort_order: 4,
    categories: ["room"],
    prices: [{ price_cents: 2500, days_of_week: null, start_minute: null, end_minute: null, priority: 0, label: null }],
  },
  {
    slug: "gymnasium",
    name: "Gymnasium",
    type: "unique",
    total_stock: 1,
    short_description: "Full-size indoor gym for sports, events, and large gatherings.",
    long_description:
      "Our full-size gymnasium is available for basketball, volleyball, indoor events, and large community gatherings. Reserve hourly blocks with BCC staff on site.",
    highlights: ["Full-size court", "Seats up to 200", "Hourly booking"],
    image: "/images/gymnasium.jpg",
    pricing_unit: "hour",
    min_minutes: 60,
    max_minutes: 480,
    buffer_minutes: 30,
    lead_hours: 48,
    horizon_days: 120,
    available_hours: { openHour: 8, closeHour: 22, slotMinutes: 60 },
    resource_id: null,
    sort_order: 5,
    categories: ["room"],
    prices: [{ price_cents: 6000, days_of_week: null, start_minute: null, end_minute: null, priority: 0, label: null }],
  },
  {
    slug: "power-drill",
    name: "Cordless Power Drill",
    type: "unique",
    total_stock: 1,
    short_description: "Cordless drill with bit set for home and community projects.",
    long_description:
      "A cordless power drill with a full bit set and spare battery. Great for community build days, repairs, and DIY projects. Pickup and return at the BCC.",
    highlights: ["Bit set included", "Spare battery", "Easy pickup"],
    image: "/images/power-drill.jpg",
    pricing_unit: "day",
    min_minutes: 1440,
    max_minutes: null,
    buffer_minutes: 0,
    lead_hours: 24,
    horizon_days: 180,
    available_hours: null,
    resource_id: null,
    sort_order: 6,
    categories: ["tool"],
    prices: [{ price_cents: 2000, days_of_week: null, start_minute: null, end_minute: null, priority: 0, label: null }],
  },
  {
    slug: "extension-ladder",
    name: "Extension Ladder",
    type: "unique",
    total_stock: 1,
    short_description: "24-foot extension ladder for exterior work and repairs.",
    long_description:
      "A sturdy 24-foot aluminum extension ladder for gutter cleaning, painting, and exterior repairs. Pickup and return at the BCC; safe handling instructions provided.",
    highlights: ["24-foot reach", "Aluminum, lightweight", "Easy pickup"],
    image: "/images/extension-ladder.jpg",
    pricing_unit: "day",
    min_minutes: 1440,
    max_minutes: null,
    buffer_minutes: 0,
    lead_hours: 24,
    horizon_days: 180,
    available_hours: null,
    resource_id: null,
    sort_order: 7,
    categories: ["tool"],
    prices: [{ price_cents: 2500, days_of_week: null, start_minute: null, end_minute: null, priority: 0, label: null }],
  },
  {
    slug: "folding-tables",
    name: "Folding Tables",
    type: "fungible",
    total_stock: 20,
    short_description: "Six-foot folding tables for events — reserve as many as you need.",
    long_description:
      "Six-foot rectangular folding tables, perfect for banquets, fundraisers, and gatherings. Reserve any number up to availability; pickup and return at the BCC.",
    highlights: ["Six-foot rectangular", "Seats up to 8 each", "Reserve multiple"],
    image: "/images/folding-tables.jpg",
    pricing_unit: "day",
    min_minutes: 1440,
    max_minutes: null,
    buffer_minutes: 0,
    lead_hours: 24,
    horizon_days: 180,
    available_hours: null,
    resource_id: null,
    sort_order: 8,
    categories: ["furniture", "accessory"],
    prices: [{ price_cents: 800, days_of_week: null, start_minute: null, end_minute: null, priority: 0, label: null }],
  },
  {
    slug: "folding-chairs",
    name: "Folding Chairs",
    type: "fungible",
    total_stock: 100,
    short_description: "Stackable folding chairs for events — reserve as many as you need.",
    long_description:
      "Comfortable stackable folding chairs for banquets, ceremonies, and gatherings. Reserve any number up to availability; pickup and return at the BCC.",
    highlights: ["Stackable", "Padded seat", "Reserve multiple"],
    image: "/images/folding-chairs.jpg",
    pricing_unit: "day",
    min_minutes: 1440,
    max_minutes: null,
    buffer_minutes: 0,
    lead_hours: 24,
    horizon_days: 180,
    available_hours: null,
    resource_id: null,
    sort_order: 9,
    categories: ["furniture", "accessory"],
    prices: [{ price_cents: 150, days_of_week: null, start_minute: null, end_minute: null, priority: 0, label: null }],
  },
  {
    slug: "projector",
    name: "HD Projector",
    type: "unique",
    total_stock: 1,
    short_description: "HD projector for presentations, movie nights, and events.",
    long_description:
      "A bright HD projector with HDMI input, ideal for presentations, movie nights, and events. Includes cables and a carrying case. Pickup and return at the BCC.",
    highlights: ["1080p HD", "HDMI + cables", "Carrying case"],
    image: "/images/projector.jpg",
    pricing_unit: "day",
    min_minutes: 1440,
    max_minutes: null,
    buffer_minutes: 0,
    lead_hours: 24,
    horizon_days: 180,
    available_hours: null,
    resource_id: null,
    sort_order: 10,
    categories: ["equipment", "event-add-on"],
    prices: [{ price_cents: 3500, days_of_week: null, start_minute: null, end_minute: null, priority: 0, label: null }],
  },
  {
    slug: "pa-speaker",
    name: "PA Speaker System",
    type: "unique",
    total_stock: 1,
    short_description: "Portable PA speaker with microphone for events and announcements.",
    long_description:
      "A portable powered PA speaker with a wireless microphone and stand, great for announcements, ceremonies, and outdoor events. Pickup and return at the BCC.",
    highlights: ["Wireless mic", "Speaker stand", "Bluetooth input"],
    image: "/images/pa-speaker.jpg",
    pricing_unit: "day",
    min_minutes: 1440,
    max_minutes: null,
    buffer_minutes: 0,
    lead_hours: 24,
    horizon_days: 180,
    available_hours: null,
    resource_id: null,
    sort_order: 11,
    categories: ["equipment", "event-add-on"],
    prices: [{ price_cents: 4000, days_of_week: null, start_minute: null, end_minute: null, priority: 0, label: null }],
  },
  {
    slug: "string-lights",
    name: "String Lights",
    type: "fungible",
    total_stock: 30,
    short_description: "Warm string lights to decorate tents, halls, and outdoor spaces.",
    long_description:
      "Strands of warm-white string lights for decorating tents, halls, and outdoor gatherings. Reserve multiple strands up to availability; pickup and return at the BCC.",
    highlights: ["Warm white", "48-foot strands", "Reserve multiple"],
    image: "/images/string-lights.jpg",
    pricing_unit: "day",
    min_minutes: 1440,
    max_minutes: null,
    buffer_minutes: 0,
    lead_hours: 24,
    horizon_days: 180,
    available_hours: null,
    resource_id: null,
    sort_order: 12,
    categories: ["decor", "event-add-on"],
    prices: [{ price_cents: 600, days_of_week: null, start_minute: null, end_minute: null, priority: 0, label: null }],
  },
];

const client = new pg.Client({ connectionString });

try {
  await client.connect();
  console.log(`Seeding products into Neon ${target} (${envVar})`);

  for (const p of PRODUCTS) {
    await client.query("BEGIN");
    try {
      const { rows } = await client.query(
        `INSERT INTO items
           (slug, name, type, total_stock, short_description, long_description, highlights,
            image, pricing_unit, min_minutes, max_minutes, buffer_minutes, lead_hours,
            horizon_days, available_hours, resource_id, sort_order, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
         ON CONFLICT (slug) DO UPDATE SET
            name = EXCLUDED.name,
            type = EXCLUDED.type,
            total_stock = EXCLUDED.total_stock,
            short_description = EXCLUDED.short_description,
            long_description = EXCLUDED.long_description,
            highlights = EXCLUDED.highlights,
            image = EXCLUDED.image,
            pricing_unit = EXCLUDED.pricing_unit,
            min_minutes = EXCLUDED.min_minutes,
            max_minutes = EXCLUDED.max_minutes,
            buffer_minutes = EXCLUDED.buffer_minutes,
            lead_hours = EXCLUDED.lead_hours,
            horizon_days = EXCLUDED.horizon_days,
            available_hours = EXCLUDED.available_hours,
            resource_id = EXCLUDED.resource_id,
            sort_order = EXCLUDED.sort_order,
            updated_at = now()
         RETURNING id`,
        [
          p.slug,
          p.name,
          p.type,
          p.total_stock,
          p.short_description,
          p.long_description,
          p.highlights,
          p.image,
          p.pricing_unit,
          p.min_minutes,
          p.max_minutes,
          p.buffer_minutes,
          p.lead_hours,
          p.horizon_days,
          p.available_hours ? JSON.stringify(p.available_hours) : null,
          p.resource_id,
          p.sort_order,
        ],
      );
      const itemId = rows[0].id;

      // Replace this item's price rows so re-seeding converges.
      await client.query("DELETE FROM item_prices WHERE item_id = $1", [itemId]);
      for (const pr of p.prices) {
        await client.query(
          `INSERT INTO item_prices (item_id, price_cents, days_of_week, start_minute, end_minute, priority, label)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [itemId, pr.price_cents, pr.days_of_week, pr.start_minute, pr.end_minute, pr.priority, pr.label],
        );
      }
      // Replace this item's category links so re-seeding converges. Resolve each
      // category_id via categories.slug (seeded idempotently by schema.sql).
      const categories = p.categories ?? [];
      await client.query("DELETE FROM item_categories WHERE item_id = $1", [itemId]);
      for (const slug of categories) {
        await client.query(
          `INSERT INTO item_categories (item_id, category_id)
           SELECT $1, c.id FROM categories c WHERE c.slug = $2`,
          [itemId, slug],
        );
      }
      await client.query("COMMIT");
      console.log(
        `  ✓ ${p.slug} (${p.prices.length} price row${p.prices.length === 1 ? "" : "s"}, ` +
          `${categories.length} categor${categories.length === 1 ? "y" : "ies"})`,
      );
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  const { rows: counts } = await client.query(
    `SELECT i.slug, count(p.id)::int AS prices
       FROM items i LEFT JOIN item_prices p ON p.item_id = i.id
      GROUP BY i.slug ORDER BY i.slug`,
  );
  console.log("Items:", counts.map((r) => `${r.slug}(${r.prices})`).join(", ") || "(none)");
} catch (err) {
  console.error("Seed failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
