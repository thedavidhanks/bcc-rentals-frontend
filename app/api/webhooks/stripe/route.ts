import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { env } from "@/lib/env";
import { stripe } from "@/lib/payments/stripe";
import { fulfillOrder } from "@/lib/orders/fulfill";
import { recordWebhookEvent } from "@/lib/orders/store";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 400 });

  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.warn({ err }, "stripe webhook signature failed");
    return NextResponse.json({ error: "Bad signature" }, { status: 400 });
  }

  const fresh = await recordWebhookEvent("stripe", event.id);
  if (!fresh) {
    return NextResponse.json({ received: true, dedup: true });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const orderId = session.metadata?.orderId ?? session.client_reference_id;
    const paymentIntent =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id;

    if (!orderId || !paymentIntent) {
      logger.error({ event: event.id }, "stripe webhook missing orderId or payment intent");
      return NextResponse.json({ error: "Missing metadata" }, { status: 400 });
    }

    try {
      await fulfillOrder({
        orderId,
        paymentProvider: "stripe",
        paymentRef: paymentIntent,
      });
    } catch (err) {
      logger.error({ err, orderId }, "stripe fulfill failed");
      return NextResponse.json({ error: "Fulfillment failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ received: true });
}
