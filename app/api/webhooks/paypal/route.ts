import { NextResponse } from "next/server";
import { verifyPaypalWebhook } from "@/lib/payments/paypal";
import { fulfillOrder } from "@/lib/orders/fulfill";
import { recordWebhookEvent } from "@/lib/orders/store";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PaypalEvent = {
  id: string;
  event_type: string;
  resource: {
    id?: string;
    custom_id?: string;
    supplementary_data?: {
      related_ids?: { order_id?: string };
    };
    purchase_units?: Array<{
      custom_id?: string;
      payments?: { captures?: Array<{ id: string; custom_id?: string }> };
    }>;
  };
};

function extractIds(event: PaypalEvent): { orderId?: string; captureId?: string } {
  const r = event.resource;
  const captureId =
    r.id ?? r.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? undefined;
  const orderId =
    r.custom_id ??
    r.purchase_units?.[0]?.custom_id ??
    r.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id;
  return { orderId, captureId };
}

export async function POST(request: Request) {
  const rawBody = await request.text();

  const verified = await verifyPaypalWebhook({ headers: request.headers, rawBody });
  if (!verified) {
    logger.warn("paypal webhook signature failed");
    return NextResponse.json({ error: "Bad signature" }, { status: 400 });
  }

  let event: PaypalEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const fresh = await recordWebhookEvent("paypal", event.id);
  if (!fresh) {
    return NextResponse.json({ received: true, dedup: true });
  }

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const { orderId, captureId } = extractIds(event);
    if (!orderId || !captureId) {
      logger.error({ event: event.id }, "paypal webhook missing orderId or capture id");
      return NextResponse.json({ error: "Missing identifiers" }, { status: 400 });
    }
    try {
      await fulfillOrder({ orderId, paymentProvider: "paypal", paymentRef: captureId });
    } catch (err) {
      logger.error({ err, orderId }, "paypal fulfill failed");
      return NextResponse.json({ error: "Fulfillment failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ received: true });
}
