import "server-only";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

const BASE = env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  const credentials = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString(
    "base64",
  );
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

async function paypalFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    logger.error({ path, status: res.status, body: json }, "PayPal API error");
    throw new Error(`PayPal ${path} failed: ${res.status}`);
  }
  return json as T;
}

export type CreateOrderInput = {
  orderId: string;
  amountUsdCents: number;
  description: string;
  returnUrl: string;
  cancelUrl: string;
};

export async function createPaypalOrder(input: CreateOrderInput): Promise<{ id: string }> {
  const dollars = (input.amountUsdCents / 100).toFixed(2);
  return paypalFetch("/v2/checkout/orders", {
    method: "POST",
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          custom_id: input.orderId,
          description: input.description,
          amount: { currency_code: "USD", value: dollars },
        },
      ],
      application_context: {
        brand_name: "Bachman Community Center",
        user_action: "PAY_NOW",
        return_url: input.returnUrl,
        cancel_url: input.cancelUrl,
      },
    }),
  });
}

export type CapturedOrder = {
  id: string;
  status: string;
  purchase_units: Array<{
    custom_id?: string;
    payments?: { captures?: Array<{ id: string; status: string; custom_id?: string }> };
  }>;
};

export async function capturePaypalOrder(paypalOrderId: string): Promise<CapturedOrder> {
  return paypalFetch(`/v2/checkout/orders/${paypalOrderId}/capture`, { method: "POST" });
}

export async function getPaypalOrder(paypalOrderId: string): Promise<CapturedOrder> {
  return paypalFetch(`/v2/checkout/orders/${paypalOrderId}`);
}

export async function refundPaypalCapture(captureId: string, reason?: string): Promise<void> {
  await paypalFetch(`/v2/payments/captures/${captureId}/refund`, {
    method: "POST",
    body: JSON.stringify(reason ? { note_to_payer: reason } : {}),
  });
}

export type WebhookVerifyInput = {
  headers: Headers;
  rawBody: string;
};

export async function verifyPaypalWebhook(input: WebhookVerifyInput): Promise<boolean> {
  const auth_algo = input.headers.get("paypal-auth-algo");
  const cert_url = input.headers.get("paypal-cert-url");
  const transmission_id = input.headers.get("paypal-transmission-id");
  const transmission_sig = input.headers.get("paypal-transmission-sig");
  const transmission_time = input.headers.get("paypal-transmission-time");
  if (!auth_algo || !cert_url || !transmission_id || !transmission_sig || !transmission_time) {
    return false;
  }
  const result = await paypalFetch<{ verification_status: string }>(
    "/v1/notifications/verify-webhook-signature",
    {
      method: "POST",
      body: JSON.stringify({
        auth_algo,
        cert_url,
        transmission_id,
        transmission_sig,
        transmission_time,
        webhook_id: env.PAYPAL_WEBHOOK_ID,
        webhook_event: JSON.parse(input.rawBody),
      }),
    },
  );
  return result.verification_status === "SUCCESS";
}
