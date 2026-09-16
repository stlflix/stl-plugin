import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidUser, MAX_INVOCATION_ROWS, SqlBridge, SqlError, UnknownSlug, roleFor } from "../src/sqlbridge.js";

/**
 * The shape of the transaction is the contract (design I4): a fake client
 * records every statement in order, so the tests judge the sequence itself —
 * who the connection becomes, what claims it carries, and that the
 * collaborator's own statement is the last thing before COMMIT.
 */
const CONFIG = { dbHost: "db", dbPort: 5432 };

function fakeDb({ fail = null } = {}) {
  const statements = [];
  const parameters = [];
  const configs = [];
  let released = 0;
  const client = {
    async query(q, params) {
      const text = typeof q === "string" ? q : q.text;
      statements.push(text);
      parameters.push(params ?? (typeof q === "string" ? null : q.values));
      if (typeof q !== "string") configs.push(q);
      if (fail && fail.on === text) throw Object.assign(new Error(fail.message), { code: fail.code });
      return { command: "SELECT", rowCount: 1, fields: [{ name: "x" }], rows: [{ x: 1 }] };
    },
    release() {
      released += 1;
    },
  };
  const ended = [];
  const pool = { connect: async () => client, end: async () => ended.push(true) };
  return { statements, parameters, configs, pool, ended, released: () => released };
}

function bridge(db, { credential = { database: "db_alice", user: "alice_fn", password: "p" } } = {}) {
  const calls = [];
  const mcp = {
    credential: async (slug) => {
      calls.push(slug);
      return slug === "alice" ? credential : null;
    },
  };
  return {
    calls,
    instance: new SqlBridge({ mcp, config: CONFIG, PoolClass: class { constructor() { return db.pool; } } }),
  };
}

const ANON = { role: "anon", claims: {} };
const CLAIMS = { sub: "7", email: "a@x.com", name: "Ana", is_super: false };

test("an anonymous call runs the exact transaction, and never upserts a user", async () => {
  const db = fakeDb();
  const { instance } = bridge(db);
  await instance.run("alice", ANON, "select 1", []);
  assert.deepEqual(db.statements, [
    "BEGIN",
    "SET LOCAL statement_timeout = 5000",
    'SET LOCAL ROLE "alice_anon"',
    "SELECT set_config('request.jwt.claims', $1, true)",
    "select 1",
    "COMMIT",
  ]);
  assert.deepEqual(db.parameters[3], ["{}"], "an anonymous caller carries empty claims, so auth.uid() is null");
  assert.equal(db.released(), 1, "the connection goes back to the pool");
});

test("an authenticated call sets the other role and upserts the caller, once per invocation", async () => {
  const db = fakeDb();
  const { instance } = bridge(db);
  const user = { role: "authenticated", claims: CLAIMS };

  await instance.run("alice", user, "select * from notes", []);
  assert.deepEqual(db.statements, [
    "BEGIN",
    "SET LOCAL statement_timeout = 5000",
    'SET LOCAL ROLE "alice_authenticated"',
    "SELECT set_config('request.jwt.claims', $1, true)",
    `INSERT INTO auth.users (id, email, name, is_super) VALUES ($1, $2, $3, $4)
  ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), email = EXCLUDED.email, name = EXCLUDED.name, is_super = EXCLUDED.is_super`,
    "select * from notes",
    "COMMIT",
  ]);
  assert.deepEqual(db.parameters[3], [JSON.stringify(CLAIMS)]);
  assert.deepEqual(db.parameters[4], [7, "a@x.com", "Ana", false], "the sub becomes the integer id of auth.users");

  db.statements.length = 0;
  await instance.run("alice", user, "select 2", []);
  assert.ok(!db.statements.some((s) => s.includes("INSERT INTO auth.users")), "the second ctx.sql of the same invocation does not upsert again");

  db.statements.length = 0;
  await instance.run("alice", { role: "authenticated", claims: CLAIMS }, "select 3", []);
  assert.ok(db.statements.some((s) => s.includes("INSERT INTO auth.users")), "the next invocation upserts again");
});

