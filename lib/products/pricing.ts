import { differenceInCalendarDays, differenceInMinutes, parseISO } from "date-fns";
import type { Product } from "./config";

export type Quote = {
  units: number;
  unitLabel: string;
  unitCents: number;
  totalCents: number;
};

export class PricingError extends Error {}

export function quote(product: Product, startISO: string, endISO: string): Quote {
  const start = parseISO(startISO);
  const end = parseISO(endISO);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new PricingError("Invalid start/end date");
  }
  if (end <= start) {
    throw new PricingError("End must be after start");
  }

  if (product.pricing.kind === "flat-per-day") {
    const days = Math.max(1, differenceInCalendarDays(end, start) + 1);
    if (days < product.pricing.minDays) {
      throw new PricingError(`Minimum ${product.pricing.minDays} day(s)`);
    }
    return {
      units: days,
      unitLabel: days === 1 ? "day" : "days",
      unitCents: product.pricing.cents,
      totalCents: days * product.pricing.cents,
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
    unitCents: product.pricing.cents,
    totalCents: hours * product.pricing.cents,
  };
}

export function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
