import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { getStripe } from "@/lib/payments/stripe";
import { preflightCheckout, PreflightError } from "@/lib/orders/preflight";
import { customerSchema } from "@/lib/orders/store";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const bodySchema = z.object({
  slug: z.string().min(1),
  startISO: z.string().datetime({ offset: true }),
  endISO: z.string().datetime({ offset: true }),
  customer: customerSchema,
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: z.treeifyError(parsed.error) },
      { status: 400 },
    );
  }

  try {
    const { orderId, totalCents, productName } = await preflightCheckout(parsed.data);

    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      client_reference_id: orderId,
      customer_email: parsed.data.customer.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            product_data: { name: productName },
            unit_amount: totalCents,
          },
        },
      ],
      metadata: { orderId },
      payment_intent_data: { metadata: { orderId } },
      success_url: `${env.NEXT_PUBLIC_SITE_URL}/rentals/confirmation/${orderId}`,
      cancel_url: `${env.NEXT_PUBLIC_SITE_URL}/rentals/${parsed.data.slug}?canceled=1`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    if (err instanceof PreflightError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error({ err }, "stripe checkout failed");
    return NextResponse.json({ error: "Checkout failed" }, { status: 500 });
  }
}
