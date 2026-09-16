import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import { adminRouter } from "../src/admin.js";

/**
 * The two read routes, end to end over HTTP and without a database: `pools` is a
 * script, `store` knows one collaborator, and `adminPool` is a Proxy that throws
 * on ANY access — the proof that a collaborator's data is only ever read with
 * the collaborator's own role.
 */
const ADMIN_KEY = "k".repeat(32);
const forSlugCalls = [];
const statements = [];

const listRows = [{ schema: "public", name: "profiles", kind: "table", rls_enabled: false, estimated_rows: 42, comment: null }];
const describeRows = [{ column: "id", type: "integer", nullable: false, default: null, position: 1 }];

let updateRowCount = 1;

const client = {
  async query(q) {
    const text = typeof q === "string" ? q : q.text;
    statements.push(text);
    if (text.startsWith("SELECT oid, format_type")) return { rows: [{ oid: 23, name: "integer" }] };
    if (/^insert/i.test(text)) throw Object.assign(new Error("cannot execute INSERT in a read-only transaction"), { code: "25006" });
    if (/^boom/i.test(text)) throw new Error("socket hang up");
    if (/^drop/i.test(text)) throw Object.assign(new Error('relation "gone" does not exist'), { code: "42P01" });
    if (/^update/i.test(text)) return { command: "UPDATE", rowCount: updateRowCount, rows: [] };
    if (/^delete/i.test(text)) return { command: "DELETE", rowCount: 3, rows: [] };
    if (text.startsWith("select")) return { command: "SELECT", fields: [{ name: "x", dataTypeID: 23 }], rows: [[1], [2]] };
    return { rows: [] };
  },
  release() {},
};

const functionRows = [
  { oid: "16401", schema: "public", name: "hello", args: "t text", returns: "text", language: "sql", security: "invoker", volatility: "volatile" },
];
const rlsRows = [{ schema: "public", name: "notes", rls_enabled: true, rls_forced: false, policy_count: 1 }];
const policyRows = [
  { name: "owner_only", table: "public.notes", command: "SELECT", roles: ["alice_authenticated"], using: "user_id = auth.uid()", with_check: null, permissive: true },
];
const KNOWN_FUNCTION_OID = 16401;

const pool = {
  connect: async () => client,
  async query(sql, params) {
    statements.push(sql);
    if (sql.includes("to_regclass($1)")) return { rows: params[0] === "public.profiles" ? describeRows : [] };
    // Only the lints select an `object`; they are matched first so they never
    // fall through to the catalog listings below.
    if (sql.includes("AS object")) {
      return { rows: sql.includes("NOT c.relrowsecurity") ? [{ object: "public.logs", relation: "public.logs" }] : [] };
    }
    if (sql.includes("FROM pg_proc p")) return { rows: functionRows };
    if (sql.includes("pg_get_functiondef")) {
      if (params[0] !== KNOWN_FUNCTION_OID) {
        throw Object.assign(new Error(`cache lookup failed for function ${params[0]}`), { code: "XX000" });
      }
      return { rows: [{ definition: "CREATE OR REPLACE FUNCTION public.hello(t text)\n RETURNS text\n..." }] };
    }
    if (sql.includes("relforcerowsecurity")) return { rows: rlsRows };
    if (sql.includes("FROM pg_policies")) return { rows: policyRows };
    if (sql.includes("FROM pg_class")) return { rows: listRows };
    throw new Error(`unexpected pool.query: ${sql.slice(0, 40)}`);
  },
};

const pools = {
  async forSlug(slug) {
    forSlugCalls.push(slug);
    return pool;
  },
};

const store = { get: async (slug) => (slug === "alice" ? { slug } : null) };
const adminPool = new Proxy({}, { get: (_t, prop) => { throw new Error(`adminPool touched: ${String(prop)}`); } });

const upgradeCalls = [];
const fnPasswords = [];
const upgradeAdminPool = { name: "the real admin pool" };
const upgradeConnection = { host: "db" };

