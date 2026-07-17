import { differenceInCalendarDays, differenceInMinutes, parseISO } from "date-fns";
import type { PriceRule, Product } from "./types";

export type Quote = {
  units: number;
  unitLabel: string;
  unitCents: number;
  totalCents: number;
};

export class PricingError extends Error {}

// BCC operates in Eastern time; pricing rules are scoped in local day/time.
const BCC_TIMEZONE = "America/New_York";

/** Day-of-week (0=Sun..6=Sat) and minutes-since-midnight of `date` in BCC time. */
function localDayAndMinute(date: Date): { dow: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BCC_TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[get("weekday")] ?? 0;
  const minute = Number(get("hour")) * 60 + Number(get("minute"));
  return { dow, minute };
}

function ruleMatches(rule: PriceRule, dow: number, minute: number): boolean {
  if (rule.daysOfWeek !== null && !rule.daysOfWeek.includes(dow)) return false;
  if (rule.startMinute !== null && rule.endMinute !== null) {
    if (minute < rule.startMinute || minute >= rule.endMinute) return false;
  }
  return true;
}

/** Specificity: day+time scoped (2) beats one axis (1) beats all-days/all-hours (0). */
function specificity(rule: PriceRule): number {
  return (rule.daysOfWeek !== null ? 1 : 0) + (rule.startMinute !== null ? 1 : 0);
}

/**
 * Rate (cents) applicable at the booking start. Picks the highest-priority
 * matching rule, tie-broken by specificity; falls back to the flat base rate.
 * Per-unit variation across a multi-day/multi-band booking is deferred (N4.1) —
 * today the whole booking is charged at the start's rate.
 */
export function resolveRate(product: Product, startISO: string): number {
  const start = parseISO(startISO);
  const { dow, minute } = localDayAndMinute(start);
  const matches = product.prices
    .filter((r) => ruleMatches(r, dow, minute))
    .sort((a, b) => b.priority - a.priority || specificity(b) - specificity(a));
  return matches[0]?.priceCents ?? product.pricing.cents;
}

export function quote(product: Product, startISO: string, endISO: string): Quote {
  const start = parseISO(startISO);
  const end = parseISO(endISO);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new PricingError("Invalid start/end date");
  }
  if (end <= start) {
    throw new PricingError("End must be after start");
  }

  const unitCents = resolveRate(product, startISO);

  if (product.pricing.kind === "flat-per-day") {
    // Half-open interval [start, end): end is the day-start *after* the last
    // booked day (app-wide convention, see lib/scheduler/client.ts), so the day
    // count is the plain calendar-day difference — no +1.
    const days = Math.max(1, differenceInCalendarDays(end, start));
    if (days < product.pricing.minDays) {
      throw new PricingError(`Minimum ${product.pricing.minDays} day(s)`);
    }
    return {
      units: days,
      unitLabel: days === 1 ? "day" : "days",
      unitCents,
      totalCents: days * unitCents,
    };
  }

  const minutes = differenceInMinutes(end, start);
  const hours = Math.round(minutes / 60);
  if (hours < product.pricing.minHours) {
    throw new PricingError(`Minimum ${product.pricing.minHours} hours`);
  }
  if (hours > product.pricing.maxHours) {
    throw new PricingError(`Maximum ${product.pricing.maxHours} hours`);
  }
  return {
    units: hours,
    unitLabel: hours === 1 ? "hour" : "hours",
    unitCents,
    totalCents: hours * unitCents,
  };
}

export function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
