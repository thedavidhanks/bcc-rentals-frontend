"use client";

import { useMemo, useState } from "react";
import { addDays, addHours, format, parseISO, startOfDay } from "date-fns";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { quote, formatCents, PricingError } from "@/lib/products/pricing";
import type { Product } from "@/lib/products/types";

type Customer = { firstName: string; lastName: string; email: string; phone: string };

function isoStartOfDay(d: Date): string {
  return startOfDay(d).toISOString();
}
function isoNextDayStart(d: Date): string {
  return startOfDay(addDays(d, 1)).toISOString();
}

export function BookingWidget({ product }: { product: Product }) {
  const today = startOfDay(new Date());
  const minDate = addHours(today, product.bookingWindow.minLeadHours);
  const maxDate = addDays(today, product.bookingWindow.maxAdvanceDays);
  // Local const so discriminated-union narrowing on `kind` survives into closures.
  const pricing = product.pricing;

  const [date, setDate] = useState<Date | undefined>();
  const [endDate, setEndDate] = useState<Date | undefined>();
  const [hour, setHour] = useState<number | undefined>();
  const [duration, setDuration] = useState<number>(2);
  const [customer, setCustomer] = useState<Customer>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => {
    if (!date) return null;
    if (product.unit === "full-day") {
      return {
        startISO: isoStartOfDay(date),
        endISO: isoNextDayStart(endDate ?? date),
      };
    }
    if (hour === undefined) return null;
    const start = new Date(date);
    start.setHours(hour, 0, 0, 0);
    const end = new Date(start);
    end.setHours(start.getHours() + duration);
    return { startISO: start.toISOString(), endISO: end.toISOString() };
  }, [date, endDate, hour, duration, product.unit]);

  const priceQuote = useMemo(() => {
    if (!range) return null;
    try {
      return quote(product, range.startISO, range.endISO);
    } catch (err) {
      if (err instanceof PricingError) return { error: err.message };
      throw err;
    }
  }, [range, product]);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email.trim());
  const customerComplete =
    customer.firstName.trim() &&
    customer.lastName.trim() &&
    emailValid &&
    customer.phone.trim().length >= 7;

  const ready = range && priceQuote && "totalCents" in priceQuote && customerComplete && !submitting;

  async function startStripe() {
    if (!range) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/checkout/stripe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: product.slug,
          startISO: range.startISO,
          endISO: range.endISO,
          customer,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Checkout failed");
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checkout failed");
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reserve</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <Label className="mb-2 block">
            {product.unit === "full-day" ? "Pick a date (or range)" : "Pick a date"}
          </Label>
          {product.unit === "full-day" ? (
            <DayPicker
              mode="range"
              disabled={{ before: minDate, after: maxDate }}
              selected={date ? { from: date, to: endDate ?? date } : undefined}
              onSelect={(r) => {
                setDate(r?.from);
                setEndDate(r?.to);
              }}
            />
          ) : (
            <DayPicker
              mode="single"
              disabled={{ before: minDate, after: maxDate }}
              selected={date}
              onSelect={(d) => setDate(d)}
            />
          )}
        </div>

        {product.unit === "hourly" && product.hourlyConstraints && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="mb-2 block">Start hour</Label>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={hour ?? ""}
                onChange={(e) => setHour(e.target.value ? Number(e.target.value) : undefined)}
              >
                <option value="">Choose…</option>
                {Array.from(
                  {
                    length:
                      product.hourlyConstraints.closeHour - product.hourlyConstraints.openHour,
                  },
                  (_, i) => product.hourlyConstraints!.openHour + i,
                ).map((h) => (
                  <option key={h} value={h}>
                    {format(new Date(2000, 0, 1, h), "h:mm a")}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="mb-2 block">Duration (hours)</Label>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              >
                {pricing.kind === "flat-per-hour" &&
                  Array.from(
                    { length: pricing.maxHours - pricing.minHours + 1 },
                    (_, i) => pricing.minHours + i,
                  ).map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
              </select>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="firstName">First name</Label>
            <Input
              id="firstName"
              value={customer.firstName}
              onChange={(e) => setCustomer({ ...customer, firstName: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="lastName">Last name</Label>
            <Input
              id="lastName"
              value={customer.lastName}
              onChange={(e) => setCustomer({ ...customer, lastName: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={customer.email}
              onChange={(e) => setCustomer({ ...customer, email: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <Label htmlFor="phone">Phone</Label>
            <Input
              id="phone"
              type="tel"
              value={customer.phone}
              onChange={(e) => setCustomer({ ...customer, phone: e.target.value })}
            />
          </div>
        </div>

        <div className="rounded-md border bg-muted/50 p-4 text-sm">
          {priceQuote && "totalCents" in priceQuote ? (
            <div className="flex items-center justify-between">
              <span>
                {priceQuote.units} {priceQuote.unitLabel} × {formatCents(priceQuote.unitCents)}
              </span>
              <span className="font-semibold">{formatCents(priceQuote.totalCents)}</span>
            </div>
          ) : priceQuote && "error" in priceQuote ? (
            <span className="text-destructive">{priceQuote.error}</span>
          ) : (
            <span className="text-muted-foreground">Pick a date to see the price.</span>
          )}
        </div>

        {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

        <div className="space-y-3">
          <Button
            type="button"
            size="lg"
            className="w-full"
            disabled={!ready}
            onClick={startStripe}
          >
            Pay with card
          </Button>

          {ready && (
            <PayPalScriptProvider
              options={{
                clientId: process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? "",
                currency: "USD",
                intent: "capture",
                components: "buttons,funding-eligibility",
                "enable-funding": "venmo,paylater",
                "disable-funding": "card",
              }}
            >
              <PayPalButtons
                style={{ layout: "vertical", label: "pay" }}
                createOrder={async () => {
                  const res = await fetch("/api/checkout/paypal/create-order", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      slug: product.slug,
                      startISO: range!.startISO,
                      endISO: range!.endISO,
                      customer,
                    }),
                  });
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error ?? "PayPal create-order failed");
                  return data.paypalOrderId;
                }}
                onApprove={async (data) => {
                  const res = await fetch("/api/checkout/paypal/capture-order", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ paypalOrderId: data.orderID }),
                  });
                  const json = await res.json();
                  if (!res.ok) {
                    setError(json.error ?? "Payment capture failed");
                    return;
                  }
                  window.location.href = `/rentals/confirmation/${json.orderId}`;
                }}
                onError={(err) => {
                  setError(err instanceof Error ? err.message : "PayPal error");
                }}
              />
            </PayPalScriptProvider>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
