import { NextResponse } from "next/server";
import { z } from "zod";
import { scheduler } from "@/lib/scheduler/client";
import { getProduct } from "@/lib/products/repository";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  slug: z.string().min(1),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    slug: url.searchParams.get("slug"),
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", details: z.treeifyError(parsed.error) },
      { status: 400 },
    );
  }

  const product = await getProduct(parsed.data.slug);
  if (!product) return NextResponse.json({ error: "Unknown product" }, { status: 404 });

  try {
    const availability = await scheduler.getAvailability({
      itemSlug: product.slug,
      startISO: parsed.data.from,
      endISO: parsed.data.to,
    });
    // Public, unauthenticated endpoint — return only the occupied windows, never
    // customer PII (email/name/phone) carried on the reservation rows.
    return NextResponse.json({
      product: { slug: product.slug, unit: product.unit },
      totalStock: availability.totalStock,
      reservations: availability.reservations.map((r) => ({
        startISO: r.startISO,
        endISO: r.endISO,
        quantity: r.quantity,
        status: r.status,
      })),
    });
  } catch (err) {
    logger.error({ err, slug: parsed.data.slug }, "availability lookup failed");
    return NextResponse.json({ error: "Availability lookup failed" }, { status: 502 });
  }
}
