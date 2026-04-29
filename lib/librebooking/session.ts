import "server-only";
import { env } from "@/lib/env";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { authResponseSchema } from "./types";
import { LibreBookingAuthError } from "./errors";

export type Session = {
  token: string;
  userId: number;
  expiresAt: number;
};

const REDIS_KEY = "lb:session";
const TTL_SECONDS = 20 * 60;

let memo: Session | null = null;
let inflight: Promise<Session> | null = null;

function isFresh(s: Session | null): s is Session {
  return !!s && s.expiresAt > Date.now() + 60_000;
}

export function invalidateSession(): void {
  memo = null;
  void redis.del(REDIS_KEY);
}

async function authenticate(): Promise<Session> {
  const url = `${env.LIBREBOOKING_BASE_URL}/Web/Services/index.php/Authentication/Authenticate`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: env.LIBREBOOKING_SERVICE_USER,
      password: env.LIBREBOOKING_SERVICE_PASS,
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new LibreBookingAuthError(url, await res.text().catch(() => undefined));
  }

  const json = await res.json();
  const parsed = authResponseSchema.parse(json);

  if (!parsed.isAuthenticated || !parsed.sessionToken || !parsed.userId) {
    throw new LibreBookingAuthError(url, parsed);
  }

  const session: Session = {
    token: parsed.sessionToken,
    userId: parsed.userId,
    expiresAt: Date.now() + TTL_SECONDS * 1000,
  };

  memo = session;
  await redis.set(REDIS_KEY, session, { ex: TTL_SECONDS });
  logger.info({ userId: session.userId }, "LibreBooking session refreshed");

  return session;
}

export async function getSession(): Promise<Session> {
  if (isFresh(memo)) return memo;

  const cached = await redis.get<Session>(REDIS_KEY);
  if (isFresh(cached)) {
    memo = cached;
    return cached;
  }

  if (inflight) return inflight;
  inflight = authenticate().finally(() => {
    inflight = null;
  });
  return inflight;
}
