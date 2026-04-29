import Link from "next/link";
import { format, parseISO } from "date-fns";
import { getOrder } from "@/lib/orders/store";
import { getProduct } from "@/lib/products/config";
import { formatCents } from "@/lib/products/pricing";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function ConfirmationPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const order = await getOrder(orderId);

  if (!order) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>We couldn&apos;t find that order</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground">
            The reference may have expired. If you completed payment, an email confirmation will arrive shortly.
            Otherwise, please contact{" "}
            <a href="mailto:reservations@bachmancc.org" className="underline">
              reservations@bachmancc.org
            </a>
            .
          </p>
          <Link href="/">
            <Button variant="outline">Back to rentals</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  const product = getProduct(order.productSlug);
  const productName = product?.name ?? order.productSlug;

  if (order.status === "pending") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Processing your reservation…</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground">
            Payment was received. We&apos;re finalizing the booking — this page will refresh automatically.
          </p>
          <meta httpEquiv="refresh" content="3" />
        </CardContent>
      </Card>
    );
  }

  if (order.status === "refunded-conflict") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>That slot was taken — refund issued</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground">
            Someone else booked this slot moments before your payment cleared. We&apos;ve refunded you in full
            ({formatCents(order.totalCents)}).
          </p>
          <Link href={`/rentals/${order.productSlug}`}>
            <Button>Try another time</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (order.status === "failed") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Something went wrong</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground">
            We hit an error finalizing your booking. BCC staff have been notified. Please email{" "}
            <a href="mailto:reservations@bachmancc.org" className="underline">
              reservations@bachmancc.org
            </a>{" "}
            with your order ID: <code>{order.id}</code>.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reservation confirmed</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p>Thanks {order.customer.firstName}! A confirmation email is on its way.</p>
        <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Item</dt>
          <dd>{productName}</dd>
          <dt className="text-muted-foreground">From</dt>
          <dd>{format(parseISO(order.startISO), "EEE, MMM d, yyyy 'at' h:mm a")}</dd>
          <dt className="text-muted-foreground">Until</dt>
          <dd>{format(parseISO(order.endISO), "EEE, MMM d, yyyy 'at' h:mm a")}</dd>
          <dt className="text-muted-foreground">Total</dt>
          <dd>{formatCents(order.totalCents)}</dd>
          {order.reservationRef && (
            <>
              <dt className="text-muted-foreground">Reference</dt>
              <dd>
                <code>{order.reservationRef}</code>
              </dd>
            </>
          )}
        </dl>
        <Link href="/">
          <Button variant="outline">Back to rentals</Button>
        </Link>
      </CardContent>
    </Card>
  );
}