let server;
let base;
let upgradeServer;
let upgradeBase;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/admin", adminRouter({ adminKey: ADMIN_KEY, adminPool, adminConnection: {}, store, pools }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/admin`;

  // `upgrade` is the one route that must reach for the admin role, so it gets a
  // server whose adminPool is a value it can be caught holding.
  const upgradeApp = express();
  upgradeApp.use(express.json());
  upgradeApp.use(
    "/admin",
    adminRouter({
      adminKey: ADMIN_KEY,
      adminPool: upgradeAdminPool,
      adminConnection: upgradeConnection,
      store: { ...store, setFnPassword: async (slug, password) => fnPasswords.push([slug, password]) },
      pools: { forSlug: async () => { throw new Error("upgrade must not open a collaborator pool"); } },
      provision: {
        upgradeCollaborator: async (pool, connection, slug) => {
          upgradeCalls.push({ pool, connection, slug });
          return { fnPassword: "f".repeat(48), dbName: `db_${slug}` };
        },
      },
    }),
  );
  upgradeApp.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => {
    upgradeServer = upgradeApp.listen(0, "127.0.0.1", resolve);
  });
  upgradeBase = `http://127.0.0.1:${upgradeServer.address().port}/admin`;
});

after(() => {
  server.close();
  upgradeServer.close();
});

