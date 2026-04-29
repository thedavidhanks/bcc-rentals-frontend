import { z } from "zod";

export const authResponseSchema = z.object({
  isAuthenticated: z.boolean(),
  sessionToken: z.string().nullish(),
  sessionExpires: z.string().nullish(),
  userId: z.coerce.number().int().nullish(),
  message: z.string().nullish(),
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

export const resourceSchema = z.object({
  resourceId: z.number().int(),
  name: z.string(),
  scheduleId: z.number().int().nullish(),
  description: z.string().nullish(),
  contact: z.string().nullish(),
  location: z.string().nullish(),
  notes: z.string().nullish(),
  minLength: z.string().nullish(),
  maxLength: z.string().nullish(),
});
export type Resource = z.infer<typeof resourceSchema>;

export const reservationSlotSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  startTime: z.string().nullish(),
  endTime: z.string().nullish(),
  resourceId: z.number().int().nullish(),
  referenceNumber: z.string().nullish(),
});
export type ReservationSlot = z.infer<typeof reservationSlotSchema>;

export const availabilityResponseSchema = z.object({
  resourceId: z.number().int().nullish(),
  availableAt: z.string().nullish(),
  availableUntil: z.string().nullish(),
  reservations: z.array(reservationSlotSchema).default([]),
});
export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;

export const createReservationInputSchema = z.object({
  startDateTime: z.string(),
  endDateTime: z.string(),
  resourceId: z.number().int(),
  userId: z.number().int(),
  title: z.string(),
  description: z.string().optional(),
  customAttributes: z
    .array(z.object({ attributeId: z.number().int(), attributeValue: z.string() }))
    .optional(),
});
export type CreateReservationInput = z.infer<typeof createReservationInputSchema>;

export const createReservationResponseSchema = z.object({
  referenceNumber: z.string().nullish(),
  message: z.string().nullish(),
  errors: z.array(z.string()).default([]),
});
export type CreateReservationResponse = z.infer<typeof createReservationResponseSchema>;

export const userSchema = z.object({
  userId: z.coerce.number().int(),
  userName: z.string().nullish(),
  emailAddress: z.string().nullish(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
});
export type User = z.infer<typeof userSchema>;

export const userListResponseSchema = z.object({
  users: z.array(userSchema).default([]),
});

export const createUserResponseSchema = z.object({
  userId: z.coerce.number().int().nullish(),
  message: z.string().nullish(),
  errors: z.array(z.string()).default([]),
});
