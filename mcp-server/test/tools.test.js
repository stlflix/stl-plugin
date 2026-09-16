import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { decrypt } from "../src/crypto.js";
import { callTool, defineTools } from "../src/tools.js";

/**
 * Every tool runs against a fake pool that records what it was asked. A tool
 * that refuses a name must leave that record untouched: the refusal happens
 * before the database is reached (BL-26).
 */
const CREDENTIALS_KEY = Buffer.alloc(32, 7);

function harness(answer = () => ({ rows: [] }), { adminPool, fetchImpl, functionsUrl } = {}) {
  const statements = [];
  const client = {
    async query(q, params) {
      const text = typeof q === "string" ? q : q.text;
      statements.push(text);
      return answer(text, params ?? (typeof q === "string" ? [] : q.values)) ?? { command: "ALTER", rowCount: null, rows: [] };
    },
    release() {},
  };
  const pool = {
    connect: async () => client,
    async query(sql, params) {
      statements.push(sql);
      return answer(sql, params) ?? { rows: [] };
    },
  };
  const tools = defineTools({
    pools: { forSlug: async () => pool },
    adminPool,
    credentialsKey: CREDENTIALS_KEY,
    functionsUrl,
    fetchImpl,
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    tools,
    statements,
    call: (name, args = {}) => byName.get(name).handler("alice", args),
    invoke: (name, args = {}) => callTool(byName.get(name), "alice", args),
  };
}

const CATALOG_TOOLS = ["list_functions", "get_function", "list_policies", "set_rls", "create_policy", "drop_policy", "security_lint"];
const EDGE_TOOLS = ["list_edge_functions", "deploy_edge_function", "invoke_edge_function", "set_secrets", "list_allowed_origins", "add_allowed_origin"];
const NEW_TOOLS = [...CATALOG_TOOLS, ...EDGE_TOOLS];

test("the eighteen tools of the connector, in order and by name", () => {
  const { tools } = harness();
  assert.deepEqual(tools.map((t) => t.name), [
    "list_tables", "describe_table", "run_sql", "apply_migration", "list_migrations",
    ...CATALOG_TOOLS,
    ...EDGE_TOOLS,
  ]);
  assert.equal(tools.length, 18);
});

test("every new tool declares a title, a description, an input schema and a handler", () => {
  const { tools } = harness();
  for (const tool of tools.filter((t) => NEW_TOOLS.includes(t.name))) {
    assert.ok(tool.title, tool.name);
    assert.ok(tool.description.length > 20, tool.name);
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(typeof tool.handler, "function", tool.name);
  }
});

test("list_functions answers pg_proc, shaped", async () => {
  const row = { oid: "16401", schema: "public", name: "hello", args: "t text", returns: "text", language: "sql", security: "definer", volatility: "stable" };
  const { call, statements } = harness((sql) => (sql.includes("FROM pg_proc p") ? { rows: [row] } : { rows: [] }));
  assert.deepEqual(await call("list_functions"), [{ ...row, oid: 16401 }]);
  assert.ok(statements[0].includes("pg_get_function_arguments"));
});

test("get_function answers the definition, and refuses a bad oid without touching the database", async () => {
  const { call, statements } = harness((sql) =>
    sql.includes("pg_get_functiondef") ? { rows: [{ definition: "CREATE OR REPLACE FUNCTION public.hello(t text)" }] } : { rows: [] },
  );
  assert.deepEqual(await call("get_function", { oid: 16401 }), { oid: 16401, definition: "CREATE OR REPLACE FUNCTION public.hello(t text)" });
  const before = statements.length;
  for (const oid of [0, -1, 1.5, "16401", undefined]) {
    await assert.rejects(call("get_function", { oid }), /oid must be a positive integer/, String(oid));
  }
  assert.equal(statements.length, before, "nothing ran");
});

test("get_function says so when the oid is no function of theirs", async () => {
  const { call } = harness(() => ({ rows: [] }));
  await assert.rejects(call("get_function", { oid: 99999 }), /no function with oid 99999 in your database/);
});

test("list_policies answers the RLS state with the policies grouped by table", async () => {
  const { call } = harness((sql) => {
    if (sql.includes("relforcerowsecurity")) return { rows: [{ schema: "public", name: "notes", rls_enabled: true, rls_forced: true, policy_count: 1 }] };
    if (sql.includes("FROM pg_policies")) {
      return { rows: [{ name: "owner_only", table: "public.notes", command: "SELECT", roles: ["alice_authenticated"], using: "user_id = auth.uid()", with_check: null, permissive: true }] };
    }
    return { rows: [] };
  });
  assert.deepEqual(await call("list_policies"), [
    {
      table: { schema: "public", name: "notes" },
      rls: "forced",
      policies: [{ name: "owner_only", command: "SELECT", roles: ["alice_authenticated"], using: "user_id = auth.uid()", withCheck: null, permissive: true }],
    },
  ]);
});

test("set_rls runs exactly the statement policy-sql wrote, in one transaction", async () => {
  const { call, statements } = harness();
  const out = await call("set_rls", { table: "notes", mode: "enable" });
  assert.equal(out.sql, 'ALTER TABLE "public"."notes" ENABLE ROW LEVEL SECURITY');
  assert.deepEqual(statements, ["BEGIN", "SET LOCAL statement_timeout = 10000", out.sql, "COMMIT"]);
});

test("set_rls refuses a name or a mode outside the contract without touching the database", async () => {
  const { call, statements } = harness();
  for (const args of [{ table: "Notes", mode: "enable" }, { table: "notes;drop", mode: "enable" }, { table: "notes", mode: "on" }, { table: "notes", schema: "Public", mode: "enable" }]) {
    await assert.rejects(call("set_rls", args), JSON.stringify(args));
  }
  assert.deepEqual(statements, []);
});

test("create_policy runs exactly the statement policy-sql wrote", async () => {
  const { call, statements } = harness();
  const out = await call("create_policy", { table: "notes", name: "owner_only", command: "SELECT", roles: ["alice_authenticated"], using: "user_id = auth.uid()" });
  assert.equal(out.sql, 'CREATE POLICY "owner_only" ON "public"."notes" AS PERMISSIVE FOR SELECT TO "alice_authenticated" USING (user_id = auth.uid())');
  assert.ok(statements.includes(out.sql));
  assert.equal(statements.at(-1), "COMMIT");
});

test("create_policy refuses a bad policy name or role without touching the database", async () => {
  const { call, statements } = harness();
  for (const args of [
    { table: "notes", name: "Owner Only", roles: ["alice_anon"] },
    { table: "notes", name: "owner_only", roles: ["alice; drop"] },
    { table: "notes", name: "owner_only", roles: [] },
    { table: "notes", name: "owner_only", roles: ["alice_anon"], command: "GRANT" },
  ]) {
    await assert.rejects(call("create_policy", args), JSON.stringify(args));
  }
  assert.deepEqual(statements, []);
});

test("drop_policy runs the DROP it wrote, and refuses a bad name without touching the database", async () => {
  const { call, statements } = harness();
  const out = await call("drop_policy", { schema: "app", table: "notes", name: "owner_only" });
  assert.equal(out.sql, 'DROP POLICY "owner_only" ON "app"."notes"');
  assert.ok(statements.includes(out.sql));
  const before = statements.length;
  await assert.rejects(call("drop_policy", { table: "notes", name: "Owner Only" }));
  await assert.rejects(call("drop_policy", { table: "Notes", name: "owner_only" }));
  assert.equal(statements.length, before);
});

test("security_lint answers the findings, worst first", async () => {
  const { call, statements } = harness((sql) => {
    if (sql.includes("NOT c.relrowsecurity")) return { rows: [{ object: "public.logs", relation: "public.logs" }] };
    if (sql.includes("p.prosecdef") && sql.includes("has_function_privilege")) return { rows: [{ object: "public.hello(text)", signature: "public.hello(text)" }] };
    return { rows: [] };
  });
  const findings = await call("security_lint");
  assert.equal(statements.length, 8, "all eight lints ran");
  assert.deepEqual(findings.map((f) => [f.id, f.severity]), [["definer_executable_by_public", "error"], ["rls_disabled", "warn"]]);
  assert.equal(findings[0].fixSql, "REVOKE EXECUTE ON FUNCTION public.hello(text) FROM PUBLIC");
});

test("the catalog SQL is written once: only catalog.js knows pg_policies", () => {
  const dir = new URL("../src/", import.meta.url);
  const owners = readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .filter((f) => readFileSync(new URL(f, dir), "utf8").includes("pg_policies"));
  assert.deepEqual(owners, ["catalog.js"]);
  for (const file of ["tools.js", "admin.js"]) {
    const source = readFileSync(new URL(file, dir), "utf8");
    assert.match(source, /from "\.\/catalog\.js"/, file);
    assert.doesNotMatch(source, /FROM pg_(proc|class|policy)\b/, `${file} writes no catalog SQL of its own`);
  }
});

/**
 * The Edge Function and origin tools. The database is the same fake pool; the
 * registry is a second one, because origins live in `stl_mcp` and not in the
 * collaborator's database. The network is a fake too: `invoke_edge_function` is
 * judged by the request it makes, headers included.
 */
function registryPool() {
  const rows = [];
  const calls = [];
  return {
    rows,
    calls,
    async query(sql, params = []) {
      calls.push(sql);
      if (sql.includes("INSERT INTO stl_mcp.allowed_origins")) {
        if (rows.some((r) => r.origin === params[0])) return { rows: [], rowCount: 0 };
        rows.push({ origin: params[0], slug: params[1], created_at: "2026-09-16T00:00:00.000Z" });
        return { rows: [{ origin: params[0] }], rowCount: 1 };
      }
      if (sql.includes("WHERE slug = $1")) return { rows: rows.filter((r) => r.slug === params[0]) };
      if (sql.includes("WHERE origin = $1")) return { rows: rows.filter((r) => r.origin === params[0]) };
      throw new Error(`unexpected registry query: ${sql.slice(0, 40)}`);
    },
  };
}

function edgeAnswer(state) {
  return (sql, params = []) => {
    if (sql.includes("SELECT source FROM buildloop.edge_function_versions")) {
      return { rows: state.draft === null ? [] : [{ source: state.draft }] };
    }
    if (sql.includes("SELECT current_version FROM buildloop.edge_functions")) {
      return { rows: [{ current_version: state.version }] };
    }
    if (sql.includes("INSERT INTO buildloop.edge_function_versions") && params[1] > 0) {
      state.published = { version: params[1], bundle: params[3] };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO buildloop.edge_function_versions")) {
      state.draft = params[2];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE buildloop.edge_functions SET current_version")) {
      state.version = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO buildloop.edge_function_secrets")) {
      state.secrets.push({ key: params[1], value_enc: params[2] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT key FROM buildloop.edge_function_secrets")) {
      return { rows: state.secrets.map((s) => ({ key: s.key })) };
    }
    if (sql.includes("FROM buildloop.edge_functions f")) {
      return { rows: [{ name: "hello", current_version: state.version, updated_at: null, published_at: "2026-09-16T00:00:00.000Z", secret_keys: state.secrets.map((s) => s.key) }] };
    }
    return { rows: [] };
  };
}

const HELLO = 'export default () => new Response("hi")';

test("every edge and origin tool declares a title, a description, an input schema and a handler", () => {
  const { tools } = harness();
  for (const tool of tools.filter((t) => EDGE_TOOLS.includes(t.name))) {
    assert.ok(tool.title, tool.name);
    assert.ok(tool.description.length > 20, tool.name);
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(typeof tool.handler, "function", tool.name);
  }
});

test("list_edge_functions answers the live version and the keys of the secrets, never a value", async () => {
  const state = { draft: HELLO, version: 2, secrets: [{ key: "TOKEN", value_enc: "cipher" }] };
  const { call } = harness(edgeAnswer(state));
  const listed = await call("list_edge_functions");
  assert.deepEqual(listed.map((f) => [f.name, f.currentVersion, f.secretKeys]), [["hello", 2, ["TOKEN"]]]);
  assert.ok(!JSON.stringify(listed).includes("cipher"));
});

test("deploy_edge_function saves and publishes in one step", async () => {
  const state = { draft: null, version: 0, secrets: [] };
  const { call } = harness(edgeAnswer(state));
  const out = await call("deploy_edge_function", { name: "hello", source: HELLO });
  assert.equal(out.version, 1);
  assert.equal(state.draft, HELLO, "the source was saved before it was published");
  assert.match(state.published.bundle, /new Response\("hi"\)/);
});

test("deploy_edge_function of a source that does not compile answers isError with line:column", async () => {
  const state = { draft: null, version: 3, secrets: [] };
  const { invoke } = harness(edgeAnswer(state));
  const result = await invoke("deploy_edge_function", { name: "hello", source: "export default (" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unexpected end of file at 1:16/);
  assert.equal(state.version, 3, "the version that was live is still live");
  assert.equal(state.published, undefined, "nothing was published");
});

test("callTool answers a successful tool as text and never marks it an error", async () => {
  const state = { draft: HELLO, version: 1, secrets: [] };
  const { invoke } = harness(edgeAnswer(state));
  const result = await invoke("list_edge_functions");
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text).map((f) => f.name), ["hello"]);
});

test("deploy_edge_function refuses a name outside the pattern without touching the database", async () => {
  const { call, statements } = harness(edgeAnswer({ draft: null, version: 0, secrets: [] }));
  for (const name of ["Hello", "hello_world", "1hello", "hello;drop"]) {
    await assert.rejects(call("deploy_edge_function", { name, source: HELLO }), /name must match/, name);
  }
  assert.deepEqual(statements, []);
});

test("invoke_edge_function calls the function's own URL and sends NO bearer token", async () => {
  const seen = [];
  const { call } = harness(undefined, {
    functionsUrl: "https://db.stlflix.com.br",
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { status: 200, text: async () => "hi" };
    },
  });
  const out = await call("invoke_edge_function", { name: "hello" });
  assert.deepEqual(out, { url: "https://db.stlflix.com.br/fn/alice/hello", status: 200, body: "hi" });
  assert.equal(seen[0].init.method, "GET");
  const headers = seen[0].init.headers ?? {};
  assert.ok(!Object.keys(headers).some((h) => /authorization/i.test(h)), "the tool runs as the anonymous role");
});

test("invoke_edge_function carries the method and the body it was given", async () => {
  const seen = [];
  const { call } = harness(undefined, {
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { status: 404, text: async () => "not found" };
    },
  });
  const out = await call("invoke_edge_function", { name: "hello", method: "POST", body: '{"a":1}' });
  assert.equal(out.status, 404);
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.body, '{"a":1}');
  assert.equal(seen[0].url, "http://functions:8300/fn/alice/hello", "the default URL is the runtime inside the network");
});

