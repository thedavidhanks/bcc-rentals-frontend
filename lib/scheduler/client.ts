import "server-only";
import { getPool, withTransaction } from "./db";
import { SchedulerConflictError, SchedulerError } from "./errors";
import {
  createReservationInputSchema,
  getAvailabilityInputSchema,
  type Availability,
  type CreateReservationInput,
  type GetAvailabilityInput,
  type Reservation,
  type ReservationStatus,
} from "./types";

// Overlap predicate (half-open intervals): a stored reservation overlaps the
// requested [start, end) window unless it ends at/before start or starts at/after
// end. `status <> 'cancelled'` matches the partial index reservations_item_time_idx.
const OVERLAP = "status <> 'cancelled' AND NOT (end_at <= $2 OR start_at >= $3)";

type ReservationRow = {
  id: string;
  item_id: string;
  quantity: number;
  start_at: Date;
  end_at: Date;
  status: ReservationStatus;
  order_id: string | null;
  customer_email: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  notes: string | null;
  created_at: Date;
};

const toISO = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

// Shifts an ISO timestamp by `minutes` (may be negative). Used to widen the
// overlap window by an item's buffer so bookings can't butt up against each other.
const shiftISO = (iso: string, minutes: number): string =>
  new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();

function mapReservation(row: ReservationRow, itemSlug: string): Reservation {
  return {
    id: row.id,
    itemId: row.item_id,
    itemSlug,
    quantity: row.quantity,
    startISO: toISO(row.start_at),
    endISO: toISO(row.end_at),
    status: row.status,
    orderId: row.order_id,
    customer: {
      email: row.customer_email,
      name: row.customer_name,
      phone: row.customer_phone,
    },
    notes: row.notes,
    createdAt: toISO(row.created_at),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const scheduler = {
  /**
   * Availability for `itemSlug` over [startISO, endISO). Returns the overlapping
   * non-cancelled reservations plus aggregate capacity. `isAvailable` is only
   * meaningful when the window is an exact booking slot (as in preflight); for a
   * wide calendar query, use `reservations`.
   */
  async getAvailability(input: GetAvailabilityInput): Promise<Availability> {
    const { itemSlug, startISO, endISO, quantity, bufferMinutes } = getAvailabilityInputSchema.parse(input);
    const pool = getPool();

    const itemRes = await pool.query<{ id: string; total_stock: number }>(
      "SELECT id, total_stock FROM items WHERE slug = $1",
      [itemSlug],
    );
    const item = itemRes.rows[0];
    if (!item) throw new SchedulerError(`Unknown item: ${itemSlug}`);

    const resvRes = await pool.query<ReservationRow>(
      `SELECT * FROM reservations WHERE item_id = $1 AND ${OVERLAP} ORDER BY start_at`,
      [item.id, shiftISO(startISO, -bufferMinutes), shiftISO(endISO, bufferMinutes)],
    );
    const reservations = resvRes.rows.map((r) => mapReservation(r, itemSlug));
    const reserved = reservations.reduce((sum, r) => sum + r.quantity, 0);
    const available = item.total_stock - reserved;

    return {
      itemSlug,
      itemId: item.id,
      totalStock: item.total_stock,
      requested: quantity,
      reserved,
      available,
      isAvailable: available >= quantity,
      reservations,
    };
  },

  /**
   * Creates a reservation after re-checking capacity, atomically. A per-item
   * advisory lock held for the transaction serializes concurrent bookings of the
   * same item, so the availability check and insert cannot race. Throws
   * SchedulerConflictError when capacity is exhausted.
   */
  async createReservation(input: CreateReservationInput): Promise<Reservation> {
    const data = createReservationInputSchema.parse(input);

    return withTransaction(async (client) => {
      // Serialize all writers for this item until commit/rollback.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), 0)", [data.itemSlug]);

      const itemRes = await client.query<{ id: string; total_stock: number }>(
        "SELECT id, total_stock FROM items WHERE slug = $1",
        [data.itemSlug],
      );
      const item = itemRes.rows[0];
      if (!item) throw new SchedulerError(`Unknown item: ${data.itemSlug}`);

      const capRes = await client.query<{ reserved: number }>(
        `SELECT COALESCE(SUM(quantity), 0)::int AS reserved FROM reservations WHERE item_id = $1 AND ${OVERLAP}`,
        [item.id, shiftISO(data.startISO, -data.bufferMinutes), shiftISO(data.endISO, data.bufferMinutes)],
      );
      const reserved = capRes.rows[0].reserved;
      if (reserved + data.quantity > item.total_stock) {
        throw new SchedulerConflictError(
          `No capacity for ${data.itemSlug}: requested ${data.quantity}, ${item.total_stock - reserved} available`,
          { itemSlug: data.itemSlug, requested: data.quantity, available: item.total_stock - reserved },
        );
      }

      const ins = await client.query<ReservationRow>(
        `INSERT INTO reservations
           (item_id, quantity, start_at, end_at, status, order_id, customer_email, customer_name, customer_phone, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          item.id,
          data.quantity,
          data.startISO,
          data.endISO,
          data.status,
          data.orderId ?? null,
          data.customer?.email ?? null,
          data.customer?.name ?? null,
          data.customer?.phone ?? null,
          data.notes ?? null,
        ],
      );
      return mapReservation(ins.rows[0], data.itemSlug);
    });
  },

  /** Fetches a reservation by id, or null if not found (or id isn't a uuid). */
  async getReservation(id: string): Promise<Reservation | null> {
    if (!UUID_RE.test(id)) return null;
    const res = await getPool().query<ReservationRow & { item_slug: string }>(
      `SELECT r.*, i.slug AS item_slug
         FROM reservations r JOIN items i ON i.id = r.item_id
        WHERE r.id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? mapReservation(row, row.item_slug) : null;
  },

  /**
   * Cancels a reservation (sets status = 'cancelled'), freeing its capacity.
   * Idempotent; returns the updated reservation, or null if the id is unknown.
   */
  async cancelReservation(id: string): Promise<Reservation | null> {
    if (!UUID_RE.test(id)) return null;
    const res = await getPool().query<ReservationRow & { item_slug: string }>(
      `UPDATE reservations r SET status = 'cancelled'
         FROM items i
        WHERE r.id = $1 AND i.id = r.item_id
        RETURNING r.*, i.slug AS item_slug`,
      [id],
    );
    const row = res.rows[0];
    return row ? mapReservation(row, row.item_slug) : null;
  },
};
