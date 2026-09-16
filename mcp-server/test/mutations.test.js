import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXEC_TIMEOUT_MS,
  ExecConflict,
  InvalidExecInput,
  MAX_SQL_BYTES,
  MAX_STATEMENTS,
  SqlRejected,
  parseStatements,
  runExec,
} from "../src/mutations.js";

const textOf = (q) => (typeof q === "string" ? q : q.text);

/** A pool whose single client answers from a script and records every statement. */
function fakePool(answer) {
  const statements = [];
  let released = 0;
  const client = {
    async query(q) {
      statements.push({ text: textOf(q), values: typeof q === "string" ? undefined : q.values });
      return answer(textOf(q));
    },
    release() {
      released += 1;
    },
  };
  return { pool: { connect: async () => client }, statements, released: () => released };
}

const ok = (command, rowCount) => ({ command, rowCount, rows: [] });

test("parseStatements accepts a batch and defaults params to an empty list", () => {
  assert.deepEqual(parseStatements([{ sql: "update t set a = $1", params: [1], expectRowCount: 1 }]), [
    { sql: "update t set a = $1", params: [1], expectRowCount: 1 },
  ]);
  assert.deepEqual(parseStatements([{ sql: "delete from t" }]), [{ sql: "delete from t", params: [] }]);
  assert.deepEqual(parseStatements([{ sql: "delete from t", expectRowCount: 0 }])[0].expectRowCount, 0);
});

test("parseStatements refuses anything it cannot execute, before a connection is asked for", () => {
  const bad = [
    [],
    {},
    null,
    [{ sql: "" }],
    [{ sql: "   " }],
    [{ sql: 42 }],
    ["select 1"],
    [[{ sql: "select 1" }]],
    [{ sql: "select 1", params: "x" }],
    [{ sql: "select 1", expectRowCount: -1 }],
    [{ sql: "select 1", expectRowCount: 1.5 }],
    [{ sql: "select 1", expectRowCount: "1" }],
    Array.from({ length: MAX_STATEMENTS + 1 }, () => ({ sql: "select 1" })),
    [{ sql: "x".repeat(MAX_SQL_BYTES + 1) }],
  ];
  for (const input of bad) {
    assert.throws(() => parseStatements(input), InvalidExecInput, JSON.stringify(input)?.slice(0, 40));
  }
  assert.equal(parseStatements(Array.from({ length: MAX_STATEMENTS }, () => ({ sql: "select 1" }))).length, MAX_STATEMENTS);
});

test("runExec wraps the batch in one time-boxed transaction, in this order", async () => {
  const { pool, statements, released } = fakePool(() => ok("UPDATE", 1));
  await runExec(pool, [{ sql: "update a set x = 1" }, { sql: "update b set y = 2" }]);
  assert.deepEqual(
    statements.map((s) => s.text),
    ["BEGIN", `SET LOCAL statement_timeout = ${EXEC_TIMEOUT_MS}`, "update a set x = 1", "update b set y = 2", "COMMIT"],
  );
  assert.equal(released(), 1);
  assert.equal(EXEC_TIMEOUT_MS, 10_000);
});

test("runExec sends each statement through the extended protocol with its own params", async () => {
  const { pool, statements } = fakePool(() => ok("INSERT", 1));
  const out = await runExec(pool, [{ sql: "insert into t values ($1)", params: ["a"] }, { sql: "insert into t values ($1)", params: ["b"] }]);
  assert.deepEqual(statements.filter((s) => s.text.startsWith("insert")).map((s) => s.values), [["a"], ["b"]]);
  assert.deepEqual(out, [{ command: "INSERT", rowCount: 1 }, { command: "INSERT", rowCount: 1 }]);
});

test("a statement that affects the expected number of rows commits", async () => {
  const { pool, statements } = fakePool(() => ok("UPDATE", 1));
  const out = await runExec(pool, [{ sql: "update t set a = 1 where id = 7", expectRowCount: 1 }]);
  assert.deepEqual(out, [{ command: "UPDATE", rowCount: 1 }]);
  assert.equal(statements.at(-1).text, "COMMIT");
});

test("an UPDATE that touches nothing rolls the whole batch back and runs no further statement", async () => {
  const { pool, statements, released } = fakePool((text) => (text.startsWith("update") ? ok("UPDATE", 0) : ok("INSERT", 1)));
  await assert.rejects(
    runExec(pool, [{ sql: "update t set a = 1", expectRowCount: 1 }, { sql: "insert into t values (2)" }]),
    (err) => {
      assert.ok(err instanceof ExecConflict);
      assert.equal(err.index, 0);
      assert.equal(err.expected, 1);
      assert.equal(err.got, 0);
      return true;
    },
  );
  assert.ok(!statements.some((s) => s.text.startsWith("insert")), "nothing after the conflict ran");
  assert.deepEqual(statements.at(-1).text, "ROLLBACK");
  assert.ok(!statements.some((s) => s.text === "COMMIT"));
  assert.equal(released(), 1);
});

test("the database's refusal rolls back and comes out as SqlRejected with its message and SQLSTATE", async () => {
  const refusal = Object.assign(new Error('relation "nope" does not exist'), { code: "42P01" });
  const { pool, statements, released } = fakePool((text) => {
    if (text.startsWith("select")) throw refusal;
    return ok("SELECT", 0);
  });
  await assert.rejects(runExec(pool, [{ sql: "select * from nope" }]), (err) => {
    assert.ok(err instanceof SqlRejected);
    assert.equal(err.message, 'relation "nope" does not exist');
    assert.equal(err.code, "42P01");
    assert.equal(err.cause, refusal);
    return true;
  });
  assert.equal(statements.at(-1).text, "ROLLBACK");
  assert.equal(released(), 1);
});

test("a failure that is not the database's — a dead socket — travels on untouched", async () => {
  const broken = new Error("socket hang up");
  const { pool, statements, released } = fakePool((text) => {
    if (text.startsWith("update")) throw broken;
    return ok("UPDATE", 1);
  });
  await assert.rejects(runExec(pool, [{ sql: "update t set a = 1" }]), (err) => err === broken);
  assert.equal(statements.at(-1).text, "ROLLBACK");
  assert.equal(released(), 1);
});
