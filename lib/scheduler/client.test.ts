import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Postgres seam so no real pg Pool (or env boot validation) is exercised.
// `getPool().query` and the transaction client's `query` are separate vi.fns so
// tests can enqueue per-call results and assert query order/params.
const poolQuery = vi.fn();
const txQuery = vi.fn();

vi.mock("./db", () => ({
  getPool: () => ({ query: poolQuery }),
  // Pass-through: invoke fn with a mock client, rethrow on error like the real impl.
  withTransaction: (fn: (client: { query: typeof txQuery }) => Promise<unknown>) => fn({ query: txQuery }),
}));

import { scheduler } from "./client";
import { SchedulerConflictError, SchedulerError } from "./errors";
import type { ReservationStatus } from "./types";

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
  item_slug?: string;
};

const START = "2026-08-01T14:00:00.000Z";
const END = "2026-08-01T16:00:00.000Z";
const UUID = "11111111-1111-4111-8111-111111111111";

function makeRow(overrides: Partial<ReservationRow> = {}): ReservationRow {
  return {
    id: UUID,
    item_id: "item-1",
    quantity: 1,
    start_at: new Date(START),
    end_at: new Date(END),
    status: "confirmed",
    order_id: null,
    customer_email: null,
    customer_name: null,
    customer_phone: null,
    notes: null,
    created_at: new Date("2026-07-10T00:00:00.000Z"),
    ...overrides,
  };
}

// Convenience: a pg-shaped result.
const rows = <T>(...r: T[]) => ({ rows: r });

beforeEach(() => {
  poolQuery.mockReset();
  txQuery.mockReset();
});

describe("scheduler.getAvailability", () => {
  it("returns full stock when there are no overlapping reservations", async () => {
    poolQuery
      .mockResolvedValueOnce(rows({ id: "item-1", total_stock: 1 })) // item lookup
      .mockResolvedValueOnce(rows()); // overlapping reservations

    const res = await scheduler.getAvailability({ itemSlug: "tent", startISO: START, endISO: END });

    expect(res).toMatchObject({
      itemSlug: "tent",
      itemId: "item-1",
      totalStock: 1,
      requested: 1,
      reserved: 0,
      available: 1,
      isAvailable: true,
    });
    expect(res.reservations).toEqual([]);
  });

  it("aggregates reserved quantity for a fungible item and reflects availability", async () => {
    poolQuery
      .mockResolvedValueOnce(rows({ id: "item-1", total_stock: 100 }))
      .mockResolvedValueOnce(rows(makeRow({ quantity: 30 }), makeRow({ id: UUID, quantity: 40 })));

    const res = await scheduler.getAvailability({
      itemSlug: "chairs",
      startISO: START,
      endISO: END,
      quantity: 30,
    });

    expect(res.reserved).toBe(70);
    expect(res.available).toBe(30);
    expect(res.isAvailable).toBe(true); // 30 available >= 30 requested
  });

  it("is unavailable when the requested quantity exceeds remaining stock", async () => {
    poolQuery
      .mockResolvedValueOnce(rows({ id: "item-1", total_stock: 100 }))
      .mockResolvedValueOnce(rows(makeRow({ quantity: 90 })));

    const res = await scheduler.getAvailability({
      itemSlug: "chairs",
      startISO: START,
      endISO: END,
      quantity: 20,
    });

    expect(res.available).toBe(10);
    expect(res.isAvailable).toBe(false);
  });

  it("throws SchedulerError for an unknown item", async () => {
    poolQuery.mockResolvedValueOnce(rows()); // no item

    await expect(
      scheduler.getAvailability({ itemSlug: "nope", startISO: START, endISO: END }),
    ).rejects.toBeInstanceOf(SchedulerError);
  });

  it("widens the overlap window by the buffer on both sides", async () => {
    poolQuery
      .mockResolvedValueOnce(rows({ id: "item-1", total_stock: 1 }))
      .mockResolvedValueOnce(rows());

    await scheduler.getAvailability({
      itemSlug: "tent",
      startISO: START,
      endISO: END,
      bufferMinutes: 30,
    });

    const [, params] = poolQuery.mock.calls[1];
    // start shifted back 30m, end shifted forward 30m.
    expect(params).toEqual([
      "item-1",
      "2026-08-01T13:30:00.000Z",
      "2026-08-01T16:30:00.000Z",
    ]);
  });

  it("maps snake_case rows to camelCase reservations with nested customer", async () => {
    poolQuery
      .mockResolvedValueOnce(rows({ id: "item-1", total_stock: 1 }))
      .mockResolvedValueOnce(
        rows(
          makeRow({
            customer_email: "a@b.com",
            customer_name: "Ada",
            customer_phone: "555",
            order_id: "ord-1",
            notes: "hi",
          }),
        ),
      );

    const res = await scheduler.getAvailability({ itemSlug: "tent", startISO: START, endISO: END });
    const r = res.reservations[0];

    expect(r).toMatchObject({
      id: UUID,
      itemId: "item-1",
      itemSlug: "tent",
      quantity: 1,
      startISO: START,
      endISO: END,
      status: "confirmed",
      orderId: "ord-1",
      notes: "hi",
      customer: { email: "a@b.com", name: "Ada", phone: "555" },
    });
    expect(r.createdAt).toBe("2026-07-10T00:00:00.000Z");
  });
});

