import { NextResponse } from "next/server";
import { createEvents, type DateArray, type EventAttributes } from "ics";
import { scheduler } from "@/lib/scheduler/client";
import { getProduct } from "@/lib/products/repository";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ics DateArray is [year, month(1-12), day, hour, minute]; feed UTC parts with
// {start,end}InputType: "utc" so subscribers see the true reservation window.
function toUtcArray(iso: string): DateArray {
  const d = new Date(iso);
  return [
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
  ];
}

/**
 * ICS calendar feed for an item's occupied windows, for staff to subscribe to.
 * Public/unauthenticated, so it carries NO customer PII — only the item name,
 * reserved quantity, and the time window.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ itemSlug: string }> },
) {
  const { itemSlug } = await params;

  const product = await getProduct(itemSlug);
  if (!product) return NextResponse.json({ error: "Unknown product" }, { status: 404 });

  try {
    const now = new Date();
    const to = new Date(now.getTime() + product.bookingWindow.maxAdvanceDays * 86_400_000);
    const availability = await scheduler.getAvailability({
      itemSlug: product.slug,
      startISO: now.toISOString(),
      endISO: to.toISOString(),
    });

    const events: EventAttributes[] = availability.reservations.map((r) => ({
      uid: `${r.id}@bccrentals`,
      title: `${product.name} — reserved`,
      description:
        product.type === "fungible" ? `Reserved quantity: ${r.quantity}` : "Reserved",
      start: toUtcArray(r.startISO),
      startInputType: "utc",
      end: toUtcArray(r.endISO),
      endInputType: "utc",
      status: "CONFIRMED",
      productId: "bcc-rentals",
      calName: `${product.name} availability`,
    }));

    const { error, value } = createEvents(events);
    if (error || value == null) {
      logger.error({ err: error, slug: itemSlug }, "ICS generation failed");
      return NextResponse.json({ error: "Calendar generation failed" }, { status: 500 });
    }

    return new NextResponse(value, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `inline; filename="${product.slug}.ics"`,
      },
    });
  } catch (err) {
    logger.error({ err, slug: itemSlug }, "calendar feed failed");
    return NextResponse.json({ error: "Calendar feed failed" }, { status: 502 });
  }
}
