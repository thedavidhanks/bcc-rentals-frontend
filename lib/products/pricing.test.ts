import { describe, expect, it } from "vitest";
import { PricingError, quote, resolveRate } from "./pricing";
import type { PriceRule, Product } from "./types";

const flat = (cents: number): PriceRule => ({
  priceCents: cents,
  daysOfWeek: null,
  startMinute: null,
  endMinute: null,
  priority: 0,
  label: null,
});

function makeProduct(overrides: Partial<Product>): Product {
  return {
    slug: "tent",
    name: "Tent",
    type: "unique",
    totalStock: 1,
    shortDescription: "",
    longDescription: "",
    highlights: [],
    image: null,
    unit: "full-day",
    pricing: { kind: "flat-per-day", cents: 15000, minDays: 1 },
    prices: [flat(15000)],
    bookingWindow: { minLeadHours: 0, maxAdvanceDays: 365 },
    bufferMinutes: 0,
    ...overrides,
  };
}

const dayProduct = makeProduct({});
const hourProduct = makeProduct({
  slug: "party-room",
  name: "Party Room",
  unit: "hourly",
  pricing: { kind: "flat-per-hour", cents: 4000, minHours: 2, maxHours: 6 },
  prices: [flat(4000)],
});

describe("quote", () => {
  it("charges per calendar day inclusive of the end day", () => {
    const q = quote(dayProduct, "2026-05-01T00:00:00Z", "2026-05-03T00:00:00Z");
    expect(q.units).toBe(3);
    expect(q.totalCents).toBe(45000);
  });

  it("charges hourly within constraints", () => {
    const q = quote(hourProduct, "2026-05-01T14:00:00Z", "2026-05-01T17:00:00Z");
    expect(q.units).toBe(3);
    expect(q.totalCents).toBe(12000);
  });

  it("rejects under-minimum hourly bookings", () => {
    expect(() =>
      quote(hourProduct, "2026-05-01T14:00:00Z", "2026-05-01T15:00:00Z"),
    ).toThrow(PricingError);
  });

  it("rejects over-maximum hourly bookings", () => {
    expect(() =>
      quote(hourProduct, "2026-05-01T09:00:00Z", "2026-05-01T17:00:00Z"),
    ).toThrow(PricingError);
  });

  it("rejects end before start", () => {
    expect(() =>
      quote(dayProduct, "2026-05-03T00:00:00Z", "2026-05-01T00:00:00Z"),
    ).toThrow(PricingError);
  });
});

describe("resolveRate", () => {
  it("uses the flat rate for a single all-days/all-hours rule", () => {
    expect(resolveRate(dayProduct, "2026-05-01T16:00:00Z")).toBe(15000);
    expect(resolveRate(dayProduct, "2026-05-02T16:00:00Z")).toBe(15000);
  });

  it("picks the weekend rule on Sat/Sun and the base rule on weekdays", () => {
    const product = makeProduct({
      prices: [
        flat(15000),
        {
          priceCents: 20000,
          daysOfWeek: [0, 6], // Sun, Sat
          startMinute: null,
          endMinute: null,
          priority: 1,
          label: "Weekend rate",
        },
      ],
    });
    // 2026-05-01 is Friday ET, 2026-05-02 is Saturday ET.
    expect(resolveRate(product, "2026-05-01T16:00:00Z")).toBe(15000);
    expect(resolveRate(product, "2026-05-02T16:00:00Z")).toBe(20000);
  });

  it("varies the quote total by the resolved rate", () => {
    const product = makeProduct({
      prices: [
        flat(15000),
        { priceCents: 20000, daysOfWeek: [0, 6], startMinute: null, endMinute: null, priority: 1, label: null },
      ],
    });
    // Single Saturday booking → weekend rate.
    const q = quote(product, "2026-05-02T12:00:00Z", "2026-05-02T20:00:00Z");
    expect(q.unitCents).toBe(20000);
    expect(q.units).toBe(1);
  });
});
