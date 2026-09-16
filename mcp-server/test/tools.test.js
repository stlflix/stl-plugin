import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { defineTools } from "../src/tools.js";

/**
 * Every tool runs against a fake pool that records what it was asked. A tool
 * that refuses a name must leave that record untouched: the refusal happens
 * before the database is reached (BL-26).
 */
function harness(answer = () => ({ rows: [] })) {
  const statements = [];
  const client = {
    async query(q) {
      const text = typeof q === "string" ? q : q.text;
      statements.push(text);
      return answer(text) ?? { command: "ALTER", rowCount: null, rows: [] };
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
  const tools = defineTools({ pools: { forSlug: async () => pool } });
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { tools, statements, call: (name, args = {}) => byName.get(name).handler("alice", args) };
}

const NEW_TOOLS = ["list_functions", "get_function", "list_policies", "set_rls", "create_policy", "drop_policy", "security_lint"];

test("the seven new tools join the five that already existed", () => {
  const { tools } = harness();
  assert.deepEqual(tools.map((t) => t.name), [
    "list_tables", "describe_table", "run_sql", "apply_migration", "list_migrations",
    ...NEW_TOOLS,
  ]);
  assert.equal(tools.length, 12);
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