test("invoke_edge_function refuses a bad name without reaching the network", async () => {
  const seen = [];
  const { call } = harness(undefined, { fetchImpl: async (...args) => (seen.push(args), { status: 200, text: async () => "" }) });
  await assert.rejects(call("invoke_edge_function", { name: "Hello" }), /name must match/);
  assert.deepEqual(seen, []);
});

test("set_secrets stores the value encrypted and answers only the keys", async () => {
  const state = { draft: HELLO, version: 1, secrets: [] };
  const { call } = harness(edgeAnswer(state));
  const out = await call("set_secrets", { name: "hello", secrets: { TOKEN: "t0p" } });
  assert.deepEqual(out, { name: "hello", keys: ["TOKEN"] });
  assert.equal(decrypt(state.secrets[0].value_enc, CREDENTIALS_KEY), "t0p");
  assert.ok(!JSON.stringify(out).includes("t0p"));
});

test("list_allowed_origins reads the registry, and only the token's own slug", async () => {
  const registry = registryPool();
  registry.rows.push({ origin: "https://app.x.com", slug: "alice" }, { origin: "https://bob.x.com", slug: "bob" });
  const { call, statements } = harness(undefined, { adminPool: registry });
  assert.deepEqual((await call("list_allowed_origins")).map((o) => o.origin), ["https://app.x.com"]);
  assert.deepEqual(statements, [], "the collaborator's own database was never opened");
});

test("add_allowed_origin registers for the token's slug and refuses what is not an origin", async () => {
  const registry = registryPool();
  const { call } = harness(undefined, { adminPool: registry });
  assert.deepEqual(await call("add_allowed_origin", { origin: "https://app.x.com/" }), {
    origin: "https://app.x.com",
    slug: "alice",
    created: true,
  });
  assert.deepEqual(registry.rows.map((r) => [r.origin, r.slug]), [["https://app.x.com", "alice"]]);
  for (const origin of ["http://example.com", "https://a.com/path", "nonsense"]) {
    await assert.rejects(call("add_allowed_origin", { origin }), /origin must be https/, origin);
  }
  assert.equal(registry.rows.length, 1);
});

test("an origin another collaborator owns is refused, with the conflict as the tool's error", async () => {
  const registry = registryPool();
  registry.rows.push({ origin: "https://app.x.com", slug: "bob" });
  const { invoke } = harness(undefined, { adminPool: registry });
  const result = await invoke("add_allowed_origin", { origin: "https://app.x.com" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already registered by another collaborator/);
});
