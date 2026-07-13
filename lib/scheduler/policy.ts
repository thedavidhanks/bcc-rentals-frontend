// Per-item booking policy validation (Plan B P1.4). Pure module over the product
// config — no DB/secrets — so it's unit-testable like lib/products/pricing.ts.
// Length (min/max) stays in quote(); buffer is applied in the scheduler overlap.
import type { Product } from "@/lib/products/types";

// BCC operates in Eastern time; available-hours are local wall-clock hours.
// (The legacy LibreBooking client hardcodes America/Chicago — inconsistent, but
// that module is removed in N2.7.)
const BCC_TIMEZONE = "America/New_York";

export type PolicyCode = "lead-time" | "horizon" | "available-hours" | "slot-alignment";

/** A booking that violates a per-item policy rule. */
export class PolicyError extends Error {
  constructor(
    readonly code: PolicyCode,
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Local calendar day (YYYY-MM-DD) and minutes-since-midnight in BCC time. */
function localParts(date: Date): { day: string; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BCC_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  const minute = Number(get("hour")) * 60 + Number(get("minute"));
  const second = Number(get("second"));
  // Fold any stray seconds into a fractional minute so slot-alignment catches them.
  return { day, minute: minute + second / 60 };
}

/**
 * Validates a requested [startISO, endISO) booking against the product's policy.
 * Throws the first PolicyError encountered; returns void when the window is
 * bookable. `now` is injectable for tests.
 */
export function validateBooking(
  product: Product,
  startISO: string,
  endISO: string,
  now: Date = new Date(),
): void {
  const start = new Date(startISO);
  const end = new Date(endISO);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new PolicyError("slot-alignment", "Invalid start/end date");
  }

  const { minLeadHours, maxAdvanceDays } = product.bookingWindow;

  if (start.getTime() < now.getTime() + minLeadHours * HOUR_MS) {
    throw new PolicyError(
      "lead-time",
      `Bookings require at least ${minLeadHours} hour(s) of lead time`,
    );
  }

  if (start.getTime() > now.getTime() + maxAdvanceDays * DAY_MS) {
    throw new PolicyError(
      "horizon",
      `Bookings can be made at most ${maxAdvanceDays} day(s) in advance`,
    );
  }

  // Available-hours + slot alignment apply to hourly items only.
  const hc = product.hourlyConstraints;
  if (product.unit !== "hourly" || !hc) return;

  const s = localParts(start);
  const e = localParts(end);

  if (s.day !== e.day) {
    throw new PolicyError("available-hours", "Hourly bookings must start and end on the same day");
  }

  if (s.minute < hc.openHour * 60 || e.minute > hc.closeHour * 60) {
    throw new PolicyError(
      "available-hours",
      `Bookings must fall between ${hc.openHour}:00 and ${hc.closeHour}:00`,
    );
  }

  if (s.minute % hc.slotMinutes !== 0 || e.minute % hc.slotMinutes !== 0) {
    throw new PolicyError(
      "slot-alignment",
      `Start and end must align to ${hc.slotMinutes}-minute slots`,
    );
  }
}
