#!/usr/bin/env node
/**
 * The gate of the migration (BL-08): the same `count(*)` on every table of
 * every database, on both clusters, and the cutover only happens if every
 * number matches. It runs on the HOST with plain `node` — `pg` is imported
 * lazily so the module can be loaded (and tested) without it.
 *
 *   node compare-counts.mjs <old-url> <new-url> [db_alice db_bob …]
 *
 * Exit 0: identical. Exit 1: the first divergence, named.
 */
export const TABLES_SQL = `SELECT schemaname AS schema, tablename AS name
  FROM pg_tables
  WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY schemaname, tablename`;

function quote(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export async function countsFor(client) {
  const { rows } = await client.query(TABLES_SQL);
  const counts = new Map();
  for (const row of rows) {
    const result = await client.query(`SELECT count(*)::int AS n FROM ${quote(row.schema)}.${quote(row.name)}`);
    counts.set(`${row.schema}.${row.name}`, result.rows[0].n);
  }
  return counts;
}

/**
 * A table on the old side and not on the new one is the failure this exists to
 * catch, so it is reported as `got: null` rather than skipped. One that only
 * exists on the new side is reported too — it is not a loss, but it is not
 * something a restore should have invented either.
 */
export async function compareDatabase(database, source, target) {
  const expected = await countsFor(source);
  const got = await countsFor(target);
  const rows = [];
  for (const [table, n] of expected) {
    rows.push({ database, table, expected: n, got: got.has(table) ? got.get(table) : null });
  }
  for (const [table, n] of got) {
    if (!expected.has(table)) rows.push({ database, table, expected: null, got: n });
  }
  return rows;
}

export function firstDivergence(rows) {
  return rows.find((row) => row.expected !== row.got) ?? null;
}

export function render(rows) {
  const header = ["database", "table", "expected", "got"];
  const body = rows.map((row) => [row.database, row.table, show(row.expected), show(row.got)]);
  const widths = header.map((_, i) => Math.max(header[i].length, ...body.map((line) => line[i].length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

function show(value) {
  return value === null ? "missing" : String(value);
}

/** Every database is counted before anything is decided: the report is whole. */
export async function run({ databases, connect, out = console.log }) {
  const rows = [];
  for (const database of databases) {
    const source = await connect("source", database);
    const target = await connect("target", database);
    try {
      rows.push(...(await compareDatabase(database, source, target)));
    } finally {
      await source.end?.();
      await target.end?.();
    }
  }
  out(render(rows));

  const divergence = firstDivergence(rows);
  if (!divergence) {
    out(`\nOK: ${rows.length} table(s) in ${databases.length} database(s) match — the cutover may proceed`);
    return 0;
  }
  out(
    `\nABORT: ${divergence.database} ${divergence.table} expected ${show(divergence.expected)}, got ${show(divergence.got)}`,
  );
  return 1;
}

function databaseOf(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, "")) || "postgres";
}

function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function main(argv) {
  const [oldUrl, newUrl, ...databases] = argv;
  if (!oldUrl || !newUrl) {
    console.error("usage: compare-counts.mjs <old-url> <new-url> [database…]");
    return 2;
  }
  const { default: pg } = await import("pg");
  const names = databases.length > 0 ? databases : [databaseOf(oldUrl)];
  return run({
    databases: names,
    connect: async (side, database) => {
      const client = new pg.Client({ connectionString: withDatabase(side === "source" ? oldUrl : newUrl, database) });
      await client.connect();
      return client;
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main(process.argv.slice(2)));
