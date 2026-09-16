import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  DESCRIBE_SQL,
  FUNCTIONS_SQL,
  FUNCTION_DEF_SQL,
  LIST_TABLES_SQL,
  POLICIES_SQL,
  RLS_STATE_SQL,
  TABLE_POLICIES_SQL,
  rowsToFunctions,
  rowsToRlsState,
} from "../src/catalog.js";

test("the table listing carries a planner estimate, unknown when never analyzed", () => {
  assert.match(LIST_TABLES_SQL, /AS estimated_rows/);
  assert.match(LIST_TABLES_SQL, /reltuples < 0 THEN NULL/);
  assert.match(LIST_TABLES_SQL, /NOT IN \('pg_catalog', 'information_schema', 'pg_toast'\)/);
  assert.match(DESCRIBE_SQL, /to_regclass\(\$1\)/);
  assert.match(TABLE_POLICIES_SQL, /pg_policies/);
});

test("tools.js consumes the catalog instead of defining its own copy", () => {
  const source = readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");
  assert.match(source, /from "\.\/catalog\.js"/);
  assert.doesNotMatch(source, /const LIST_TABLES_SQL|const DESCRIBE_SQL|const POLICIES_SQL/);
});

test("the function listing reads pg_proc and hides the schemas the collaborator does not own", () => {
  assert.match(FUNCTIONS_SQL, /FROM pg_proc p/);
  assert.match(FUNCTIONS_SQL, /JOIN pg_namespace n ON n\.oid = p\.pronamespace/);
  for (const schema of ["pg_catalog", "information_schema", "auth", "buildloop"]) {
    assert.ok(FUNCTIONS_SQL.includes(`'${schema}'`), schema);
  }
});

test("every \"char\" catalog column is cast to text before it is compared", () => {
  // Without the cast Postgres answers `operator is not unique: "char" = unknown`.
  assert.match(FUNCTIONS_SQL, /p\.provolatile::text/);
  assert.match(FUNCTIONS_SQL, /p\.prokind::text = 'f'/);
  assert.match(RLS_STATE_SQL, /c\.relkind::text = ANY/);
  // `pg_policies` already resolves `polcmd`, so no raw "char" column is read here.
  assert.doesNotMatch(POLICIES_SQL, /polcmd/);
});

test("a function row carries what the Studio shows, and the definition comes from Postgres", () => {
  for (const column of ["AS oid", "AS schema", "AS name", "AS args", "AS returns", "AS language", "AS security", "AS volatility"]) {
    assert.ok(FUNCTIONS_SQL.includes(column), column);
  }
  assert.match(FUNCTION_DEF_SQL, /pg_get_functiondef\(\$1/);
});

test("rowsToFunctions shapes the rows: oid as a number, security and volatility as words", () => {
  const rows = [{ oid: "16401", schema: "public", name: "hello", args: "t text", returns: "text", language: "sql", security: "invoker", volatility: "volatile" }];
  assert.deepEqual(rowsToFunctions(rows), [
    { oid: 16401, schema: "public", name: "hello", args: "t text", returns: "text", language: "sql", security: "invoker", volatility: "volatile" },
  ]);
  assert.equal(rowsToFunctions([{ oid: 1, args: null }])[0].args, "");
});

test("the policy listing normalizes pg_policies into the shape the Studio renders", () => {
  assert.match(POLICIES_SQL, /FROM pg_policies/);
  for (const column of ['AS name', 'AS "table"', "AS command", "AS roles", 'AS "using"', "with_check", "AS permissive"]) {
    assert.ok(POLICIES_SQL.includes(column), column);
  }
  assert.match(POLICIES_SQL, /permissive = 'PERMISSIVE' AS permissive/);
});

test("rowsToRlsState answers off/on/forced and keeps an empty list when RLS has no policy", () => {
  const rows = [
    { schema: "public", name: "notes", rls_enabled: true, rls_forced: false, policy_count: 1 },
    { schema: "public", name: "logs", rls_enabled: true, rls_forced: true, policy_count: 0 },
    { schema: "public", name: "plain", rls_enabled: false, rls_forced: false, policy_count: 0 },
  ];
  const policies = [
    { name: "owner_only", table: "public.notes", command: "SELECT", roles: ["alice_authenticated"], using: "user_id = auth.uid()", with_check: null, permissive: true },
  ];
  assert.deepEqual(rowsToRlsState(rows, policies), [
    {
      table: { schema: "public", name: "notes" },
      rls: "on",
      policies: [{ name: "owner_only", command: "SELECT", roles: ["alice_authenticated"], using: "user_id = auth.uid()", withCheck: null, permissive: true }],
    },
    { table: { schema: "public", name: "logs" }, rls: "forced", policies: [] },
    { table: { schema: "public", name: "plain" }, rls: "off", policies: [] },
  ]);
  assert.deepEqual(rowsToRlsState(rows)[0].policies, [], "no policy rows at all is still a valid state");
});
