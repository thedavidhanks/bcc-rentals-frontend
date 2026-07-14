import "server-only";
import { v4 as uuid } from "uuid";
import { scheduler } from "@/lib/scheduler/client";
import { validateBooking, PolicyError } from "@/lib/scheduler/policy";
import { getProduct } from "@/lib/products/repository";
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
  const product = await getProduct(input.slug);
  if (!product) throw new PreflightError("Unknown product", 404);

  const q = quote(product, input.startISO, input.endISO);

  // Enforce per-item policy (lead time / horizon / hours / slot alignment).
  try {
    validateBooking(product, input.startISO, input.endISO);
  } catch (err) {
    if (err instanceof PolicyError) throw new PreflightError(err.message, 400);
    throw err;
  }

  const avail = await scheduler.getAvailability({
    itemSlug: product.slug,
    startISO: input.startISO,
    endISO: input.endISO,
    quantity: 1,
    bufferMinutes: product.bufferMinutes,
  });
  if (!avail.isAvailable) {
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
