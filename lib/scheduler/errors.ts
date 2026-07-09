import "server-only";

/** Base error for all scheduler failures. */
export class SchedulerError extends Error {
  constructor(
    message: string,
    readonly meta?: unknown,
  ) {
    super(message);
    this.name = "SchedulerError";
  }
}

/**
 * Requested capacity is not available for the window (unique item already
 * booked, or fungible stock exhausted). Mirrors LibreBookingConflictError so
 * the fulfill path can branch on it and trigger an automatic refund.
 */
export class SchedulerConflictError extends SchedulerError {
  constructor(
    message = "Reservation conflicts with an existing booking",
    meta?: unknown,
  ) {
    super(message, meta);
    this.name = "SchedulerConflictError";
  }
}
