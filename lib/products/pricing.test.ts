import { describe, expect, it } from "vitest";
import { PricingError, quote } from "./pricing";
import type { Product } from "./config";

const dayProduct: Product = {
  slug: "tent",
  name: "Tent",
  shortDescription: "",
  longDescription: "",
  resourceId: 1,
  unit: "full-day",
  pricing: { kind: "flat-per-day", cents: 15000, minDays: 1 },
  bookingWindow: { minLeadHours: 0, maxAdvanceDays: 365 },
  image: "",
  highlights: [],
};

const hourProduct: Product = {
  slug: "party-room",
  name: "Party Room",
  shortDescription: "",
  longDescription: "",
  resourceId: 2,
  unit: "hourly",
  pricing: { kind: "flat-per-hour", cents: 4000, minHours: 2, maxHours: 6 },
  bookingWindow: { minLeadHours: 0, maxAdvanceDays: 365 },
  image: "",
  highlights: [],
};

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
