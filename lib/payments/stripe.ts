import "server-only";
import Stripe from "stripe";
import { env } from "@/lib/env";

// Use the SDK's default pinned API version (matches the installed @stripe/stripe SDK).
export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  typescript: true,
});
