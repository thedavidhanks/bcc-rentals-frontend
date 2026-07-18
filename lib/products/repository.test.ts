import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the shared Postgres seam. `poolQuery` is a stable vi.fn referenced by the
// (lazily-invoked) mock factory, so it survives vi.resetModules() below.
const poolQuery = vi.fn();

vi.mock("@/lib/scheduler/db", () => ({
  getPool: () => ({ query: poolQuery }),
}));

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

function makeItem(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    slug: "tent",
    name: "Tent",
    type: "unique",
    total_stock: 1,
    short_description: "short",
    long_description: "long",
    highlights: ["a", "b"],
    image: "/images/tent.jpg",
    pricing_unit: "day",
    min_minutes: 1440,
    max_minutes: null,
    buffer_minutes: 0,
    lead_hours: 24,
    horizon_days: 180,
    available_hours: null,
    ...overrides,
  };
}

function makePrice(overrides: Partial<PriceRow> = {}): PriceRow {
  return {
    item_slug: "tent",
    price_cents: 15000,
    days_of_week: null,
    start_minute: null,
    end_minute: null,
    priority: 0,
    label: null,
    ...overrides,
  };
}

function makeCategory(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    item_slug: "tent",
    slug: "event-add-on",
    name: "Event add-on",
    ...overrides,
  };
}

const rows = <T>(...r: T[]) => ({ rows: r });

// The repository caches per-module-instance for 30s; reset the registry each test
// and re-import so a stale cache never leaks between cases.
async function loadRepo() {
  vi.resetModules();
  return import("./repository");
}

beforeEach(() => {
  poolQuery.mockReset();
});

describe("listProducts", () => {
  it("maps a full-day item + flat price into a Product", async () => {
    poolQuery
      .mockResolvedValueOnce(rows(makeItem())) // items
      .mockResolvedValueOnce(rows(makePrice())) // item_prices
      .mockResolvedValueOnce(rows()); // item_categories

    const { listProducts } = await loadRepo();
    const [p] = await listProducts();

    expect(p).toMatchObject({
      slug: "tent",
      name: "Tent",
      type: "unique",
      totalStock: 1,
      shortDescription: "short",
      longDescription: "long",
      highlights: ["a", "b"],
      image: "/images/tent.jpg",
      unit: "full-day",
      pricing: { kind: "flat-per-day", cents: 15000, minDays: 1 },
      bookingWindow: { minLeadHours: 24, maxAdvanceDays: 180 },
      bufferMinutes: 0,
    });
    expect(p.hourlyConstraints).toBeUndefined();
    expect(p.prices).toHaveLength(1);
    expect(p.categories).toEqual([]);
  });

  it("populates categories in sort order for a multi-category product", async () => {
    poolQuery
      .mockResolvedValueOnce(rows(makeItem()))
      .mockResolvedValueOnce(rows(makePrice()))
      // Rows arrive already ordered by the SQL `ORDER BY c.sort_order, c.name`;
      // the mapper must preserve that order.
      .mockResolvedValueOnce(
        rows(
          makeCategory({ slug: "event-add-on", name: "Event add-on" }),
          makeCategory({ slug: "accessory", name: "Accessory" }),
        ),
      );

    const { listProducts } = await loadRepo();
    const [p] = await listProducts();

    expect(p.categories).toEqual([
      { slug: "event-add-on", name: "Event add-on" },
      { slug: "accessory", name: "Accessory" },
    ]);
  });

  it("groups category rows onto the correct product and defaults to [] for the rest", async () => {
    poolQuery
      .mockResolvedValueOnce(
        rows(
          makeItem({ slug: "tent", name: "Tent" }),
          makeItem({ slug: "power-drill", name: "Power Drill" }),
        ),
      )
      .mockResolvedValueOnce(
        rows(makePrice({ item_slug: "tent" }), makePrice({ item_slug: "power-drill" })),
      )
      .mockResolvedValueOnce(
        rows(makeCategory({ item_slug: "tent", slug: "event-add-on", name: "Event add-on" })),
      );

    const { listProducts } = await loadRepo();
    const products = await listProducts();
    const tent = products.find((p) => p.slug === "tent");
    const drill = products.find((p) => p.slug === "power-drill");

    expect(tent?.categories).toEqual([{ slug: "event-add-on", name: "Event add-on" }]);
    expect(drill?.categories).toEqual([]);
  });

  it("maps an hourly item with available_hours into hourlyConstraints", async () => {
    poolQuery
      .mockResolvedValueOnce(
        rows(
          makeItem({
            slug: "party-room",
            name: "Party Room",
            pricing_unit: "hour",
            min_minutes: 120,
            max_minutes: 360,
            available_hours: { openHour: 9, closeHour: 21, slotMinutes: 60 },
          }),
        ),
      )
      .mockResolvedValueOnce(rows(makePrice({ item_slug: "party-room", price_cents: 4000 })))
      .mockResolvedValueOnce(rows());

    const { listProducts } = await loadRepo();
    const [p] = await listProducts();

    expect(p.unit).toBe("hourly");
    expect(p.pricing).toEqual({ kind: "flat-per-hour", cents: 4000, minHours: 2, maxHours: 6 });
    expect(p.hourlyConstraints).toEqual({ openHour: 9, closeHour: 21, slotMinutes: 60 });
  });

  it("yields cents: 0 when an item has no price rows", async () => {
    poolQuery
      .mockResolvedValueOnce(rows(makeItem()))
      .mockResolvedValueOnce(rows()) // no prices
      .mockResolvedValueOnce(rows()); // no categories

    const { listProducts } = await loadRepo();
    const [p] = await listProducts();
    expect(p.pricing.cents).toBe(0);
    expect(p.prices).toEqual([]);
  });

  it("picks the highest-priority all-days/all-hours rule as the base rate", async () => {
    poolQuery.mockResolvedValueOnce(rows(makeItem())).mockResolvedValueOnce(
      rows(
        makePrice({ price_cents: 4000, priority: 0 }),
        makePrice({ price_cents: 5000, priority: 10 }), // higher-priority flat rule → wins
        makePrice({ price_cents: 9999, priority: 100, days_of_week: [6], start_minute: 600 }), // scoped: ignored for base
      ),
    );
    poolQuery.mockResolvedValueOnce(rows()); // no categories

    const { listProducts } = await loadRepo();
    const [p] = await listProducts();
    expect(p.pricing.cents).toBe(5000);
  });

  it("caches results and does not re-query on a second call", async () => {
    poolQuery
      .mockResolvedValueOnce(rows(makeItem()))
      .mockResolvedValueOnce(rows(makePrice()))
      .mockResolvedValueOnce(rows());

    const { listProducts } = await loadRepo();
    const first = await listProducts();
    const second = await listProducts();

    expect(second).toBe(first); // same cached array reference
    expect(poolQuery).toHaveBeenCalledTimes(3); // items + prices + categories, once
  });
});

