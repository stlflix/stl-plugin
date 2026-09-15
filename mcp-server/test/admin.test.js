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

const client = {
  async query(q) {
    const text = typeof q === "string" ? q : q.text;
    statements.push(text);
    if (text.startsWith("SELECT oid, format_type")) return { rows: [{ oid: 23, name: "integer" }] };
    if (/^insert/i.test(text)) throw Object.assign(new Error("cannot execute INSERT in a read-only transaction"), { code: "25006" });
    if (/^boom/i.test(text)) throw new Error("socket hang up");
    if (text.startsWith("select")) return { command: "SELECT", fields: [{ name: "x", dataTypeID: 23 }], rows: [[1], [2]] };
    return { rows: [] };
  },
  release() {},
};

const pool = {
  connect: async () => client,
  async query(sql, params) {
    statements.push(sql);
    if (sql.includes("FROM pg_class")) return { rows: listRows };
    if (sql.includes("to_regclass($1)")) return { rows: params[0] === "public.profiles" ? describeRows : [] };
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

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/admin", adminRouter({ adminKey: ADMIN_KEY, adminPool, adminConnection: {}, store, pools }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/admin`;
});

after(() => server.close());

async function post(path, body, headers = { "X-Admin-Key": ADMIN_KEY }) {
  const res = await fetch(`${base}${path}`, {
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
