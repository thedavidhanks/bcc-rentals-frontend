import "server-only";
import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.url(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  LIBREBOOKING_BASE_URL: z.url(),
  LIBREBOOKING_SERVICE_USER: z.string().min(1),
  LIBREBOOKING_SERVICE_PASS: z.string().min(1),
  LB_RESOURCE_ID_TENT: z.coerce.number().int().positive(),
  LB_RESOURCE_ID_POPCORN: z.coerce.number().int().positive(),
  LB_RESOURCE_ID_PARTY_ROOM: z.coerce.number().int().positive(),

  STRIPE_SECRET_KEY: z.string().startsWith("sk_"),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().startsWith("pk_"),

  PAYPAL_ENV: z.enum(["sandbox", "live"]),
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_WEBHOOK_ID: z.string().min(1),
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: z.string().min(1),

  RESEND_API_KEY: z.string().startsWith("re_"),
  EMAIL_FROM: z.string().min(1),

  UPSTASH_REDIS_REST_URL: z.url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),

  // Neon Postgres (scheduler system of record). DATABASE_URL is the runtime
  // (pooled) connection; DATABASE_URL_DEV is the dev-branch direct endpoint used
  // for DDL/tooling only, so it's optional at app boot.
  DATABASE_URL: z.url(),
  DATABASE_URL_DEV: z.url().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", z.treeifyError(parsed.error));
  throw new Error("Invalid environment variables — see logs above.");
}

export const env = parsed.data;
