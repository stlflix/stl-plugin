import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { SqlBridge, SqlError } from "../src/sqlbridge.js";

/**
 * Design I4, against a real Postgres 16 instead of by inspection: `<slug>_fn`
 * owns nothing and cannot read a table until it assumes an execution role; with
 * `<slug>_authenticated` and the claims of user 1, RLS shows it only user 1's
 * rows; and a second statement smuggled into one `ctx.sql` is refused by the
 * extended protocol itself.
 *
 * Needs docker. Without it the file says so out loud and passes: a silent skip
 * would look like proof.
 */
const CONTAINER = "stl-buildloop-sqlbridge-it";
const IMAGE = "postgres:16";
const PORT = 55434;
const ADMIN = { user: "buildloop_admin", password: "d0cker_test_only" };
const FN_PASSWORD = "f".repeat(24);

function dockerAvailable() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_DOCKER = dockerAvailable();
if (!HAS_DOCKER) {
  console.log("SKIP: docker not available — the sqlbridge proofs (I4) did not run");
}
const skip = HAS_DOCKER ? false : "docker not available";

let bridge;
let adminClient;

async function adminExec(sql, database = "postgres") {
  const client = new pg.Client({ host: "127.0.0.1", port: PORT, ...ADMIN, database });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

before(async () => {
  if (!HAS_DOCKER) return;
  try {
    execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  } catch {
    // Nothing to remove: the previous run cleaned up after itself.
  }
  execFileSync("docker", [
    "run", "-d", "--rm", "--name", CONTAINER,
    "-e", `POSTGRES_USER=${ADMIN.user}`,
    "-e", `POSTGRES_PASSWORD=${ADMIN.password}`,
    "-p", `${PORT}:5432`,
    IMAGE,
  ], { stdio: "ignore" });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await adminExec("SELECT 1");
      break;
    } catch {
      await sleep(1000);
    }
  }

  // The slice of `commonPlan` this proof needs, applied by hand so the test
  // stays inside its own package: three roles, one database, `auth`, and one
  // table whose policy reads `auth.uid()`.
  await adminExec(`CREATE ROLE alice_anon NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  await adminExec(`CREATE ROLE alice_authenticated NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  await adminExec(`CREATE ROLE alice_fn LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${FN_PASSWORD}'`);
  await adminExec("GRANT alice_anon, alice_authenticated TO alice_fn WITH SET TRUE, INHERIT FALSE");
  await adminExec("CREATE DATABASE db_alice");
  await adminExec("GRANT CONNECT ON DATABASE db_alice TO alice_anon, alice_authenticated, alice_fn");

  await adminExec("GRANT USAGE ON SCHEMA public TO alice_anon, alice_authenticated, alice_fn", "db_alice");
  await adminExec("CREATE SCHEMA auth", "db_alice");
  await adminExec(
    `CREATE TABLE auth.users (id integer PRIMARY KEY, email text, name text, is_super boolean NOT NULL DEFAULT false,
       first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now())`,
    "db_alice",
  );
  await adminExec(
    `CREATE FUNCTION auth.uid() RETURNS integer LANGUAGE sql STABLE AS $fn$
       SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::integer $fn$`,
    "db_alice",
  );
  await adminExec("GRANT USAGE ON SCHEMA auth TO alice_anon, alice_authenticated, alice_fn", "db_alice");
  await adminExec("GRANT SELECT ON auth.users TO alice_anon, alice_authenticated", "db_alice");
  await adminExec("GRANT INSERT, UPDATE ON auth.users TO alice_authenticated", "db_alice");
  await adminExec("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO alice_anon, alice_authenticated, alice_fn", "db_alice");

  await adminExec("CREATE TABLE public.notes (id serial PRIMARY KEY, user_id integer NOT NULL, body text)", "db_alice");
  await adminExec("INSERT INTO public.notes (user_id, body) VALUES (1, 'mine'), (2, 'yours')", "db_alice");
  await adminExec("ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY", "db_alice");
  await adminExec(
    "CREATE POLICY own_rows ON public.notes FOR SELECT TO alice_authenticated USING (user_id = auth.uid())",
    "db_alice",
  );
  await adminExec("GRANT SELECT ON public.notes TO alice_authenticated", "db_alice");

  bridge = new SqlBridge({
    mcp: { credential: async () => ({ database: "db_alice", user: "alice_fn", password: FN_PASSWORD }) },
    config: { dbHost: "127.0.0.1", dbPort: PORT },
  });
});

after(async () => {
  if (!HAS_DOCKER) return;
  await bridge?.close();
  await adminClient?.end?.();
  try {
    execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  } catch {
    // The container is already gone; nothing to clean.
  }
});

test("_fn without SET ROLE cannot read a table at all", { skip }, async () => {
  const client = new pg.Client({ host: "127.0.0.1", port: PORT, user: "alice_fn", password: FN_PASSWORD, database: "db_alice" });
  await client.connect();
  try {
    await assert.rejects(() => client.query("SELECT * FROM public.notes"), /permission denied for table notes/);
  } finally {
    await client.end();
  }
});

test("as alice_authenticated with the claims of user 1, RLS shows only user 1's rows", { skip }, async () => {
  const user = { role: "authenticated", claims: { sub: "1", email: "one@x.com", name: "One", is_super: false } };
  const result = await bridge.run("alice", user, "SELECT body FROM public.notes ORDER BY id", []);
  assert.deepEqual(result.rows, [{ body: "mine" }], "the other user's row is invisible, not forbidden");

  const upserted = await bridge.run("alice", user, "SELECT id, email FROM auth.users", []);
  assert.deepEqual(upserted.rows, [{ id: 1, email: "one@x.com" }], "the caller was upserted once, before the handler ran");
});

test("a second statement smuggled into one ctx.sql is refused by the protocol itself", { skip }, async () => {
  await assert.rejects(
    () => bridge.run("alice", { role: "anon", claims: {} }, "RESET ROLE; select 1", []),
    (err) => err instanceof SqlError && /cannot insert multiple commands into a prepared statement/.test(err.message),
  );
});
