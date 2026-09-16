import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import {
  COLLABORATOR_GROUP,
  databaseNameFor,
  executePlan,
  hardenSharedDatabases,
  provisionPlan,
} from "../src/provision.js";

/**
 * The isolation model (design I2 and I4), proved against a real Postgres 16
 * instead of by inspection: a collaborator cannot reach another collaborator's
 * database nor the maintenance one, cannot install an extension that crosses
 * databases, and `<slug>_fn` owns nothing until it assumes an execution role.
 *
 * Needs docker. Without it the file says so out loud and passes: a silent skip
 * would look like proof.
 */
const CONTAINER = "stl-buildloop-provision-it";
const IMAGE = "postgres:16";
const PORT = 55433;
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
  console.log("SKIP: docker not available — the isolation proofs (I2, I4) did not run");
}
const skip = HAS_DOCKER ? false : "docker not available";

const ALICE = { slug: "alice", password: "a".repeat(48), fnPassword: "1".repeat(48) };
const BOB = { slug: "bob", password: "b".repeat(48), fnPassword: "2".repeat(48) };

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
  for (const who of [ALICE, BOB]) {
    await executePlan(adminPool, adminConnection, provisionPlan({ ...who, roleExists: false, dbExists: false }));
  }
  // What the server does at boot: PUBLIC loses CONNECT on the shared databases.
  await hardenSharedDatabases(adminPool);

  // A table of alice's own, so `_fn` has something it must NOT be able to read.
  await as(ALICE.slug, ALICE.password, databaseNameFor(ALICE.slug), async (client) => {
    await client.query("CREATE TABLE public.notes (id serial PRIMARY KEY, user_id integer, body text)");
    await client.query("INSERT INTO public.notes (user_id, body) VALUES (1, 'mine'), (2, 'theirs')");
    await client.query(`GRANT SELECT ON public.notes TO ${ALICE.slug}_authenticated`);
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

test("a collaborator cannot connect to another collaborator's database", { skip }, async () => {
  await assert.rejects(
    as(ALICE.slug, ALICE.password, databaseNameFor(BOB.slug), async () => {}),
    /permission denied for database/i,
  );
});

test("a collaborator cannot connect to the maintenance database", { skip }, async () => {
  await assert.rejects(as(ALICE.slug, ALICE.password, "postgres", async () => {}), /permission denied for database/i);
});

test("a collaborator cannot install an extension that crosses databases", { skip }, async () => {
  await assert.rejects(
    as(ALICE.slug, ALICE.password, databaseNameFor(ALICE.slug), (client) => client.query("CREATE EXTENSION dblink")),
    /permission denied to create extension|must be superuser/i,
  );
});

test("_fn owns nothing: it cannot read the collaborator's table without assuming a role", { skip }, async () => {
  await assert.rejects(
    as(`${ALICE.slug}_fn`, ALICE.fnPassword, databaseNameFor(ALICE.slug), (client) =>
      client.query("SELECT * FROM public.notes"),
    ),
    /permission denied for table notes/i,
  );
});

test("_fn assumes an execution role, reads as it, and RESET ROLE takes the privilege back", { skip }, async () => {
  await as(`${ALICE.slug}_fn`, ALICE.fnPassword, databaseNameFor(ALICE.slug), async (client) => {
    await client.query(`SET ROLE ${ALICE.slug}_authenticated`);
    const who = await client.query("SELECT current_user AS role");
    assert.equal(who.rows[0].role, `${ALICE.slug}_authenticated`);
    const rows = await client.query("SELECT count(*)::int AS n FROM public.notes");
    assert.equal(rows.rows[0].n, 2);

    await client.query("RESET ROLE");
    const back = await client.query("SELECT current_user AS role");
    assert.equal(back.rows[0].role, `${ALICE.slug}_fn`);
    await assert.rejects(client.query("SELECT * FROM public.notes"), /permission denied for table notes/i);
  });
});
