import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { createPaypalOrder } from "@/lib/payments/paypal";
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
    const paypalOrder = await createPaypalOrder({
      orderId,
      amountUsdCents: totalCents,
      description: `BCC Rentals: ${productName}`,
      returnUrl: `${env.NEXT_PUBLIC_SITE_URL}/rentals/confirmation/${orderId}`,
      cancelUrl: `${env.NEXT_PUBLIC_SITE_URL}/rentals/${parsed.data.slug}?canceled=1`,
    });
    return NextResponse.json({ orderId, paypalOrderId: paypalOrder.id });
  } catch (err) {
    if (err instanceof PreflightError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error({ err }, "paypal create-order failed");
    return NextResponse.json({ error: "Checkout failed" }, { status: 500 });
  }
}
