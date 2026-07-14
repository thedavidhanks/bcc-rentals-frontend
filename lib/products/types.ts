// Client-safe product types. No `env`/`server-only` import, so this module can be
// imported from client components (BookingWidget) and pure modules (pricing).
// The DB-backed repository (lib/products/repository.ts) maps `items` + `item_prices`
// rows into these shapes; the app-facing shape is kept backward-compatible with the
// pre-migration static config so call sites change minimally.

export type ProductType = "unique" | "fungible";
export type ProductUnit = "full-day" | "hourly";

export type FlatPerDayPricing = { kind: "flat-per-day"; cents: number; minDays: number };
export type FlatPerHourPricing = {
  kind: "flat-per-hour";
  cents: number;
  minHours: number;
  maxHours: number;
};

/**
 * A single pricing scope. `daysOfWeek === null` means every day; `startMinute`/
 * `endMinute === null` means all hours. Minutes are since local midnight in the
 * BCC timezone. Higher `priority` wins when several rules match a booking.
 */
export type PriceRule = {
  priceCents: number;
  daysOfWeek: number[] | null; // 0=Sun .. 6=Sat
  startMinute: number | null;
  endMinute: number | null;
  priority: number;
  label: string | null;
};

export type Product = {
  slug: string;
  name: string;
  type: ProductType;
  totalStock: number;
  shortDescription: string;
  longDescription: string;
  highlights: string[];
  image: string | null;
  unit: ProductUnit;
  /**
   * Backward-compatible flat pricing derived from the resolved base price rule
   * (all-days/all-hours, highest priority) plus min/max length. Used by quote()
   * and the client widget today; the full per-unit rule engine (reading `prices`)
   * is deferred to N4.1.
   */
  pricing: FlatPerDayPricing | FlatPerHourPricing;
  /** All price rules for this item, for future variable pricing + admin editing. */
  prices: PriceRule[];
  bookingWindow: { minLeadHours: number; maxAdvanceDays: number };
  hourlyConstraints?: { openHour: number; closeHour: number; slotMinutes: number };
  bufferMinutes: number;
};