describe("getProduct", () => {
  it("returns the mapped product for a known slug", async () => {
    poolQuery
      .mockResolvedValueOnce(rows(makeItem()))
      .mockResolvedValueOnce(rows(makePrice()))
      .mockResolvedValueOnce(rows(makeCategory({ slug: "event-add-on", name: "Event add-on" })));

    const { getProduct } = await loadRepo();
    const p = await getProduct("tent");
    expect(p).toMatchObject({ slug: "tent", pricing: { cents: 15000 } });
    expect(p?.categories).toEqual([{ slug: "event-add-on", name: "Event add-on" }]);
  });

  it("returns undefined for an unknown/inactive slug", async () => {
    poolQuery.mockResolvedValueOnce(rows()); // no item

    const { getProduct } = await loadRepo();
    expect(await getProduct("nope")).toBeUndefined();
  });

  it("serves from the warm list cache without querying again", async () => {
    poolQuery
      .mockResolvedValueOnce(rows(makeItem()))
      .mockResolvedValueOnce(rows(makePrice()))
      .mockResolvedValueOnce(rows());

    const repo = await loadRepo();
    await repo.listProducts(); // warms the cache (3 queries)
    const p = await repo.getProduct("tent");

    expect(p).toMatchObject({ slug: "tent" });
    expect(poolQuery).toHaveBeenCalledTimes(3); // no extra query for getProduct
  });
});

describe("listCategories", () => {
  it("maps category rows to { slug, name } in query order", async () => {
    poolQuery.mockResolvedValueOnce(
      rows(
        { slug: "room", name: "Room" },
        { slug: "tool", name: "Tool" },
        { slug: "event-add-on", name: "Event add-on" },
      ),
    );

    const { listCategories } = await loadRepo();
    const categories = await listCategories();

    expect(categories).toEqual([
      { slug: "room", name: "Room" },
      { slug: "tool", name: "Tool" },
      { slug: "event-add-on", name: "Event add-on" },
    ]);
  });

  it("returns [] when there are no categories", async () => {
    poolQuery.mockResolvedValueOnce(rows());

    const { listCategories } = await loadRepo();
    expect(await listCategories()).toEqual([]);
  });

  it("caches results and does not re-query on a second call", async () => {
    poolQuery.mockResolvedValueOnce(rows({ slug: "room", name: "Room" }));

    const { listCategories } = await loadRepo();
    const first = await listCategories();
    const second = await listCategories();

    expect(second).toBe(first);
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });
});
