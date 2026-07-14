import "server-only";
import { logger } from "@/lib/logger";
import { scheduler } from "@/lib/scheduler/client";
import { SchedulerConflictError } from "@/lib/scheduler/errors";
import { getProduct } from "@/lib/products/repository";
import { sendBookingConfirmation, sendStaffNotification } from "@/lib/email/resend";
import { refundPayment } from "@/lib/payments/refund";
import { acquireFulfillLock, getOrder, updateOrder, type Order } from "./store";

export type FulfillInput = {
  orderId: string;
  paymentProvider: "stripe" | "paypal";
  paymentRef: string;
};

export type FulfillResult =
  | { status: "confirmed"; order: Order }
  | { status: "already-confirmed"; order: Order }
  | { status: "lost-race" }
  | { status: "refunded-conflict"; order: Order }
  | { status: "not-found" };

/**
 * Idempotent: safe to call from both the webhook handler and the synchronous
 * capture endpoint. The first caller wins via Redis SET NX lock; later callers
 * either return early on already-confirmed or no-op via lost-race.
 */
export async function fulfillOrder(input: FulfillInput): Promise<FulfillResult> {
  const log = logger.child({ orderId: input.orderId, provider: input.paymentProvider });

  const order = await getOrder(input.orderId);
  if (!order) {
    log.warn("fulfill: order not found");
    return { status: "not-found" };
  }

  if (order.status === "confirmed") {
    log.info("fulfill: already confirmed");
    return { status: "already-confirmed", order };
  }

  const gotLock = await acquireFulfillLock(input.orderId);
  if (!gotLock) {
    log.info("fulfill: lost race for fulfill lock");
    return { status: "lost-race" };
  }

  // Re-read after acquiring the lock — another caller may have flipped the status.
  const fresh = await getOrder(input.orderId);
  if (!fresh) return { status: "not-found" };
  if (fresh.status === "confirmed") return { status: "already-confirmed", order: fresh };

  const product = await getProduct(fresh.productSlug);
  if (!product) {
    log.error({ slug: fresh.productSlug }, "fulfill: product config missing");
    await updateOrder(input.orderId, {
      status: "failed",
      paymentProvider: input.paymentProvider,
      paymentRef: input.paymentRef,
    });
    throw new Error(`Product config missing for slug ${fresh.productSlug}`);
  }
  try {
    const reservation = await scheduler.createReservation({
      itemSlug: fresh.productSlug,
      startISO: fresh.startISO,
      endISO: fresh.endISO,
      quantity: 1,
      bufferMinutes: product.bufferMinutes,
      orderId: fresh.id,
      customer: {
        email: fresh.customer.email,
        name: `${fresh.customer.firstName} ${fresh.customer.lastName}`,
        phone: fresh.customer.phone,
      },
      notes: `Booked via BCC Rentals. Order ${fresh.id}. Payment ${input.paymentProvider}:${input.paymentRef}.`,
    });
    const referenceNumber = reservation.id;

    const confirmed = await updateOrder(input.orderId, {
      status: "confirmed",
      paymentProvider: input.paymentProvider,
      paymentRef: input.paymentRef,
      reservationRef: referenceNumber,
    });

    log.info({ referenceNumber }, "fulfill: reservation created");

    await sendBookingConfirmation({ order: confirmed, product, referenceNumber }).catch((err) => {
      log.error({ err }, "fulfill: confirmation email failed");
    });
    await sendStaffNotification({ order: confirmed, product, referenceNumber }).catch((err) => {
      log.error({ err }, "fulfill: staff notification email failed");
    });

    return { status: "confirmed", order: confirmed };
  } catch (err) {
    if (err instanceof SchedulerConflictError) {
      log.warn({ err }, "fulfill: slot conflict — issuing refund");
      await refundPayment({
        provider: input.paymentProvider,
        paymentRef: input.paymentRef,
        reason: "Slot no longer available",
      }).catch((refundErr) => {
        log.error({ refundErr }, "fulfill: refund failed");
      });
      const refunded = await updateOrder(input.orderId, {
        status: "refunded-conflict",
        paymentProvider: input.paymentProvider,
        paymentRef: input.paymentRef,
      });
      return { status: "refunded-conflict", order: refunded };
    }
    log.error({ err }, "fulfill: unexpected failure");
    throw err;
  }
}
