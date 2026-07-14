import "server-only";
import { Resend } from "resend";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { formatCents } from "@/lib/products/pricing";
import type { Order } from "@/lib/orders/store";
import type { Product } from "@/lib/products/types";
import { renderConfirmationHtml } from "./templates/confirmation";

// Lazy: the Resend constructor throws on a missing key, so defer creation until
// first use rather than at module load — otherwise `next build` (which evaluates
// this module during "Collecting page data" with no secrets) would fail.
let resend: Resend | undefined;
function getResend(): Resend {
  if (!resend) resend = new Resend(env.RESEND_API_KEY);
  return resend;
}

export async function sendBookingConfirmation(input: {
  order: Order;
  product: Product;
  referenceNumber: string;
}): Promise<void> {
  const { order, product, referenceNumber } = input;

  const html = renderConfirmationHtml({
    customerName: `${order.customer.firstName} ${order.customer.lastName}`,
    productName: product.name,
    startISO: order.startISO,
    endISO: order.endISO,
    totalFormatted: formatCents(order.totalCents),
    referenceNumber,
    orderId: order.id,
  });

  const { error } = await getResend().emails.send({
    from: env.EMAIL_FROM,
    to: order.customer.email,
    subject: `Your BCC rental is confirmed — ${product.name}`,
    html,
  });

  if (error) {
    logger.error({ err: error, orderId: order.id }, "Resend send failed");
    throw error;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Notifies BCC staff (STAFF_NOTIFICATION_EMAIL) of a new confirmed reservation.
 * Unlike the customer confirmation this includes customer contact details so
 * staff can reach the renter.
 */
export async function sendStaffNotification(input: {
  order: Order;
  product: Product;
  referenceNumber: string;
}): Promise<void> {
  const { order, product, referenceNumber } = input;
  const c = order.customer;

  const rows: [string, string][] = [
    ["Item", product.name],
    ["From", order.startISO],
    ["Until", order.endISO],
    ["Total", formatCents(order.totalCents)],
    ["Customer", `${c.firstName} ${c.lastName}`],
    ["Email", c.email],
    ["Phone", c.phone],
    ["Reference", referenceNumber],
    ["Order ID", order.id],
  ];
  const html = `<!doctype html><html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
    <h1 style="font-size: 20px;">New reservation — ${escapeHtml(product.name)}</h1>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
      ${rows
        .map(
          ([k, v]) =>
            `<tr><td style="padding: 6px 0;"><strong>${escapeHtml(k)}</strong></td><td>${escapeHtml(v)}</td></tr>`,
        )
        .join("")}
    </table>
  </body></html>`;

  const { error } = await getResend().emails.send({
    from: env.EMAIL_FROM,
    to: env.STAFF_NOTIFICATION_EMAIL,
    subject: `New rental: ${product.name} — ${c.firstName} ${c.lastName}`,
    html,
  });

  if (error) {
    logger.error({ err: error, orderId: order.id }, "Resend staff notification failed");
    throw error;
  }
}
