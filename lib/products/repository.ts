import "server-only";
import { z } from "zod";
import { getPool } from "@/lib/scheduler/db";
import type { Product, PriceRule, ProductCategory, ProductUnit } from "./types";

// The catalog is read-mostly; cache resolved products per Node instance for a
// short window so page renders don't hit the DB every request, while admin edits
// still appear within seconds.
const CACHE_TTL_MS = 30_000;
let listCache: { products: Product[]; expires: number } | null = null;
let categoriesCache: { categories: ProductCategory[]; expires: number } | null = null;

type ItemRow = {
  slug: string;
  name: string;
  type: "unique" | "fungible";
  total_stock: number;
  short_description: string;
  long_description: string;
  highlights: string[];
  image: string | null;
  pricing_unit: "hour" | "day" | "event";
  min_minutes: number | null;
  max_minutes: number | null;
  buffer_minutes: number;
  lead_hours: number;
  horizon_days: number;
  available_hours: unknown;
};

type PriceRow = {
  item_slug: string;
  price_cents: number;
  days_of_week: number[] | null;
  start_minute: number | null;
  end_minute: number | null;
  priority: number;
  label: string | null;
};

type CategoryRow = {
  item_slug: string;
  slug: string;
  name: string;
};

const availableHoursSchema = z
  .object({
    openHour: z.number().int().min(0).max(24),
    closeHour: z.number().int().min(0).max(24),
    slotMinutes: z.number().int().positive(),
  })
  .nullable();

const ITEM_COLUMNS = `
  slug, name, type, total_stock, short_description, long_description, highlights,
  image, pricing_unit, min_minutes, max_minutes, buffer_minutes, lead_hours,
  horizon_days, available_hours`;

function toPriceRule(row: PriceRow): PriceRule {
  return {
    priceCents: row.price_cents,
    daysOfWeek: row.days_of_week,
    startMinute: row.start_minute,
    endMinute: row.end_minute,
    priority: row.priority,
    label: row.label,
  };
}

/** Base rate for the backward-compatible flat `pricing` shape: prefer the
 * all-days/all-hours rule with the highest priority, else the highest-priority
 * rule, else 0. */
function baseCents(prices: PriceRule[]): number {
  if (prices.length === 0) return 0;
  const byPriority = (a: PriceRule, b: PriceRule) => b.priority - a.priority;
  const flat = prices
    .filter((p) => p.daysOfWeek === null && p.startMinute === null)
    .sort(byPriority);
  const chosen = flat[0] ?? [...prices].sort(byPriority)[0];
  return chosen.priceCents;
}

function mapProduct(item: ItemRow, prices: PriceRule[], categories: ProductCategory[]): Product {
  const unit: ProductUnit = item.pricing_unit === "hour" ? "hourly" : "full-day";
  const cents = baseCents(prices);
  const hours = availableHoursSchema.parse(item.available_hours ?? null);

  const pricing =
    unit === "hourly"
      ? {
          kind: "flat-per-hour" as const,
          cents,
          minHours: item.min_minutes ? Math.round(item.min_minutes / 60) : 1,
          maxHours: item.max_minutes ? Math.round(item.max_minutes / 60) : 24,
        }
      : {
          kind: "flat-per-day" as const,
          cents,
          minDays: item.min_minutes ? Math.max(1, Math.round(item.min_minutes / 1440)) : 1,
        };

  return {
    slug: item.slug,
    name: item.name,
    type: item.type,
    totalStock: item.total_stock,
    shortDescription: item.short_description,
    longDescription: item.long_description,
    highlights: item.highlights ?? [],
    image: item.image,
    unit,
    pricing,
    prices,
    categories,
    bookingWindow: { minLeadHours: item.lead_hours, maxAdvanceDays: item.horizon_days },
    hourlyConstraints:
      unit === "hourly" && hours
        ? { openHour: hours.openHour, closeHour: hours.closeHour, slotMinutes: hours.slotMinutes }
        : undefined,
    bufferMinutes: item.buffer_minutes,
  };
}

async function pricesBySlug(slugs: string[]): Promise<Map<string, PriceRule[]>> {
  const bySlug = new Map<string, PriceRule[]>();
  if (slugs.length === 0) return bySlug;
  const res = await getPool().query<PriceRow>(
    `SELECT i.slug AS item_slug, p.price_cents, p.days_of_week, p.start_minute,
            p.end_minute, p.priority, p.label
       FROM item_prices p JOIN items i ON i.id = p.item_id
      WHERE i.slug = ANY($1)`,
    [slugs],
  );
  for (const row of res.rows) {
    const list = bySlug.get(row.item_slug) ?? [];
    list.push(toPriceRule(row));
    bySlug.set(row.item_slug, list);
  }
  return bySlug;
}

async function categoriesBySlug(slugs: string[]): Promise<Map<string, ProductCategory[]>> {
  const bySlug = new Map<string, ProductCategory[]>();
  if (slugs.length === 0) return bySlug;
  const res = await getPool().query<CategoryRow>(
    `SELECT i.slug AS item_slug, c.slug, c.name
       FROM item_categories ic
       JOIN categories c ON c.id = ic.category_id
       JOIN items i ON i.id = ic.item_id
      WHERE i.slug = ANY($1)
      ORDER BY c.sort_order, c.name`,
    [slugs],
  );
  for (const row of res.rows) {
    const list = bySlug.get(row.item_slug) ?? [];
    list.push({ slug: row.slug, name: row.name });
    bySlug.set(row.item_slug, list);
  }
  return bySlug;
}

/** All active products, ordered for display. Cached briefly per instance. */
export async function listProducts(): Promise<Product[]> {
  const now = Date.now();
  if (listCache && listCache.expires > now) return listCache.products;

  const items = await getPool().query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM items WHERE active = true ORDER BY sort_order, name`,
  );
  const slugs = items.rows.map((r) => r.slug);
  const prices = await pricesBySlug(slugs);
  const categories = await categoriesBySlug(slugs);
  const products = items.rows.map((row) =>
    mapProduct(row, prices.get(row.slug) ?? [], categories.get(row.slug) ?? []),
  );

  listCache = { products, expires: now + CACHE_TTL_MS };
  return products;
}

/** A single product by slug, or undefined if unknown/inactive. */
export async function getProduct(slug: string): Promise<Product | undefined> {
  const cached = listCache?.products.find((p) => p.slug === slug);
  if (cached && listCache!.expires > Date.now()) return cached;

  const items = await getPool().query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM items WHERE slug = $1 AND active = true`,
    [slug],
  );
  const item = items.rows[0];
  if (!item) return undefined;
  const prices = await pricesBySlug([slug]);
  const categories = await categoriesBySlug([slug]);
  return mapProduct(item, prices.get(slug) ?? [], categories.get(slug) ?? []);
}

/** All browse categories, ordered for display. Cached briefly per instance. */
export async function listCategories(): Promise<ProductCategory[]> {
  const now = Date.now();
  if (categoriesCache && categoriesCache.expires > now) return categoriesCache.categories;

  const res = await getPool().query<{ slug: string; name: string }>(
    `SELECT slug, name FROM categories ORDER BY sort_order, name`,
  );
  const categories = res.rows.map((r) => ({ slug: r.slug, name: r.name }));

  categoriesCache = { categories, expires: now + CACHE_TTL_MS };
  return categories;
}
