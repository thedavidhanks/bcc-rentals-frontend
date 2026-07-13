import { z } from "zod";

export const reservationStatusSchema = z.enum(["confirmed", "block", "cancelled"]);
export type ReservationStatus = z.infer<typeof reservationStatusSchema>;

export const itemTypeSchema = z.enum(["unique", "fungible"]);
export type ItemType = z.infer<typeof itemTypeSchema>;

/** Customer details embedded on a reservation (no separate users table). */
export const reservationCustomerSchema = z.object({
  email: z.email().optional(),
  name: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
});
export type ReservationCustomer = z.infer<typeof reservationCustomerSchema>;

const isoOffset = z.string().datetime({ offset: true });
const endAfterStart = (d: { startISO: string; endISO: string }) =>
  new Date(d.endISO).getTime() > new Date(d.startISO).getTime();
const endAfterStartMsg = { message: "endISO must be after startISO", path: ["endISO"] };

export const getAvailabilityInputSchema = z
  .object({
    itemSlug: z.string().min(1),
    startISO: isoOffset,
    endISO: isoOffset,
    quantity: z.number().int().positive().default(1),
    bufferMinutes: z.number().int().nonnegative().default(0),
  })
  .refine(endAfterStart, endAfterStartMsg);
export type GetAvailabilityInput = z.input<typeof getAvailabilityInputSchema>;

export const createReservationInputSchema = z
  .object({
    itemSlug: z.string().min(1),
    startISO: isoOffset,
    endISO: isoOffset,
    quantity: z.number().int().positive().default(1),
    bufferMinutes: z.number().int().nonnegative().default(0),
    status: reservationStatusSchema.default("confirmed"),
    orderId: z.string().min(1).optional(),
    customer: reservationCustomerSchema.optional(),
    notes: z.string().optional(),
  })
  .refine(endAfterStart, endAfterStartMsg);
export type CreateReservationInput = z.input<typeof createReservationInputSchema>;

/** A reservation as returned by the client (camelCase, ISO strings). */
export type Reservation = {
  id: string;
  itemId: string;
  itemSlug: string;
  quantity: number;
  startISO: string;
  endISO: string;
  status: ReservationStatus;
  orderId: string | null;
  customer: { email: string | null; name: string | null; phone: string | null };
  notes: string | null;
  createdAt: string;
};

/** Availability for an item over a window, plus the overlapping reservations. */
export type Availability = {
  itemSlug: string;
  itemId: string;
  totalStock: number;
  requested: number;
  reserved: number;
  available: number;
  isAvailable: boolean;
  reservations: Reservation[];
};
