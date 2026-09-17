import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { COLLABORATOR_GROUP, databaseNameFor, executePlan, hardenSharedDatabases, provisionPlan } from "../src/provision.js";
import { list } from "../src/edge.js";

/**
 * The sensor AD-010 says was missing: `test/edge.test.js` drives a pool that
 * has no privileges to deny, so it cannot see `edge.list` failing against a
 * real Postgres. This proves the fix against Postgres 16 itself — the slug's
 * own role runs `LIST_SQL`, and only the key set comes back, never a value.
 *
 * Needs docker. Without it the file says so out loud and passes: a silent
 * skip would look like proof. Modeled on provision.integration.test.js.
 *
 * The refusals match `table|column`: with a column grant in place Postgres may
 * name either, and which sentence it picks is not the behaviour under test —
 * that the read is refused at all is.
 *
 * `_anon` and `_authenticated` are refused one layer earlier, on the schema:
 * `provision.js` grants `USAGE ON SCHEMA buildloop` to the slug and to `_fn`
 * only (`_fn` needs `buildloop.invocations`), so an execution role never gets
 * far enough to be told about a table. That is a stronger denial, not a weaker
 * one, and the assertions name which one each role must hit.
 */
const CONTAINER = "stl-buildloop-edge-it";
const IMAGE = "postgres:16";
const PORT = 55434;
const ADMIN = { user: "buildloop_admin", password: "d0cker_test_only" };

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
  console.log("SKIP: docker not available — the edge_function_secrets column-grant proof did not run");
}
const skip = HAS_DOCKER ? false : "docker not available";

const ALICE = { slug: "alice", password: "a".repeat(48), fnPassword: "1".repeat(48) };

let adminPool;
const adminConnection = { host: "127.0.0.1", port: PORT, ...ADMIN };

function connection(user, password, database) {
  return new pg.Client({ host: "127.0.0.1", port: PORT, user, password, database });
}

/** Opens a client, hands it to `body`, and always closes it. */
async function as(user, password, database, body) {
  const client = connection(user, password, database);
  await client.connect();
  try {
    return await body(client);
  } finally {
    await client.end();
  }
}

async function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const client = connection(ADMIN.user, ADMIN.password, "postgres");
      await client.connect();
      await client.end();
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`${IMAGE} did not accept connections in 60s`);
}

before(async () => {
  if (!HAS_DOCKER) return;
  try {
    execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  } catch {
    // no leftover container to remove
  }
  execFileSync("docker", [
    "run", "-d", "--rm", "--name", CONTAINER,
    "-e", `POSTGRES_USER=${ADMIN.user}`,
    "-e", `POSTGRES_PASSWORD=${ADMIN.password}`,
    "-p", `${PORT}:5432`,
    IMAGE,
  ], { stdio: "ignore" });
  await waitForPostgres();

  adminPool = new pg.Pool({ ...adminConnection, database: "postgres", max: 3 });
  await adminPool.query(`CREATE ROLE ${COLLABORATOR_GROUP} NOLOGIN`);
  await executePlan(adminPool, adminConnection, provisionPlan({ ...ALICE, roleExists: false, dbExists: false }));
  await hardenSharedDatabases(adminPool);

  // A function with one secret, written the way the admin pool (AD-009) would:
  // directly, as the role that owns `buildloop`.
  await as(ADMIN.user, ADMIN.password, databaseNameFor(ALICE.slug), async (client) => {
    await client.query(
      "INSERT INTO buildloop.edge_functions (name, current_version) VALUES ('greet', 1)",
    );
    await client.query(
      "INSERT INTO buildloop.edge_function_versions (name, version, source, bundle) VALUES ('greet', 1, 'export default () => {}', 'compiled')",
    );
    await client.query(
      "INSERT INTO buildloop.edge_function_secrets (name, key, value_enc) VALUES ('greet', 'API_KEY', 'ciphertext')",
    );
  });
});

after(async () => {
  if (!HAS_DOCKER) return;
  await adminPool?.end();
  try {
    execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  } catch {
    // the container is already gone
  }
});

test("edge.list, run as the slug's own role, returns the function with its secret key set", { skip }, async () => {
  await as(ALICE.slug, ALICE.password, databaseNameFor(ALICE.slug), async (client) => {
    const rows = await list(client);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "greet");
    assert.deepEqual(rows[0].secretKeys, ["API_KEY"]);
  });
});

test("the slug cannot read value_enc off edge_function_secrets", { skip }, async () => {
  await as(ALICE.slug, ALICE.password, databaseNameFor(ALICE.slug), (client) =>
    assert.rejects(
      client.query("SELECT value_enc FROM buildloop.edge_function_secrets"),
      /permission denied for (table|column)[^\n]*edge_function_secrets/i,
    ),
  );
});

test("the slug cannot SELECT * off edge_function_secrets", { skip }, async () => {
  await as(ALICE.slug, ALICE.password, databaseNameFor(ALICE.slug), (client) =>
    assert.rejects(
      client.query("SELECT * FROM buildloop.edge_function_secrets"),
      /permission denied for (table|column)[^\n]*edge_function_secrets/i,
    ),
  );
});

test("none of the execution roles (_anon, _authenticated, _fn) can read even the key column", { skip }, async () => {
  await as(`${ALICE.slug}_fn`, ALICE.fnPassword, databaseNameFor(ALICE.slug), async (client) => {
    // `_fn` holds USAGE on the schema (it writes `buildloop.invocations`), so
    // its refusal is the table/column one.
    await assert.rejects(
      client.query("SELECT key FROM buildloop.edge_function_secrets"),
      /permission denied for (table|column)[^\n]*edge_function_secrets/i,
      "_fn",
    );

    // `_anon` and `_authenticated` hold no USAGE on `buildloop` at all: the
    // schema closes before the table is ever named.
    for (const role of [`${ALICE.slug}_anon`, `${ALICE.slug}_authenticated`]) {
      await client.query(`SET ROLE ${role}`);
      await assert.rejects(
        client.query("SELECT key FROM buildloop.edge_function_secrets"),
        /permission denied for schema buildloop/i,
        role,
      );
      await client.query("RESET ROLE");
    }
  });
});
