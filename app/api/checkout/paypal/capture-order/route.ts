import { NextResponse } from "next/server";
import { z } from "zod";
import { capturePaypalOrder } from "@/lib/payments/paypal";
import { fulfillOrder } from "@/lib/orders/fulfill";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const bodySchema = z.object({
  paypalOrderId: z.string().min(1),
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const captured = await capturePaypalOrder(parsed.data.paypalOrderId);
    const capture = captured.purchase_units?.[0]?.payments?.captures?.[0];
    // In a capture response PayPal echoes custom_id on the capture object; the
    // purchase-unit-level custom_id is a fallback for other response shapes.
    const orderId = capture?.custom_id ?? captured.purchase_units?.[0]?.custom_id;
    const captureId = capture?.id;
    if (!orderId || !captureId) {
      logger.error({ captured }, "paypal capture missing custom_id or capture id");
      return NextResponse.json({ error: "Malformed PayPal response" }, { status: 502 });
    }

    const result = await fulfillOrder({
      orderId,
      paymentProvider: "paypal",
      paymentRef: captureId,
    });

    if (result.status === "not-found") {
      return NextResponse.json({ error: "Order expired" }, { status: 404 });
    }
    if (result.status === "refunded-conflict") {
      return NextResponse.json(
        { error: "Slot was just taken — your payment was refunded.", orderId },
        { status: 409 },
      );
    }
    return NextResponse.json({ orderId, status: result.status });
  } catch (err) {
    logger.error({ err }, "paypal capture failed");
    return NextResponse.json({ error: "Capture failed" }, { status: 500 });
  }
}
