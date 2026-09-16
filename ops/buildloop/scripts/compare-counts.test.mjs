import assert from "node:assert/strict";
import { test } from "node:test";
import { compareDatabase, firstDivergence, render, run } from "./compare-counts.mjs";

/**
 * Fake clients, because what is being tested is the verdict: the migration
 * script trusts this exit code to decide whether a cluster is thrown away.
 */
function client(tables) {
  return {
    ended: false,
    async query(sql) {
      if (sql.includes("FROM pg_tables")) {
        return { rows: Object.keys(tables).map((ref) => ({ schema: ref.split(".")[0], name: ref.split(".")[1] })) };
      }
      const match = /FROM "([^"]+)"\."([^"]+)"/.exec(sql);
      return { rows: [{ n: tables[`${match[1]}.${match[2]}`] }] };
    },
    async end() {
      this.ended = true;
    },
  };
}

function connector(sides) {
  return async (side, database) => client(sides[database][side]);
}

test("two clusters that match exit 0, and every table is in the report", async () => {
  const lines = [];
  const code = await run({
    databases: ["db_alice"],
    connect: connector({ db_alice: { source: { "public.notes": 3, "auth.users": 1 }, target: { "public.notes": 3, "auth.users": 1 } } }),
    out: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  const report = lines.join("\n");
  assert.match(report, /public\.notes\s+3\s+3/);
  assert.match(report, /auth\.users\s+1\s+1/);
  assert.match(report, /OK: 2 table\(s\) in 1 database\(s\) match/);
});

test("a row that did not arrive exits 1, naming the table, what was expected and what came", async () => {
  const lines = [];
  const code = await run({
    databases: ["db_alice"],
    connect: connector({ db_alice: { source: { "public.notes": 12 }, target: { "public.notes": 11 } } }),
    out: (line) => lines.push(line),
  });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /ABORT: db_alice public\.notes expected 12, got 11/);
});

test("a table that did not arrive at all is a divergence, not a table nobody mentions", async () => {
  const lines = [];
  const code = await run({
    databases: ["db_bob"],
    connect: connector({ db_bob: { source: { "public.notes": 1, "public.gone": 4 }, target: { "public.notes": 1 } } }),
    out: (line) => lines.push(line),
  });
  assert.equal(code, 1);
  const report = lines.join("\n");
  assert.match(report, /public\.gone\s+4\s+missing/);
  assert.match(report, /ABORT: db_bob public\.gone expected 4, got missing/);
});

test("every database is counted before the verdict, and the connections are closed", async () => {
  const opened = [];
  const lines = [];
  const code = await run({
    databases: ["db_alice", "db_bob"],
    connect: async (side, database) => {
      const c = client(database === "db_alice" ? { "public.a": 1 } : { "public.b": 2 });
      opened.push({ side, database, client: c });
      return c;
    },
    out: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(
    opened.map((o) => `${o.database}:${o.side}`),
    ["db_alice:source", "db_alice:target", "db_bob:source", "db_bob:target"],
  );
  assert.ok(opened.every((o) => o.client.ended), "no connection is left open behind the report");
  assert.match(lines.join("\n"), /db_bob\s+public\.b/);
});

test("the report is a table even when a side is empty, and firstDivergence keeps the order", () => {
  assert.equal(firstDivergence([{ expected: 1, got: 1 }]), null);
  const rows = [
    { database: "db_alice", table: "public.a", expected: 1, got: 1 },
    { database: "db_alice", table: "public.b", expected: 2, got: 9 },
    { database: "db_alice", table: "public.c", expected: 3, got: 8 },
  ];
  assert.equal(firstDivergence(rows).table, "public.b", "the first one, so the operator fixes that one");
  assert.match(render(rows), /^database\s+table\s+expected\s+got$/m);
});

test("compareDatabase reports what only the new cluster has, rather than staying quiet", async () => {
  const rows = await compareDatabase("db_alice", client({ "public.a": 1 }), client({ "public.a": 1, "public.extra": 5 }));
  assert.deepEqual(rows.at(-1), { database: "db_alice", table: "public.extra", expected: null, got: 5 });
  assert.equal(firstDivergence(rows).table, "public.extra");
});
