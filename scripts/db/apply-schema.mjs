// Applies lib/scheduler/db/schema.sql to a Neon branch.
//
//   npm run db:apply              # dev branch  (DATABASE_URL_DEV)
//   npm run db:apply:prod         # main branch (DATABASE_URL)
//   npm run db:apply -- --check   # print tables/indexes for the target and exit
//
// Dev uses the DIRECT/unpooled endpoint. Prod's committed DATABASE_URL is the
// pooled endpoint, which is fine for these plain CREATE TABLE IF NOT EXISTS
// statements. Run via Node's --env-file so .env.local is loaded (see package.json).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "..", "..", "lib", "scheduler", "db", "schema.sql");

const isProd = process.argv.includes("--prod");
const target = isProd ? "main (prod)" : "dev";
const envVar = isProd ? "DATABASE_URL" : "DATABASE_URL_DEV";
const connectionString = process.env[envVar];
if (!connectionString) {
  console.error(`${envVar} is not set. Run via npm run db:apply${isProd ? ":prod" : ""} (loads .env.local).`);
  process.exit(1);
}
console.log(`Target branch: ${target} (${envVar})`);

const checkOnly = process.argv.includes("--check");

const client = new pg.Client({ connectionString });

try {
  await client.connect();

  if (!checkOnly) {
    const sql = await readFile(SCHEMA_PATH, "utf8");
    await client.query(sql);
    console.log(`Applied ${SCHEMA_PATH} to Neon ${target}.`);
  }

  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name IN ('items', 'reservations')
     ORDER BY table_name;`
  );
  const { rows: indexes } = await client.query(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'reservations_item_time_idx';`
  );

  console.log("Tables :", tables.map((r) => r.table_name).join(", ") || "(none)");
  console.log("Indexes:", indexes.map((r) => r.indexname).join(", ") || "(none)");
} catch (err) {
  console.error("Schema apply failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
