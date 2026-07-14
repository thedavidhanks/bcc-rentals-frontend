import "server-only";
import Stripe from "stripe";
import { env } from "@/lib/env";

// Lazy: `new Stripe(undefined)` throws, so defer creation until first use rather
// than at module load — otherwise `next build` (which evaluates the checkout /
// webhook routes during "Collecting page data" with no secrets) would fail.
// Uses the SDK's default pinned API version (matches the installed SDK).
let stripe: Stripe | undefined;
export function getStripe(): Stripe {
  if (!stripe) stripe = new Stripe(env.STRIPE_SECRET_KEY, { typescript: true });
  return stripe;
}
