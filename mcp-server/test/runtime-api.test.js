import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import { adminRouter } from "../src/admin.js";
import { encrypt } from "../src/crypto.js";
import { runtimeRouter } from "../src/runtime-api.js";

/**
 * One server with BOTH routers mounted the way `server.js` mounts them, so the
 * test can prove what I5 claims: the admin key does not open the runtime
 * surface and the runtime key does not open the admin surface. Neither router
 * ever sees a real database.
 */
const ADMIN_KEY = "k".repeat(32);
const RUNTIME_KEY = "r".repeat(32);
const CREDENTIALS_KEY = Buffer.alloc(32, 7);
const OWNER_PASSWORD = "the-owner-password";

const forSlugCalls = [];
const pool = {
  async query(sql, params) {
    if (sql.includes("JOIN buildloop.edge_function_versions v")) {
      return params[0] === "hello"
        ? { rows: [{ current_version: 3, bundle: "export default () => new Response(\"hi\");" }] }
        : { rows: [] };
    }
    if (sql.includes("SELECT key, value_enc FROM buildloop.edge_function_secrets")) {
      return { rows: [{ key: "TOKEN", value_enc: encrypt("t0p", CREDENTIALS_KEY) }] };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 40)}`);
  },
};

const store = {
  get: async (slug) => (slug === "alice" ? { slug } : null),
  fnConnectionFor: async (slug) =>
    slug === "alice" ? { database: "db_alice", user: "alice_fn", password: "the-fn-password" } : null,
  // Present so that a mistake here would be visible: the owner's credential
  // exists on the same store and must never be what the runtime gets.
  connectionFor: async (slug) => (slug === "alice" ? { database: "db_alice", user: slug, password: OWNER_PASSWORD } : null),
};

const adminPool = new Proxy({}, { get: (_t, prop) => { throw new Error(`adminPool touched: ${String(prop)}`); } });
const adminForSlugCalls = [];
const pools = {
  // The bundle and its secrets are read with the admin role INSIDE the slug's
  // database (AD-009): `edge_function_secrets` is revoked from the slug, so its
  // own pool could not read what the runtime asks for.
  forSlug: async (slug) => (forSlugCalls.push(slug), pool),
  adminForSlug: async (slug) => (adminForSlugCalls.push(slug), pool),
};

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/admin/runtime", runtimeRouter({ runtimeKey: RUNTIME_KEY, credentialsKey: CREDENTIALS_KEY, store, pools }));
  app.use("/admin", adminRouter({ adminKey: ADMIN_KEY, adminPool, adminConnection: {}, credentialsKey: CREDENTIALS_KEY, store, pools }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function post(path, headers) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text) };
}

test("the runtime surface refuses a missing or wrong runtime key with 401", async () => {
  for (const path of ["/admin/runtime/credential/alice", "/admin/runtime/function/alice/hello"]) {
    assert.equal((await post(path, {})).status, 401, path);
    assert.equal((await post(path, { "X-Runtime-Key": "nope" })).status, 401, path);
  }
});

test("the admin key does not open the runtime surface", async () => {
  for (const path of ["/admin/runtime/credential/alice", "/admin/runtime/function/alice/hello"]) {
    const { status, body } = await post(path, { "X-Admin-Key": ADMIN_KEY });
    assert.equal(status, 401, path);
    assert.equal(body.error, "invalid runtime key");
  }
});

test("the runtime key does not open the admin surface", async () => {
  for (const path of ["/admin/collaborators/alice/token", "/admin/collaborators/alice/exec", "/admin/tickets/consume"]) {
    const { status, body } = await post(path, { "X-Runtime-Key": RUNTIME_KEY });
    assert.equal(status, 401, path);
    assert.equal(body.error, "invalid admin key");
  }
});

test("credential answers the _fn role of that slug, and never the owner's password", async () => {
  const { status, body } = await post("/admin/runtime/credential/alice", { "X-Runtime-Key": RUNTIME_KEY });
  assert.equal(status, 200);
  assert.deepEqual(body, { slug: "alice", database: "db_alice", user: "alice_fn", password: "the-fn-password" });
  assert.match(body.user, /_fn$/);
  assert.ok(!JSON.stringify(body).includes(OWNER_PASSWORD), "the owner's credential stays in the server");
});

test("credential answers 404 for a slug with no execution role yet, and 400 for a slug outside the pattern", async () => {
  assert.equal((await post("/admin/runtime/credential/bob", { "X-Runtime-Key": RUNTIME_KEY })).status, 404);
  const bad = await post("/admin/runtime/credential/Alice;drop", { "X-Runtime-Key": RUNTIME_KEY });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /slug must match/);
});

test("function answers the published version, its bundle and the secrets decrypted", async () => {
  const before = forSlugCalls.length;
  const beforeAdmin = adminForSlugCalls.length;
  const { status, body } = await post("/admin/runtime/function/alice/hello", { "X-Runtime-Key": RUNTIME_KEY });
  assert.equal(status, 200);
  assert.equal(body.version, 3);
  assert.match(body.bundle, /new Response/);
  assert.deepEqual(body.secrets, { TOKEN: "t0p" });
  assert.deepEqual(adminForSlugCalls.slice(beforeAdmin), ["alice"], "read with the admin role, in the slug's database");
  assert.equal(forSlugCalls.length, before, "the slug's own role cannot read its secrets");
});

test("function answers 404 for a function with no published version and for an unprovisioned slug", async () => {
  assert.equal((await post("/admin/runtime/function/alice/draft-only", { "X-Runtime-Key": RUNTIME_KEY })).status, 404);
  assert.equal((await post("/admin/runtime/function/bob/hello", { "X-Runtime-Key": RUNTIME_KEY })).status, 404);
});

test("function refuses a name outside the pattern with 400 before opening a pool", async () => {
  const before = forSlugCalls.length;
  const beforeAdmin = adminForSlugCalls.length;
  const { status, body } = await post("/admin/runtime/function/alice/Hello", { "X-Runtime-Key": RUNTIME_KEY });
  assert.equal(status, 400);
  assert.match(body.error, /name must match/);
  assert.equal(forSlugCalls.length, before);
  assert.equal(adminForSlugCalls.length, beforeAdmin);
});

test("nothing else exists behind the runtime key", async () => {
  for (const path of ["/admin/runtime", "/admin/runtime/provision/alice", "/admin/runtime/exec"]) {
    const { status, body } = await post(path, { "X-Runtime-Key": RUNTIME_KEY });
    assert.equal(status, 404, path);
    assert.equal(body.error, "not found");
  }
});

test("the runtime surface never touches the adminPool", async () => {
  const res = await post("/admin/runtime/credential/alice", { "X-Runtime-Key": RUNTIME_KEY });
  assert.equal(res.status, 200);
  assert.ok(!JSON.stringify(res.body).includes("adminPool touched"));
});
