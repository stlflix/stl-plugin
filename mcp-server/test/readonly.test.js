import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LIMIT,
  InvalidQueryInput,
  MAX_LIMIT,
  READ_ONLY_TIMEOUT_MS,
  isPostgresError,
  parseQueryInput,
  runReadOnly,
  shapeResult,
} from "../src/readonly.js";

const textOf = (q) => (typeof q === "string" ? q : q.text);

/** A pool whose single client answers from a script and records every statement. */
function fakePool(answer) {
  const statements = [];
  let released = 0;
  const client = {
    async query(q, params) {
      statements.push({ text: textOf(q), params, rowMode: typeof q === "string" ? undefined : q.rowMode });
      return answer(textOf(q), params);
    },
    release() {
      released += 1;
    },
  };
  return { pool: { connect: async () => client }, statements, released: () => released };
}

const selectResult = {
  command: "SELECT",
  fields: [{ name: "id", dataTypeID: 23 }, { name: "name", dataTypeID: 25 }],
  rows: [[1, "a"], [2, "b"], [3, "c"]],
};

test("parseQueryInput: sql is required, limit defaults and is bounded", () => {
  assert.deepEqual(parseQueryInput({ sql: "select 1" }), { sql: "select 1", limit: DEFAULT_LIMIT });
  assert.deepEqual(parseQueryInput({ sql: "select 1", limit: 7 }), { sql: "select 1", limit: 7 });
  assert.deepEqual(parseQueryInput({ sql: "select 1", limit: null }), { sql: "select 1", limit: DEFAULT_LIMIT });
  for (const bad of [{}, { sql: "" }, { sql: "   " }, { sql: 42 }, null, undefined]) {
    assert.throws(() => parseQueryInput(bad), InvalidQueryInput, JSON.stringify(bad));
  }
  for (const limit of [0, -1, 1.5, "10", MAX_LIMIT + 1]) {
    assert.throws(() => parseQueryInput({ sql: "select 1", limit }), /between 1 and 500/, String(limit));
  }
});

test("isPostgresError recognises a SQLSTATE and nothing else", () => {
  assert.equal(isPostgresError(Object.assign(new Error("read-only"), { code: "25006" })), true);
  assert.equal(isPostgresError(Object.assign(new Error("enoent"), { code: "ENOENT" })), false);
  assert.equal(isPostgresError(new Error("plain")), false);
  assert.equal(isPostgresError("25006"), false);
});

test("runReadOnly wraps the SQL in a read-only, time-boxed transaction, in this order", async () => {
  const { pool, statements, released } = fakePool((text) => {
    if (text.startsWith("SELECT oid, format_type")) {
      return { rows: [{ oid: 23, name: "integer" }, { oid: 25, name: "text" }] };
    }
    if (text === "select * from t") return selectResult;
    return { rows: [] };
  });

  const out = await runReadOnly(pool, "select * from t", 100);

  assert.deepEqual(
    statements.map((s) => s.text),
    [
      "BEGIN READ ONLY",
      `SET LOCAL statement_timeout = ${READ_ONLY_TIMEOUT_MS}`,
      "select * from t",
      "SELECT oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1::oid[])",
      "COMMIT",
    ],
  );
  assert.equal(statements[2].rowMode, "array", "rows must come back positionally");
  assert.deepEqual(statements[3].params, [[23, 25]]);
  assert.deepEqual(out.columns, [{ name: "id", type: "integer" }, { name: "name", type: "text" }]);
  assert.deepEqual(out.rows, selectResult.rows);
  assert.equal(out.rowCount, 3);
  assert.equal(out.truncated, false);
  assert.equal(released(), 1);
  assert.ok(READ_ONLY_TIMEOUT_MS <= 5000);
});

test("runReadOnly rolls back, releases, and rethrows the database's error untouched", async () => {
  const refusal = Object.assign(new Error("cannot execute INSERT in a read-only transaction"), { code: "25006" });
  const { pool, statements, released } = fakePool((text) => {
    if (text.startsWith("insert")) throw refusal;
    return { rows: [] };
  });

  await assert.rejects(runReadOnly(pool, "insert into t values (1)", 100), (err) => err === refusal);
  assert.deepEqual(statements.map((s) => s.text).slice(-2), ["insert into t values (1)", "ROLLBACK"]);
  assert.ok(!statements.some((s) => s.text === "COMMIT"));
  assert.equal(released(), 1);
});

test("runReadOnly skips the type lookup when the statement returns no columns", async () => {
  const { pool, statements } = fakePool(() => ({ command: "SHOW", fields: [], rows: [] }));
  const out = await runReadOnly(pool, "show search_path", 100);
  assert.ok(!statements.some((s) => s.text.startsWith("SELECT oid")));
  assert.deepEqual(out, { command: "SHOW", columns: [], rows: [], rowCount: 0, truncated: false });
});

test("shapeResult cuts at the limit and says so, keeping the real row count", () => {
  const out = shapeResult(selectResult, new Map([[23, "integer"], [25, "text"]]), 2);
  assert.deepEqual(out.rows, [[1, "a"], [2, "b"]]);
  assert.equal(out.rowCount, 3);
  assert.equal(out.truncated, true);
});

test("shapeResult keeps two columns with the same name and falls back to the OID as type", () => {
  const result = { command: "SELECT", fields: [{ name: "?column?", dataTypeID: 23 }, { name: "?column?", dataTypeID: 99999 }], rows: [[1, 1]] };
  const out = shapeResult(result, new Map([[23, "integer"]]), 10);
  assert.deepEqual(out.columns, [{ name: "?column?", type: "integer" }, { name: "?column?", type: "99999" }]);
  assert.deepEqual(out.rows, [[1, 1]]);
});

test("shapeResult shows the last statement of a batch, as psql does", () => {
  const batch = [{ command: "SET", fields: [], rows: [] }, selectResult];
  const out = shapeResult(batch, new Map(), 10);
  assert.equal(out.command, "SELECT");
  assert.equal(out.rowCount, 3);
});
