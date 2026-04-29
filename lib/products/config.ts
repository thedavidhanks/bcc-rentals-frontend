import { env } from "@/lib/env";

export type ProductSlug = "tent" | "popcorn-machine" | "party-room";

type FlatPerDayPricing = { kind: "flat-per-day"; cents: number; minDays: number };
type FlatPerHourPricing = {
  kind: "flat-per-hour";
  cents: number;
  minHours: number;
  maxHours: number;
};

export type Product = {
  slug: ProductSlug;
  name: string;
  shortDescription: string;
  longDescription: string;
  resourceId: number;
  unit: "full-day" | "hourly";
  pricing: FlatPerDayPricing | FlatPerHourPricing;
  bookingWindow: { minLeadHours: number; maxAdvanceDays: number };
  hourlyConstraints?: { openHour: number; closeHour: number; slotMinutes: 60 };
  image: string;
  highlights: string[];
};

// TODO(BCC): confirm pricing, lead times, and party-room hours before launch.
export const PRODUCTS: Record<ProductSlug, Product> = {
  tent: {
    slug: "tent",
    name: "Outdoor Tent",
    shortDescription: "Large outdoor tent for events on the BCC grounds.",
    longDescription:
      "A weather-rated outdoor tent suitable for birthdays, gatherings, and community events. Setup and takedown coordinated with BCC staff.",
    resourceId: env.LB_RESOURCE_ID_TENT,
    unit: "full-day",
    pricing: { kind: "flat-per-day", cents: 15000, minDays: 1 },
    bookingWindow: { minLeadHours: 48, maxAdvanceDays: 180 },
    image: "/images/tent.jpg",
    highlights: ["Weather-rated", "Seats up to 60", "Setup included"],
  },
  "popcorn-machine": {
    slug: "popcorn-machine",
    name: "Popcorn Machine",
    shortDescription: "Classic theater-style popcorn machine for parties.",
    longDescription:
      "A theater-style popcorn machine perfect for movie nights, parties, or fundraisers. Pickup and return at the BCC.",
    resourceId: env.LB_RESOURCE_ID_POPCORN,
    unit: "full-day",
    pricing: { kind: "flat-per-day", cents: 5000, minDays: 1 },
    bookingWindow: { minLeadHours: 24, maxAdvanceDays: 180 },
    image: "/images/popcorn.jpg",
    highlights: ["Includes starter kit", "Easy pickup", "Movie-night favorite"],
  },
  "party-room": {
    slug: "party-room",
    name: "Birthday Party Room",
    shortDescription: "Indoor space for birthday parties — tables and chairs included.",
    longDescription:
      "Our dedicated birthday party room comes set up with tables and chairs. Reserve hourly blocks; the space is yours start to finish.",
    resourceId: env.LB_RESOURCE_ID_PARTY_ROOM,
    unit: "hourly",
    pricing: { kind: "flat-per-hour", cents: 4000, minHours: 2, maxHours: 6 },
    bookingWindow: { minLeadHours: 24, maxAdvanceDays: 90 },
    hourlyConstraints: { openHour: 9, closeHour: 21, slotMinutes: 60 },
    image: "/images/party-room.jpg",
    highlights: ["Tables and chairs included", "Indoor", "Hourly booking"],
  },
};

export const ALL_PRODUCTS: Product[] = Object.values(PRODUCTS);

export function getProduct(slug: string): Product | undefined {
  return (PRODUCTS as Record<string, Product>)[slug];
}
