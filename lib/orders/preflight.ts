import "server-only";
import { v4 as uuid } from "uuid";
import { librebooking } from "@/lib/librebooking/client";
import { getProduct } from "@/lib/products/config";
import { quote } from "@/lib/products/pricing";
import { createPendingOrder, type Customer } from "./store";

export type CheckoutInput = {
  slug: string;
  startISO: string;
  endISO: string;
  customer: Customer;
};

export type Preflight = {
  orderId: string;
  totalCents: number;
  productName: string;
};

export class PreflightError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * Re-quotes price server-side, re-checks availability, and creates a pending
 * order in Redis. Called from both /api/checkout/stripe and the PayPal create-order
 * endpoint.
 */
export async function preflightCheckout(input: CheckoutInput): Promise<Preflight> {
  const product = getProduct(input.slug);
  if (!product) throw new PreflightError("Unknown product", 404);

  const q = quote(product, input.startISO, input.endISO);

  const avail = await librebooking.getResourceAvailability({
    resourceId: product.resourceId,
    startDateTime: input.startISO,
    endDateTime: input.endISO,
  });
  const overlapping = avail.reservations.filter((r) => {
    const rStart = new Date(`${r.startDate}${r.startTime ? `T${r.startTime}` : ""}`).getTime();
    const rEnd = new Date(`${r.endDate}${r.endTime ? `T${r.endTime}` : ""}`).getTime();
    const inStart = new Date(input.startISO).getTime();
    const inEnd = new Date(input.endISO).getTime();
    return rStart < inEnd && rEnd > inStart;
  });
  if (overlapping.length > 0) {
    throw new PreflightError("Slot is no longer available", 409);
  }

  const orderId = uuid();
  await createPendingOrder({
    id: orderId,
    productSlug: product.slug,
    startISO: input.startISO,
    endISO: input.endISO,
    totalCents: q.totalCents,
    customer: input.customer,
  });

  return { orderId, totalCents: q.totalCents, productName: product.name };
}