test("the collaborator's statement goes out on the extended protocol, so it cannot be two statements", async () => {
  const db = fakeDb();
  const { instance } = bridge(db);
  await instance.run("alice", ANON, "select $1::int", [5]);
  const config = db.configs.at(-1);
  assert.deepEqual(config, { text: "select $1::int", values: [5], queryMode: "extended" });

  await instance.run("alice", ANON, "select 1");
  assert.deepEqual(db.configs.at(-1), { text: "select 1", values: [], queryMode: "extended" }, "no parameters still means extended");
});

test("the result comes back as data, with the column names and never a client object", async () => {
  const db = fakeDb();
  const { instance } = bridge(db);
  const result = await instance.run("alice", ANON, "select 1", []);
  assert.deepEqual(result, { command: "SELECT", rowCount: 1, fields: ["x"], rows: [{ x: 1 }] });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, "it survives the IPC channel to the child");
});

test("a refused statement rolls back and comes back as the database's own message and code", async () => {
  const db = fakeDb({ fail: { on: "select * from secret", message: "permission denied for table secret", code: "42501" } });
  const { instance } = bridge(db);
  await assert.rejects(
    () => instance.run("alice", ANON, "select * from secret", []),
    (err) => err instanceof SqlError && err.code === "42501" && /permission denied/.test(err.message),
  );
  assert.equal(db.statements.at(-1), "ROLLBACK");
  assert.equal(db.released(), 1, "the connection goes back even when the statement failed");
});

test("a login Postgres itself refuses forgets the credential, so the next call asks the MCP again", async () => {
  const db = fakeDb({ fail: { on: "select 1", message: "password authentication failed", code: "28P01" } });
  const { instance, calls } = bridge(db);
  await assert.rejects(() => instance.run("alice", ANON, "select 1", []), SqlError);
  assert.deepEqual(db.ended, [true], "the stale pool is closed");

  const fresh = fakeDb();
  const reopened = new SqlBridge({
    mcp: { credential: async (slug) => (calls.push(slug), { database: "db_alice", user: "alice_fn", password: "p2" }) },
    config: CONFIG,
    PoolClass: class { constructor() { return fresh.pool; } },
  });
  await reopened.run("alice", ANON, "select 1", []);
  assert.deepEqual(calls, ["alice", "alice"]);
});

test("the credential is asked for once and then cached, and an unknown slug is refused", async () => {
  const db = fakeDb();
  const { instance, calls } = bridge(db);
  await instance.run("alice", ANON, "select 1", []);
  await instance.run("alice", ANON, "select 2", []);
  assert.deepEqual(calls, ["alice"], "one credential call for two statements");
  await assert.rejects(() => instance.run("bob", ANON, "select 1", []), UnknownSlug);
});

test("the role is chosen from a closed list, never from a claim", () => {
  assert.equal(roleFor("alice", { role: "anon" }), "alice_anon");
  assert.equal(roleFor("alice", { role: "authenticated" }), "alice_authenticated");
  for (const role of ["service_role", "alice", 'anon"; DROP', undefined]) {
    assert.throws(() => roleFor("alice", { role }), InvalidUser, String(role));
  }
  assert.throws(() => roleFor("Alice; drop", { role: "anon" }), InvalidUser);
});

test("an authenticated caller without an integer sub is refused before any statement runs", async () => {
  const db = fakeDb();
  const { instance } = bridge(db);
  await assert.rejects(
    () => instance.run("alice", { role: "authenticated", claims: { sub: "not-a-number" } }, "select 1", []),
    (err) => err instanceof SqlError && /integer sub/.test(err.message),
  );
  assert.ok(!db.statements.includes("select 1"), "the collaborator's statement never ran");
  assert.equal(db.statements.at(-1), "ROLLBACK");
});

test("writeInvocation logs the call as _fn and trims the function to its retention", async () => {
  const db = fakeDb();
  const { instance } = bridge(db);
  await instance.writeInvocation("alice", {
    name: "hello",
    version: 3,
    status: 200,
    durationMs: 12,
    log: ["hi"],
    error: null,
  });
  assert.match(db.statements[0], /^INSERT INTO buildloop\.invocations/);
  assert.deepEqual(db.parameters[0], ["hello", 3, 200, 12, '["hi"]', null]);
  assert.match(db.statements[1], /^DELETE FROM buildloop\.invocations/);
  assert.match(db.statements[1], /interval '24 hours'/);
  assert.deepEqual(db.parameters[1], ["hello", MAX_INVOCATION_ROWS]);
  assert.equal(db.released(), 1);
});
