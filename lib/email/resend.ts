import "server-only";
import { Resend } from "resend";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { formatCents } from "@/lib/products/pricing";
import type { Order } from "@/lib/orders/store";
import type { Product } from "@/lib/products/types";
import { renderConfirmationHtml } from "./templates/confirmation";

const resend = new Resend(env.RESEND_API_KEY);

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

  const { error } = await resend.emails.send({
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
