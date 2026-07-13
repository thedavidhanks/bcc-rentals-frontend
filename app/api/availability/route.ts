import { NextResponse } from "next/server";
import { z } from "zod";
import { librebooking } from "@/lib/librebooking/client";
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
  if (product.resourceId == null) {
    return NextResponse.json({ error: "Availability lookup failed" }, { status: 502 });
  }

  try {
    const availability = await librebooking.getResourceAvailability({
      resourceId: product.resourceId,
      startDateTime: parsed.data.from,
      endDateTime: parsed.data.to,
    });
    return NextResponse.json({
      product: { slug: product.slug, unit: product.unit },
      reservations: availability.reservations,
    });
  } catch (err) {
    logger.error({ err, slug: parsed.data.slug }, "availability lookup failed");
    return NextResponse.json({ error: "Availability lookup failed" }, { status: 502 });
  }
}
