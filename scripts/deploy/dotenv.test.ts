// @vitest-environment node
//
// Issue #26 — the deploy env parser (scripts/deploy/lib/dotenv.sh) and the
// pre-flight validation in scripts/deploy/set-staging-env.sh.
//
// Every test runs bash against throwaway fixtures in a temp dir — never the
// real .env.local — and with a minimal environment so the developer's shell
// can't leak into `$VAR` expansion. The deploy script is only run with
// `--check` or with a fake `gcloud` on PATH that records any call and fails.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const DEPLOY_DIR = path.resolve(__dirname);
const LIB = path.join(DEPLOY_DIR, "lib", "dotenv.sh");
const SCRIPT = path.join(DEPLOY_DIR, "set-staging-env.sh");

let dir: string;
let envFile: string;
let fakeBin: string;
let gcloudMarker: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dotenv-test-"));
  envFile = path.join(dir, ".env.local");
  fakeBin = path.join(dir, "bin");
  gcloudMarker = path.join(dir, "gcloud-called");
  // A fake gcloud that records it was invoked and fails, so nothing real runs.
  execFileSync("mkdir", ["-p", fakeBin]);
  const gcloud = path.join(fakeBin, "gcloud");
  writeFileSync(gcloud, `#!/usr/bin/env bash\ntouch "${gcloudMarker}"\nexit 97\n`);
  chmodSync(gcloud, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Deliberately minimal so the developer's shell can't leak into $VAR expansion
  // (NODE_ENV is required by the ProcessEnv type; the scripts ignore it).
  return { NODE_ENV: "test", PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`, ...extra };
}

/** Run `dotenv_get NAME` against the fixture; returns stdout/stderr/status. */
function get(name: string, extraEnv: Record<string, string> = {}) {
  const r = spawnSync("bash", ["-c", 'set -euo pipefail; . "$1"; dotenv_get "$2" "$3"', "bash", LIB, name, envFile], {
    cwd: dir,
    env: baseEnv(extraEnv),
    encoding: "utf8",
  });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

function writeEnv(lines: string[] | string) {
  writeFileSync(envFile, Array.isArray(lines) ? lines.join("\n") + "\n" : lines);
}

describe("dotenv_get (scripts/deploy/lib/dotenv.sh)", () => {
  it("strips an unquoted inline comment", () => {
    writeEnv(["PAYPAL_ENV=sandbox   # or live"]);
    expect(get("PAYPAL_ENV")).toMatchObject({ out: "sandbox", status: 0 });
  });

  it("strips quotes when a comment follows them", () => {
    writeEnv(['PAYPAL_ENV="sandbox" # sandbox | live', 'QUOTED="hello" # trailing', "SQ='x y'   # c"]);
    expect(get("PAYPAL_ENV").out).toBe("sandbox");
    expect(get("QUOTED").out).toBe("hello");
    expect(get("SQ").out).toBe("x y");
  });

  it("keeps a # inside quotes", () => {
    writeEnv(['HASH="a#b # not a comment" # real comment', "SHASH='c#d'"]);
    expect(get("HASH").out).toBe("a#b # not a comment");
    expect(get("SHASH").out).toBe("c#d");
  });

  it("handles CRLF line endings", () => {
    writeEnv('PAYPAL_ENV="sandbox" # c\r\nPLAIN=live\r\nPADDED=value   \r\n');
    expect(get("PAYPAL_ENV").out).toBe("sandbox");
    expect(get("PLAIN").out).toBe("live");
    expect(get("PADDED").out).toBe("value");
  });

  it("expands $VAR and ${VAR} references from the same file", () => {
    writeEnv([
      "A_URL=postgresql://user:pw@a.example.com/db?sslmode=require&x=1",
      'REF="$A_URL"',
      "BRACED=${A_URL}",
      'MIXED="pre-${A_URL}-post"',
      "CHAIN=$REF",
    ]);
    const url = "postgresql://user:pw@a.example.com/db?sslmode=require&x=1";
    expect(get("REF")).toMatchObject({ out: url, status: 0 });
    expect(get("BRACED").out).toBe(url);
    expect(get("MIXED").out).toBe(`pre-${url}-post`);
    expect(get("CHAIN").out).toBe(url);
  });

  it("resolves a reference defined later in the file", () => {
    writeEnv(['DATABASE_URL="$DATABASE_URL_DEV"', "DATABASE_URL_DEV=postgres://dev.example.com/db"]);
    expect(get("DATABASE_URL").out).toBe("postgres://dev.example.com/db");
  });

  it("falls back to the process environment, then ${VAR:-default}", () => {
    writeEnv(["FROM_ENV=$OUTSIDE_VAR", "WITH_DEFAULT=${NOT_SET_ANYWHERE:-fallback}"]);
    expect(get("FROM_ENV", { OUTSIDE_VAR: "from-env" }).out).toBe("from-env");
    expect(get("WITH_DEFAULT").out).toBe("fallback");
  });

  it("does not expand single-quoted values or escaped \\$", () => {
    writeEnv(["A=alpha", "SQ='$A and ${A}'", "ESC=cost\\$A"]);
    expect(get("SQ").out).toBe("$A and ${A}");
    expect(get("ESC").out).toBe("cost$A");
  });

  it("preserves = inside a connection string", () => {
    writeEnv(['DATABASE_URL="postgresql://u:p@h.example.com/db?sslmode=require&channel_binding=require"']);
    expect(get("DATABASE_URL").out).toBe("postgresql://u:p@h.example.com/db?sslmode=require&channel_binding=require");
  });

  it("accepts an export prefix and uses the last definition", () => {
    writeEnv(["export EXP=first", "export   EXP=second", "EXPORTED_NOT=other"]);
    expect(get("EXP").out).toBe("second");
  });

  it("does not match a variable whose name is a prefix of another", () => {
    writeEnv(["DATABASE_URL_DEV=postgres://dev", "DATABASE_URL=postgres://main"]);
    expect(get("DATABASE_URL").out).toBe("postgres://main");
  });

  it("returns empty for a missing variable", () => {
    writeEnv(["OTHER=x"]);
    expect(get("MISSING")).toMatchObject({ out: "", status: 0 });
  });

  it("fails on an undefined reference, naming variables but no values", () => {
    writeEnv(["SECRETISH=$NOT_DEFINED_ANYWHERE", "UNRELATED=s3cr3t-value"]);
    const r = get("SECRETISH");
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("SECRETISH");
    expect(r.err).toContain("NOT_DEFINED_ANYWHERE");
    expect(r.err).not.toContain("s3cr3t");
  });

  it("fails on a reference cycle instead of looping", () => {
    writeEnv(["C1=$C2", "C2=${C1}"]);
    const r = get("C1");
    expect(r.status).not.toBe(0);
    expect(r.err).toMatch(/cycle/);
  });

  it("fails on text after a closing quote", () => {
    writeEnv(['BAD="a" b']);
    const r = get("BAD");
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("BAD");
  });
});

// ---------------------------------------------------------------------------
// set-staging-env.sh pre-flight
// ---------------------------------------------------------------------------

const SECRET_VALUES = {
  PAYPAL_CLIENT_SECRET: "fixture-paypal-secret-zzz",
  RESEND_API_KEY: "re_fixture_resend_zzz",
  UPSTASH_REDIS_REST_TOKEN: "fixture-upstash-token-zzz",
};

function validEnv(overrides: Record<string, string> = {}): string[] {
  const base: Record<string, string> = {
    PAYPAL_ENV: '"sandbox" # sandbox | live',
    PAYPAL_CLIENT_ID: '"fixture-client-id"',
    PAYPAL_CLIENT_SECRET: `"${SECRET_VALUES.PAYPAL_CLIENT_SECRET}"`,
    PAYPAL_WEBHOOK_ID: '"WH-FIXTURE-123"',
    NEXT_PUBLIC_PAYPAL_CLIENT_ID: '"fixture-client-id"',
    RESEND_API_KEY: `"${SECRET_VALUES.RESEND_API_KEY}"`,
    EMAIL_FROM: '"BCC Rentals <rentals@example.org>"',
    STAFF_NOTIFICATION_EMAIL: '"staff@example.org"',
    UPSTASH_REDIS_REST_URL: '"https://fixture.upstash.example"',
    UPSTASH_REDIS_REST_TOKEN: `"${SECRET_VALUES.UPSTASH_REDIS_REST_TOKEN}"`,
    DATABASE_URL: '"$DATABASE_URL_DEV"',
    DATABASE_URL_DEV: '"postgresql://fixtureuser:fixturepw@dev.example.com/db?sslmode=require"',
    ...overrides,
  };
  return Object.entries(base).map(([k, v]) => `${k}=${v}`);
}

function runScript(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    cwd: dir,
    env: baseEnv({ ENV_FILE: envFile, ...extraEnv }),
    encoding: "utf8",
    input: "",
  });
  return { out: r.stdout, err: r.stderr, all: r.stdout + r.stderr, status: r.status };
}

function expectNoSecretsPrinted(text: string) {
  for (const v of Object.values(SECRET_VALUES)) expect(text).not.toContain(v);
  expect(text).not.toContain("fixturepw");
}

describe("set-staging-env.sh pre-flight", () => {
  it("passes --check on a valid file, prints plain config, hides secrets, never calls gcloud", () => {
    writeEnv(validEnv());
    const r = runScript(["--check"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/PAYPAL_ENV\s+sandbox\n/);
    expect(r.out).toMatch(/PAYPAL_WEBHOOK_ID\s+WH-FIXTURE-123/);
    expect(r.out).toMatch(/UPSTASH_REDIS_REST_URL\s+https:\/\/fixture\.upstash\.example/);
    expect(r.out).toMatch(/NEXT_PUBLIC_SITE_URL\s+https:\/\//);
    expect(r.out).toMatch(/DATABASE_URL\s+set \(/);
    expectNoSecretsPrinted(r.all);
    expect(existsSync(gcloudMarker)).toBe(false);
  });

  it("refuses to apply without a terminal or --yes, before calling gcloud", () => {
    writeEnv(validEnv());
    const r = runScript([]);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("--yes");
    expect(existsSync(gcloudMarker)).toBe(false);
  });

  it.each([
    ["PAYPAL_ENV", { PAYPAL_ENV: '"sandbox # live"' }],
    ["PAYPAL_ENV", { PAYPAL_ENV: "production" }],
    ["DATABASE_URL", { DATABASE_URL: '"mysql://x@y/z"' }],
    ["DATABASE_URL", { DATABASE_URL: "'$DATABASE_URL_DEV'" }],
    ["DATABASE_URL", { DATABASE_URL: '"$DATABASE_URL_MISSING"' }],
    ["PAYPAL_WEBHOOK_ID", { PAYPAL_WEBHOOK_ID: '""' }],
    ["PAYPAL_WEBHOOK_ID", { PAYPAL_WEBHOOK_ID: "pending-n3.5" }],
    ["EMAIL_FROM", { EMAIL_FROM: "" }],
    ["RESEND_API_KEY", { RESEND_API_KEY: '"not-a-resend-key"' }],
    ["UPSTASH_REDIS_REST_URL", { UPSTASH_REDIS_REST_URL: "http://insecure.example" }],
    ["STAFF_NOTIFICATION_EMAIL", { STAFF_NOTIFICATION_EMAIL: '"a@@b"' }],
  ])("exits non-zero naming %s before step 1/3 (%j)", (name, overrides) => {
    writeEnv(validEnv(overrides));
    // --yes so that, without validation, the script would go on to call gcloud.
    const r = runScript(["--yes"]);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain(name);
    expect(r.all).not.toContain("1/3");
    expect(existsSync(gcloudMarker)).toBe(false);
    expectNoSecretsPrinted(r.all);
  });

  it("reports a variable missing from the file", () => {
    writeEnv(validEnv().filter((l) => !l.startsWith("PAYPAL_CLIENT_SECRET=")));
    const r = runScript(["--check"]);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("PAYPAL_CLIENT_SECRET is missing or empty");
  });

  it("does not print a secret value when the secret itself is invalid", () => {
    writeEnv(validEnv({ DATABASE_URL: '"not-a-url-fixturepw"' }));
    const r = runScript(["--check"]);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("DATABASE_URL");
    expect(r.all).not.toContain("not-a-url");
  });

  it("is syntactically valid bash", () => {
    expect(() => execFileSync("bash", ["-n", SCRIPT])).not.toThrow();
    expect(() => execFileSync("bash", ["-n", LIB])).not.toThrow();
  });
});