describe("scheduler.createReservation", () => {
  it("locks, re-checks capacity, then inserts (in that order) and returns the mapped reservation", async () => {
    txQuery
      .mockResolvedValueOnce(rows()) // pg_advisory_xact_lock
      .mockResolvedValueOnce(rows({ id: "item-1", total_stock: 1 })) // item lookup
      .mockResolvedValueOnce(rows({ reserved: 0 })) // capacity SUM
      .mockResolvedValueOnce(rows(makeRow())); // INSERT ... RETURNING

    const res = await scheduler.createReservation({ itemSlug: "tent", startISO: START, endISO: END });

    expect(res.id).toBe(UUID);
    expect(res.itemSlug).toBe("tent");

    const sql = txQuery.mock.calls.map((c) => String(c[0]));
    expect(sql[0]).toContain("pg_advisory_xact_lock");
    expect(sql[1]).toContain("FROM items");
    expect(sql[2]).toContain("SUM(quantity)");
    expect(sql[3]).toContain("INSERT INTO reservations");
  });

  it("throws SchedulerConflictError with meta and does not insert when capacity is exhausted", async () => {
    txQuery
      .mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows({ id: "item-1", total_stock: 1 }))
      .mockResolvedValueOnce(rows({ reserved: 1 })); // already full

    const err = await scheduler
      .createReservation({ itemSlug: "tent", startISO: START, endISO: END })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SchedulerConflictError);
    expect(err.meta).toEqual({ itemSlug: "tent", requested: 1, available: 0 });

    const sql = txQuery.mock.calls.map((c) => String(c[0]));
    expect(sql.some((s) => s.includes("INSERT INTO reservations"))).toBe(false);
  });

  it("allows a fungible booking that exactly fills remaining capacity", async () => {
    txQuery
      .mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows({ id: "item-1", total_stock: 100 }))
      .mockResolvedValueOnce(rows({ reserved: 70 })) // 70 + 30 == 100
      .mockResolvedValueOnce(rows(makeRow({ quantity: 30 })));

    const res = await scheduler.createReservation({
      itemSlug: "chairs",
      startISO: START,
      endISO: END,
      quantity: 30,
    });
    expect(res.quantity).toBe(30);
  });

  it("rejects a fungible booking that would exceed capacity by one", async () => {
    txQuery
      .mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows({ id: "item-1", total_stock: 100 }))
      .mockResolvedValueOnce(rows({ reserved: 71 })); // 71 + 30 > 100

    await expect(
      scheduler.createReservation({ itemSlug: "chairs", startISO: START, endISO: END, quantity: 30 }),
    ).rejects.toBeInstanceOf(SchedulerConflictError);
  });

  it("throws SchedulerError for an unknown item inside the transaction", async () => {
    txQuery
      .mockResolvedValueOnce(rows()) // lock
      .mockResolvedValueOnce(rows()); // no item

    await expect(
      scheduler.createReservation({ itemSlug: "nope", startISO: START, endISO: END }),
    ).rejects.toBeInstanceOf(SchedulerError);
  });
});

describe("scheduler.getReservation", () => {
  it("returns null without querying for a non-uuid id", async () => {
    const res = await scheduler.getReservation("not-a-uuid");
    expect(res).toBeNull();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("returns a mapped reservation using the joined item slug", async () => {
    poolQuery.mockResolvedValueOnce(rows(makeRow({ item_slug: "tent" })));
    const res = await scheduler.getReservation(UUID);
    expect(res).toMatchObject({ id: UUID, itemSlug: "tent" });
  });

  it("returns null when the reservation is not found", async () => {
    poolQuery.mockResolvedValueOnce(rows());
    expect(await scheduler.getReservation(UUID)).toBeNull();
  });
});

describe("scheduler.cancelReservation", () => {
  it("returns null without querying for a non-uuid id", async () => {
    const res = await scheduler.cancelReservation("nope");
    expect(res).toBeNull();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("returns the cancelled reservation on success", async () => {
    poolQuery.mockResolvedValueOnce(rows(makeRow({ status: "cancelled", item_slug: "tent" })));
    const res = await scheduler.cancelReservation(UUID);
    expect(res).toMatchObject({ id: UUID, itemSlug: "tent", status: "cancelled" });
  });

  it("returns null for an unknown reservation", async () => {
    poolQuery.mockResolvedValueOnce(rows());
    expect(await scheduler.cancelReservation(UUID)).toBeNull();
  });
});
