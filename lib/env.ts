import "server-only";
import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.url(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  PAYPAL_ENV: z.enum(["sandbox", "live"]),
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_WEBHOOK_ID: z.string().min(1),
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: z.string().min(1),

  RESEND_API_KEY: z.string().startsWith("re_"),
  EMAIL_FROM: z.string().min(1),
  STAFF_NOTIFICATION_EMAIL: z.string().min(1),

  UPSTASH_REDIS_REST_URL: z.url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),

  // Neon Postgres (scheduler system of record). DATABASE_URL is the runtime
  // (pooled) connection; DATABASE_URL_DEV is the dev-branch direct endpoint used
  // for DDL/tooling only, so it's optional at app boot.
  DATABASE_URL: z.url(),
  DATABASE_URL_DEV: z.url().optional(),
});

// `SKIP_ENV_VALIDATION=1` bypasses the parse so `next build` (and CI/typecheck)
// can run without real secrets — e.g. the Docker builder stage. The container's
// runner stage leaves the flag unset, so real env is still validated at boot.
// Safe because every DB/product route is force-dynamic: nothing renders or
// queries the DB during the build.
const parsed = process.env.SKIP_ENV_VALIDATION
  ? { success: true as const, data: process.env as unknown as z.infer<typeof envSchema> }
  : envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", z.treeifyError(parsed.error));
  throw new Error("Invalid environment variables — see logs above.");
}

export const env = parsed.data;
