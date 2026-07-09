import "server-only";
import { Pool, type PoolClient } from "pg";
import { env } from "@/lib/env";

// Single pool per Node instance (persists across warm serverless invocations).
// env.DATABASE_URL is Neon's pooled endpoint — correct for runtime queries.
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: env.DATABASE_URL, max: 5 });
  }
  return pool;
}

/**
 * Runs `fn` inside a single transaction on a dedicated client, committing on
 * success and rolling back on any thrown error. Used by createReservation so
 * the availability re-check and the insert are atomic under a per-item lock.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
