import "server-only";

export class LibreBookingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "LibreBookingError";
  }
}

export class LibreBookingAuthError extends LibreBookingError {
  constructor(endpoint: string, body?: unknown) {
    super("LibreBooking authentication failed", 401, endpoint, body);
    this.name = "LibreBookingAuthError";
  }
}

export class LibreBookingConflictError extends LibreBookingError {
  constructor(endpoint: string, body?: unknown) {
    super("Reservation conflicts with an existing booking", 409, endpoint, body);
    this.name = "LibreBookingConflictError";
  }
}
