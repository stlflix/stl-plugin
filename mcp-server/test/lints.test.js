import assert from "node:assert/strict";
import { test } from "node:test";
import { HIDDEN_SCHEMAS, LINTS, LINT_SEVERITY_ORDER, runLints } from "../src/catalog.js";

const byId = new Map(LINTS.map((lint) => [lint.id, lint]));
const fixOf = (id, row) => byId.get(id).fix(row);

test("the catalogue is exactly these eight lints, with exactly these severities", () => {
  assert.deepEqual(
    LINTS.map((lint) => [lint.id, lint.severity]),
    [
      ["rls_disabled", "warn"],
      ["policy_always_true", "warn"],
      ["definer_without_search_path", "error"],
      ["definer_executable_by_public", "error"],
      ["extension_in_public", "info"],
      ["rls_without_policies", "info"],
      ["fk_without_index", "info"],
      ["table_without_pk", "info"],
    ],
  );
  assert.equal(new Set(LINTS.map((l) => l.id)).size, 8, "no id appears twice");
});

test("every lint explains itself, selects an object, and stays out of the platform's schemas", () => {
  for (const lint of LINTS) {
    assert.ok(lint.explain.length > 20, lint.id);
    assert.match(lint.sql, /AS object/, lint.id);
    assert.equal(typeof lint.fix, "function", lint.id);
    if (lint.id !== "extension_in_public") {
      assert.ok(lint.sql.includes(HIDDEN_SCHEMAS), `${lint.id} hides auth and buildloop`);
    }
  }
  // `"char"` columns are cast before they are compared, everywhere.
  for (const lint of LINTS) {
    for (const column of ["relkind", "prokind", "contype"]) {
      if (lint.sql.includes(column)) assert.ok(lint.sql.includes(`${column}::text`), `${lint.id}.${column}`);
    }
  }
});

test("rls_disabled offers the ALTER TABLE that turns row level security on", () => {
  assert.equal(
    fixOf("rls_disabled", { object: "public.notes", relation: "public.notes" }),
    "ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY",
  );
});

test("definer_without_search_path offers the ALTER FUNCTION that pins an empty search_path", () => {
  assert.equal(
    fixOf("definer_without_search_path", { object: "public.hello(text)", signature: "public.hello(text)" }),
    "ALTER FUNCTION public.hello(text) SET search_path = ''",
  );
});

test("definer_executable_by_public offers the REVOKE that takes EXECUTE back from PUBLIC", () => {
  assert.equal(
    fixOf("definer_executable_by_public", { object: "public.hello(text)", signature: "public.hello(text)" }),
    "REVOKE EXECUTE ON FUNCTION public.hello(text) FROM PUBLIC",
  );
});

test("extension_in_public offers the move out of public", () => {
  assert.equal(
    fixOf("extension_in_public", { object: "pgcrypto", extension: "pgcrypto" }),
    "ALTER EXTENSION pgcrypto SET SCHEMA extensions",
  );
});

test("fk_without_index offers the index that covers the foreign key's own columns", () => {
  assert.equal(
    fixOf("fk_without_index", { object: "public.notes (user_id)", relation: "public.notes", columns: "user_id" }),
    "CREATE INDEX ON public.notes (user_id)",
  );
  assert.equal(
    fixOf("fk_without_index", { relation: '"My Schema".notes', columns: '"user id", tenant' }),
    'CREATE INDEX ON "My Schema".notes ("user id", tenant)',
  );
});

test("the three findings only a human can resolve offer no SQL at all", () => {
  assert.equal(fixOf("policy_always_true", { object: "public.notes · all_rows", relation: "public.notes", policy: "all_rows" }), null);
  assert.equal(fixOf("rls_without_policies", { object: "public.notes", relation: "public.notes" }), null);
  assert.equal(fixOf("table_without_pk", { object: "public.logs", relation: "public.logs" }), null);
});

test("runLints executes every lint once and shapes each row into a finding", async () => {
  const seen = [];
  const client = {
    async query(sql) {
      seen.push(sql);
      if (sql === byId.get("rls_disabled").sql) {
        return { rows: [{ object: "public.notes", relation: "public.notes" }] };
      }
      return { rows: [] };
    },
  };
  const findings = await runLints(client);
  assert.equal(seen.length, 8, "all eight ran, even the ones with nothing to say");
  assert.deepEqual(findings, [
    {
      id: "rls_disabled",
      severity: "warn",
      object: "public.notes",
      explain: byId.get("rls_disabled").explain,
      fixSql: "ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY",
    },
  ]);
  assert.deepEqual(await runLints({ query: async () => ({ rows: [] }) }), [], "a clean database has no findings");
});

test("runLints answers worst first, so the error is never buried under the info", async () => {
  const client = {
    async query(sql) {
      if (sql === byId.get("table_without_pk").sql) return { rows: [{ object: "public.logs" }] };
      if (sql === byId.get("rls_disabled").sql) return { rows: [{ object: "public.notes", relation: "public.notes" }] };
      if (sql === byId.get("definer_executable_by_public").sql) {
        return { rows: [{ object: "public.hello(text)", signature: "public.hello(text)" }] };
      }
      return { rows: [] };
    },
  };
  const findings = await runLints(client);
  assert.deepEqual(findings.map((f) => f.severity), ["error", "warn", "info"]);
  assert.deepEqual(findings.map((f) => f.id), ["definer_executable_by_public", "rls_disabled", "table_without_pk"]);
  assert.deepEqual(LINT_SEVERITY_ORDER, ["error", "warn", "info"]);
});
