import { describe, expect, it } from "vitest";
import { PolicyError, validateBooking } from "./policy";
import type { Product } from "@/lib/products/types";

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
    prices: [],
    bookingWindow: { minLeadHours: 24, maxAdvanceDays: 180 },
    bufferMinutes: 0,
    ...overrides,
  };
}

const partyRoom = makeProduct({
  slug: "party-room",
  name: "Party Room",
  unit: "hourly",
  pricing: { kind: "flat-per-hour", cents: 4000, minHours: 2, maxHours: 6 },
  bookingWindow: { minLeadHours: 24, maxAdvanceDays: 90 },
  hourlyConstraints: { openHour: 9, closeHour: 21, slotMinutes: 60 },
});

const NOW = new Date("2026-07-10T12:00:00Z");

// 2026-08-01 00:00 ET (EDT = UTC-4) as an epoch; `at()` returns the ISO string
// for a given ET hour/minute on that day.
const ET_MIDNIGHT_AUG1 = Date.parse("2026-08-01T04:00:00Z");
const at = (etHour: number, etMin = 0) =>
  new Date(ET_MIDNIGHT_AUG1 + etHour * 3_600_000 + etMin * 60_000).toISOString();

describe("validateBooking — lead time & horizon", () => {
  it("accepts a booking beyond the lead time and within the horizon", () => {
    expect(() =>
      validateBooking(makeProduct({}), "2026-07-20T00:00:00Z", "2026-07-21T00:00:00Z", NOW),
    ).not.toThrow();
  });

  it("rejects a booking inside the lead time", () => {
    // minLeadHours 24, but start is ~12h out.
    expect(() =>
      validateBooking(makeProduct({}), "2026-07-11T00:00:00Z", "2026-07-12T00:00:00Z", NOW),
    ).toThrow(expect.objectContaining({ code: "lead-time" }));
  });

  it("rejects a booking beyond the horizon", () => {
    // maxAdvanceDays 180, start is > 200 days out.
    expect(() =>
      validateBooking(makeProduct({}), "2027-03-01T00:00:00Z", "2027-03-02T00:00:00Z", NOW),
    ).toThrow(expect.objectContaining({ code: "horizon" }));
  });
});

describe("validateBooking — hourly available hours & slots", () => {
  it("accepts a booking within open hours up to the closing boundary", () => {
    expect(() => validateBooking(partyRoom, at(15), at(21), NOW)).not.toThrow();
  });

  it("rejects a booking ending after close", () => {
    expect(() =>
      validateBooking(partyRoom, at(18), at(21, 30), NOW),
    ).toThrow(expect.objectContaining({ code: "available-hours" }));
  });

  it("rejects a booking starting before open", () => {
    expect(() =>
      validateBooking(partyRoom, at(8), at(10), NOW),
    ).toThrow(expect.objectContaining({ code: "available-hours" }));
  });

  it("rejects a start not aligned to the slot", () => {
    expect(() =>
      validateBooking(partyRoom, at(14, 15), at(16, 15), NOW),
    ).toThrow(expect.objectContaining({ code: "slot-alignment" }));
  });

  it("rejects an hourly booking crossing midnight / different days", () => {
    // 23:00 ET Aug 1 → 01:00 ET Aug 2.
    expect(() =>
      validateBooking(partyRoom, at(23), at(25), NOW),
    ).toThrow(expect.objectContaining({ code: "available-hours" }));
  });

  it("skips hour checks for full-day products", () => {
    // A full-day product has no hourlyConstraints, so odd hours are fine.
    expect(() =>
      validateBooking(makeProduct({}), at(14, 15), at(16, 15), NOW),
    ).not.toThrow();
  });

  it("throws PolicyError instances", () => {
    try {
      validateBooking(partyRoom, at(8), at(10), NOW);
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyError);
    }
  });
});
