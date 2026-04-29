import "server-only";
import { z } from "zod";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getSession, invalidateSession } from "./session";
import {
  LibreBookingAuthError,
  LibreBookingConflictError,
  LibreBookingError,
} from "./errors";
import {
  availabilityResponseSchema,
  createReservationInputSchema,
  createReservationResponseSchema,
  createUserResponseSchema,
  resourceSchema,
  userListResponseSchema,
  type AvailabilityResponse,
  type CreateReservationInput,
  type Resource,
} from "./types";

const API_PREFIX = "/Web/Services/index.php";

type RequestOpts = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  searchParams?: Record<string, string | number | undefined>;
};

async function call<T>(path: string, schema: z.ZodSchema<T>, opts: RequestOpts = {}): Promise<T> {
  const make = async (retryAfter401: boolean): Promise<T> => {
    const session = await getSession();
    const url = new URL(`${env.LIBREBOOKING_BASE_URL}${API_PREFIX}${path}`);
    if (opts.searchParams) {
      for (const [k, v] of Object.entries(opts.searchParams)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(url.toString(), {
      method: opts.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Booked-SessionToken": session.token,
        "X-Booked-UserId": String(session.userId),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
    });

    if (res.status === 401 && retryAfter401) {
      invalidateSession();
      return make(false);
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new LibreBookingError(`Non-JSON response from ${path}`, res.status, path, text);
    }

    if (res.status === 401) throw new LibreBookingAuthError(path, json);
    if (res.status === 409) throw new LibreBookingConflictError(path, json);
    if (!res.ok) {
      throw new LibreBookingError(`LibreBooking ${res.status} ${path}`, res.status, path, json);
    }

    return schema.parse(json);
  };

  return make(true);
}

export const librebooking = {
  async getResource(resourceId: number): Promise<Resource> {
    return call(`/Resources/${resourceId}`, resourceSchema);
  },

  async getResourceAvailability(input: {
    resourceId: number;
    startDateTime: string;
    endDateTime: string;
  }): Promise<AvailabilityResponse> {
    return call(`/Resources/${input.resourceId}/Availability`, availabilityResponseSchema, {
      searchParams: {
        dateTime: input.startDateTime,
        endDateTime: input.endDateTime,
      },
    });
  },

  async createReservation(input: CreateReservationInput): Promise<{ referenceNumber: string }> {
    const body = createReservationInputSchema.parse(input);
    const result = await call("/Reservations/", createReservationResponseSchema, {
      method: "POST",
      body,
    });
    if (!result.referenceNumber) {
      const conflict = result.errors.some((e) => /conflict/i.test(e));
      if (conflict) throw new LibreBookingConflictError("/Reservations/", result);
      throw new LibreBookingError(
        result.message ?? "Reservation creation failed",
        500,
        "/Reservations/",
        result,
      );
    }
    return { referenceNumber: result.referenceNumber };
  },

  async findOrCreateUser(input: {
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
  }): Promise<{ userId: number }> {
    const lookup = await call("/Users/", userListResponseSchema, {
      searchParams: { username: input.email },
    });
    const existing = lookup.users.find((u) => u.emailAddress?.toLowerCase() === input.email.toLowerCase());
    if (existing) return { userId: existing.userId };

    const created = await call("/Users/", createUserResponseSchema, {
      method: "POST",
      body: {
        userName: input.email,
        emailAddress: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        password: crypto.randomUUID() + crypto.randomUUID(),
        timezone: "America/Chicago",
        language: "en_us",
        phone: input.phone,
      },
    });

    if (!created.userId) {
      throw new LibreBookingError(
        created.message ?? "User creation failed",
        500,
        "/Users/",
        created,
      );
    }

    logger.info({ email: input.email, userId: created.userId }, "Created LibreBooking user");
    return { userId: created.userId };
  },
};
