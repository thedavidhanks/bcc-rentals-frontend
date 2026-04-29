import "server-only";
import { z } from "zod";
import { redis } from "@/lib/redis";

export const customerSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.email(),
  phone: z.string().min(7),
});
export type Customer = z.infer<typeof customerSchema>;

export const orderSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["pending", "confirmed", "refunded-conflict", "failed"]),
  productSlug: z.string(),
  startISO: z.string(),
  endISO: z.string(),
  totalCents: z.number().int().nonnegative(),
  customer: customerSchema,
  paymentProvider: z.enum(["stripe", "paypal"]).nullable(),
  paymentRef: z.string().nullable(),
  reservationRef: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Order = z.infer<typeof orderSchema>;

const PENDING_TTL = 60 * 60; // 1 hour
const CONFIRMED_TTL = 60 * 60 * 24 * 7; // 7 days

function key(id: string): string {
  return `order:${id}`;
}

export async function createPendingOrder(input: {
  id: string;
  productSlug: string;
  startISO: string;
  endISO: string;
  totalCents: number;
  customer: Customer;
}): Promise<Order> {
  const now = Date.now();
  const order: Order = {
    id: input.id,
    status: "pending",
    productSlug: input.productSlug,
    startISO: input.startISO,
    endISO: input.endISO,
    totalCents: input.totalCents,
    customer: input.customer,
    paymentProvider: null,
    paymentRef: null,
    reservationRef: null,
    createdAt: now,
    updatedAt: now,
  };
  await redis.set(key(order.id), order, { ex: PENDING_TTL });
  return order;
}

export async function getOrder(id: string): Promise<Order | null> {
  const raw = await redis.get(key(id));
  if (!raw) return null;
  return orderSchema.parse(raw);
}

export async function updateOrder(
  id: string,
  patch: Partial<Omit<Order, "id" | "createdAt">>,
): Promise<Order> {
  const existing = await getOrder(id);
  if (!existing) throw new Error(`Order ${id} not found`);
  const updated: Order = { ...existing, ...patch, updatedAt: Date.now() };
  const ttl = updated.status === "confirmed" ? CONFIRMED_TTL : PENDING_TTL;
  await redis.set(key(id), updated, { ex: ttl });
  return updated;
}

export async function acquireFulfillLock(id: string): Promise<boolean> {
  const result = await redis.set(`order:${id}:lock`, "1", { nx: true, ex: 60 });
  return result === "OK";
}

export async function recordWebhookEvent(provider: "stripe" | "paypal", eventId: string): Promise<boolean> {
  const result = await redis.set(`webhook:${provider}:${eventId}`, "1", {
    nx: true,
    ex: 60 * 60 * 24,
  });
  return result === "OK";
}