async function post(path, body, headers = { "X-Admin-Key": ADMIN_KEY }, at = base) {
  const res = await fetch(`${at}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("both routes refuse a missing or wrong admin key with 401", async () => {
  for (const path of ["/collaborators/alice/tables", "/collaborators/alice/query"]) {
    assert.equal((await post(path, {}, {})).status, 401, path);
    assert.equal((await post(path, {}, { "X-Admin-Key": "nope" })).status, 401, path);
  }
  assert.deepEqual(forSlugCalls, []);
});

test("a slug outside the pattern is refused with 400 before anything else", async () => {
  const { status, body } = await post("/collaborators/Alice;drop/tables", {});
  assert.equal(status, 400);
  assert.match(body.error, /slug must match/);
  assert.deepEqual(forSlugCalls, []);
});

test("an unprovisioned slug is 404 and no pool is opened", async () => {
  assert.equal((await post("/collaborators/bob/tables", {})).status, 404);
  assert.equal((await post("/collaborators/bob/query", { sql: "select 1" })).status, 404);
  assert.deepEqual(forSlugCalls, []);
});

test("tables without a body lists the catalog through the collaborator's pool", async () => {
  const { status, body } = await post("/collaborators/alice/tables", {});
  assert.equal(status, 200);
  assert.deepEqual(body, { slug: "alice", tables: listRows });
  assert.deepEqual(forSlugCalls, ["alice"]);
  assert.ok(statements.at(-1).includes("estimated_rows"));
});

test("tables with a table describes it, 404 when the role cannot see it, 400 when malformed", async () => {
  const ok = await post("/collaborators/alice/tables", { table: "public.profiles" });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { slug: "alice", table: "public.profiles", columns: describeRows });

  const missing = await post("/collaborators/alice/tables", { table: "public.nope" });
  assert.equal(missing.status, 404);

  const before = statements.length;
  const malformed = await post("/collaborators/alice/tables", { table: "" });
  assert.equal(malformed.status, 400);
  assert.equal(statements.length, before, "nothing ran");
});

test("query refuses a bad body with 400 without executing", async () => {
  const before = statements.length;
  assert.equal((await post("/collaborators/alice/query", {})).status, 400);
  assert.equal((await post("/collaborators/alice/query", { sql: "select 1", limit: 0 })).status, 400);
  assert.equal(statements.length, before);
});

test("query runs read-only and answers columns, rows, rowCount and truncated", async () => {
  const { status, body } = await post("/collaborators/alice/query", { sql: "select x from t", limit: 1 });
  assert.equal(status, 200);
  assert.deepEqual(body, {
    slug: "alice",
    command: "SELECT",
    columns: [{ name: "x", type: "integer" }],
    rows: [[1]],
    rowCount: 2,
    truncated: true,
  });
  assert.ok(statements.includes("BEGIN READ ONLY"));
  assert.ok(statements.includes("COMMIT"));
});

test("the database's refusal comes back as 422 text with its SQLSTATE; our own failures stay 500", async () => {
  const refused = await post("/collaborators/alice/query", { sql: "insert into t values (1)" });
  assert.equal(refused.status, 422);
  assert.deepEqual(refused.body, { error: "cannot execute INSERT in a read-only transaction", code: "25006" });
  assert.equal(statements.at(-1), "ROLLBACK");

  const broken = await post("/collaborators/alice/query", { sql: "boom" });
  assert.equal(broken.status, 500);
  assert.equal(broken.body.error, "socket hang up");
});

const NEW_ROUTES = ["exec", "functions", "policies", "lint", "upgrade"];

test("every new route refuses a missing or wrong admin key with 401", async () => {
  const before = forSlugCalls.length;
  for (const route of NEW_ROUTES) {
    const path = `/collaborators/alice/${route}`;
    assert.equal((await post(path, {}, {})).status, 401, path);
    assert.equal((await post(path, {}, { "X-Admin-Key": "nope" })).status, 401, path);
  }
  assert.equal(forSlugCalls.length, before, "no pool was opened");
});

test("every new route refuses a slug outside the pattern with 400, before anything else", async () => {
  const before = statements.length;
  for (const route of NEW_ROUTES) {
    const { status, body } = await post(`/collaborators/Alice;drop/${route}`, {});
    assert.equal(status, 400, route);
    assert.match(body.error, /slug must match/);
  }
  assert.equal(statements.length, before);
});

test("every new route answers 404 for an unprovisioned slug without opening a pool", async () => {
  const before = forSlugCalls.length;
  for (const route of NEW_ROUTES) {
    const at = route === "upgrade" ? upgradeBase : base;
    const { status, body } = await post(`/collaborators/bob/${route}`, { statements: [{ sql: "update t set a = 1" }] }, { "X-Admin-Key": ADMIN_KEY }, at);
    assert.equal(status, 404, route);
    assert.equal(body.error, "not provisioned");
  }
  assert.equal(forSlugCalls.length, before);
  assert.deepEqual(upgradeCalls, [], "an unprovisioned slug is refused before the plan runs");
});

test("exec refuses a malformed batch with 400 without executing anything", async () => {
  const before = statements.length;
  for (const body of [{}, { statements: [] }, { statements: [{ sql: "" }] }, { statements: [{ sql: "select 1", expectRowCount: -1 }] }]) {
    const { status } = await post("/collaborators/alice/exec", body);
    assert.equal(status, 400, JSON.stringify(body));
  }
  assert.equal(statements.length, before);
});

test("exec runs the batch through the collaborator's own pool and answers one result per statement", async () => {
  updateRowCount = 1;
  const { status, body } = await post("/collaborators/alice/exec", {
    statements: [{ sql: "update t set a = 1 where id = $1", params: [7], expectRowCount: 1 }, { sql: "delete from t where b = 2" }],
  });
  assert.equal(status, 200);
  assert.deepEqual(body, { slug: "alice", results: [{ command: "UPDATE", rowCount: 1 }, { command: "DELETE", rowCount: 3 }] });
  assert.equal(forSlugCalls.at(-1), "alice");
  assert.ok(statements.includes("BEGIN"));
  assert.equal(statements.at(-1), "COMMIT");
});

test("exec answers 409 with index, expected and got when a statement misses its row count", async () => {
  updateRowCount = 0;
  const { status, body } = await post("/collaborators/alice/exec", {
    statements: [{ sql: "update t set a = 1", expectRowCount: 1 }],
  });
  updateRowCount = 1;
  assert.equal(status, 409);
  assert.equal(body.index, 0);
  assert.equal(body.expected, 1);
  assert.equal(body.got, 0);
  assert.equal(statements.at(-1), "ROLLBACK");
});

test("exec answers 422 with the database's own text and SQLSTATE", async () => {
  const { status, body } = await post("/collaborators/alice/exec", { statements: [{ sql: "drop table gone" }] });
  assert.equal(status, 422);
  assert.deepEqual(body, { error: 'relation "gone" does not exist', code: "42P01" });
  assert.equal(statements.at(-1), "ROLLBACK");
});

test("a failure that is not the database's keeps exec at 500", async () => {
  const { status, body } = await post("/collaborators/alice/exec", { statements: [{ sql: "boom" }] });
  assert.equal(status, 500);
  assert.equal(body.error, "socket hang up");
});

test("functions with an empty body lists what pg_proc holds, shaped", async () => {
  const { status, body } = await post("/collaborators/alice/functions", {});
  assert.equal(status, 200);
  assert.deepEqual(body, {
    slug: "alice",
    functions: [{ oid: 16401, schema: "public", name: "hello", args: "t text", returns: "text", language: "sql", security: "invoker", volatility: "volatile" }],
  });
});

test("functions with an oid answers the definition Postgres re-prints", async () => {
  const { status, body } = await post("/collaborators/alice/functions", { oid: KNOWN_FUNCTION_OID });
  assert.equal(status, 200);
  assert.equal(body.oid, KNOWN_FUNCTION_OID);
  assert.match(body.definition, /^CREATE OR REPLACE FUNCTION public\.hello/);
});

test("functions refuses a malformed oid with 400 and an unknown one with 404", async () => {
  const before = statements.length;
  for (const oid of [0, -1, 1.5, "16401"]) {
    assert.equal((await post("/collaborators/alice/functions", { oid })).status, 400, String(oid));
  }
  assert.equal(statements.length, before, "nothing ran");
  const missing = await post("/collaborators/alice/functions", { oid: 99999 });
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /no function with oid 99999/);
});

test("policies answers the RLS state of each table with its policies attached", async () => {
  const { status, body } = await post("/collaborators/alice/policies", {});
  assert.equal(status, 200);
  assert.deepEqual(body, {
    slug: "alice",
    tables: [
      {
        table: { schema: "public", name: "notes" },
        rls: "on",
        policies: [{ name: "owner_only", command: "SELECT", roles: ["alice_authenticated"], using: "user_id = auth.uid()", withCheck: null, permissive: true }],
      },
    ],
  });
});

test("lint answers the findings and the instant of the check", async () => {
  const { status, body } = await post("/collaborators/alice/lint", {});
  assert.equal(status, 200);
  assert.equal(body.slug, "alice");
  assert.ok(!Number.isNaN(Date.parse(body.checkedAt)), "checkedAt is a timestamp");
  assert.deepEqual(body.findings.map((f) => [f.id, f.severity, f.object]), [["rls_disabled", "warn", "public.logs"]]);
  assert.equal(body.findings[0].fixSql, "ALTER TABLE public.logs ENABLE ROW LEVEL SECURITY");
});

test("upgrade applies the shared plan with the admin role and stores the new _fn password", async () => {
  const { status, body } = await post("/collaborators/alice/upgrade", {}, { "X-Admin-Key": ADMIN_KEY }, upgradeBase);
  assert.equal(status, 200);
  assert.deepEqual(body, { slug: "alice", upgraded: true });
  assert.deepEqual(upgradeCalls, [{ pool: upgradeAdminPool, connection: upgradeConnection, slug: "alice" }]);
  assert.deepEqual(fnPasswords, [["alice", "f".repeat(48)]]);
});

test("the adminPool is never touched by exec, functions, policies or lint", async () => {
  // `adminPool` on the main server is a Proxy that throws on any access, and
  // every call above went through it without a single 500 from that Proxy.
  for (const [route, body] of [
    ["exec", { statements: [{ sql: "update t set a = 1" }] }],
    ["functions", {}],
    ["policies", {}],
    ["lint", {}],
  ]) {
    const res = await post(`/collaborators/alice/${route}`, body);
    assert.equal(res.status, 200, route);
    assert.ok(!JSON.stringify(res.body).includes("adminPool touched"), route);
  }
});

test("every data route reaches the database only through the collaborator's own pool", async () => {
  const before = forSlugCalls.length;
  await post("/collaborators/alice/functions", {});
  await post("/collaborators/alice/policies", {});
  await post("/collaborators/alice/lint", {});
  assert.deepEqual(forSlugCalls.slice(before), ["alice", "alice", "alice"]);
});

test("exec time-boxes the batch, so a runaway statement cannot hold the collaborator's pool", async () => {
  statements.length = 0;
  await post("/collaborators/alice/exec", { statements: [{ sql: "update t set a = 1" }] });
  assert.ok(statements.includes("SET LOCAL statement_timeout = 10000"), "the default ceiling is 10 s");
  statements.length = 0;
  await post("/collaborators/alice/exec", { statements: [{ sql: "update t set a = 1" }], timeoutMs: 2000 });
  assert.ok(statements.includes("SET LOCAL statement_timeout = 2000"), "the caller may ask for less");
});

test("the new routes exist only as POST", async () => {
  for (const route of NEW_ROUTES) {
    const at = route === "upgrade" ? upgradeBase : base;
    const res = await fetch(`${at}/collaborators/alice/${route}`, { headers: { "X-Admin-Key": ADMIN_KEY } });
    assert.equal(res.status, 404, `GET /${route}`);
    await res.arrayBuffer();
  }
});
