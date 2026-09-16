import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidOrigin, OriginTaken, add, listFor, normalizeOrigin, remove, slugFor } from "../src/origins.js";
import { CollaboratorStore } from "../src/store.js";

/**
 * The registry against a fake pool that records what it was asked. A refused
 * origin must leave that record empty: the refusal happens before the database
 * is reached, exactly as the tools do with a bad name (BL-26).
 */
function harness(answer = () => ({ rows: [], rowCount: 0 })) {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return answer(sql, params) ?? { rows: [], rowCount: 0 };
    },
  };
  return { pool, calls };
}

/** One in-memory table, so ownership and idempotence are proved end to end. */
function registry(rows = []) {
  const pool = {
    async query(sql, params) {
      if (sql.includes("INSERT INTO stl_mcp.allowed_origins")) {
        const [origin, slug] = params;
        if (rows.some((r) => r.origin === origin)) return { rows: [], rowCount: 0 };
        rows.push({ origin, slug, created_at: "2026-09-16T00:00:00.000Z" });
        return { rows: [{ origin }], rowCount: 1 };
      }
      if (sql.startsWith("DELETE FROM stl_mcp.allowed_origins")) {
        const [origin, slug] = params;
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (rows[i].origin === origin && rows[i].slug === slug) rows.splice(i, 1);
        }
        return { rows: [], rowCount: before - rows.length };
      }
      if (sql.includes("WHERE slug = $1")) {
        return { rows: rows.filter((r) => r.slug === params[0]).sort((a, b) => a.origin.localeCompare(b.origin)) };
      }
      if (sql.includes("WHERE origin = $1")) {
        return { rows: rows.filter((r) => r.origin === params[0]) };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 40)}`);
    },
  };
  return { pool, rows };
}

test("an origin is https://host, or http://localhost with a port, and never carries a path", () => {
  for (const good of ["https://app.x.com", "https://app.x.com:8443", "http://localhost:5173"]) {
    assert.equal(normalizeOrigin(good), good, good);
  }
  assert.equal(normalizeOrigin("https://app.x.com/"), "https://app.x.com", "a bare slash is still just the origin");
  for (const bad of [
    "http://example.com",
    "https://a.com/path",
    "ftp://files.x.com",
    "http://localhost",
    "https://a.com?q=1",
    "https://user:pw@a.com",
    "app.x.com",
    "",
    null,
  ]) {
    assert.equal(normalizeOrigin(bad), null, JSON.stringify(bad));
  }
});

test("add refuses an origin outside the contract without touching the database", async () => {
  const { pool, calls } = harness();
  for (const bad of ["http://example.com", "https://a.com/path", "ftp://files.x.com", "http://localhost", ""]) {
    await assert.rejects(add(pool, "alice", bad), InvalidOrigin, JSON.stringify(bad));
  }
  assert.deepEqual(calls, []);
});

test("add refuses a slug outside the pattern without touching the database", async () => {
  const { pool, calls } = harness();
  for (const slug of ["Alice", "a", "alice;drop", 7, undefined]) {
    await assert.rejects(add(pool, slug, "https://app.x.com"), InvalidOrigin, String(slug));
  }
  assert.deepEqual(calls, []);
});

test("add registers the origin for the slug that asked, normalized", async () => {
  const { pool, rows } = registry();
  assert.deepEqual(await add(pool, "alice", "https://app.x.com/"), {
    origin: "https://app.x.com",
    slug: "alice",
    created: true,
  });
  assert.deepEqual(rows.map((r) => [r.origin, r.slug]), [["https://app.x.com", "alice"]]);
});

test("a second add of the same origin by the same slug changes nothing", async () => {
  const { pool, rows } = registry();
  await add(pool, "alice", "https://app.x.com");
  const again = await add(pool, "alice", "https://app.x.com");
  assert.deepEqual(again, { origin: "https://app.x.com", slug: "alice", created: false });
  assert.equal(rows.length, 1);
});

test("an origin another collaborator already registered is refused with OriginTaken", async () => {
  const { pool, rows } = registry();
  await add(pool, "alice", "https://app.x.com");
  await assert.rejects(add(pool, "bob", "https://app.x.com"), (err) => {
    assert.ok(err instanceof OriginTaken);
    assert.equal(err.origin, "https://app.x.com");
    assert.equal(err.slug, "alice");
    assert.match(err.message, /already registered by another collaborator/);
    return true;
  });
  assert.deepEqual(rows.map((r) => r.slug), ["alice"], "the owner keeps it");
});

test("remove takes away only the caller's own origin", async () => {
  const { pool, rows } = registry();
  await add(pool, "alice", "https://app.x.com");
  assert.deepEqual(await remove(pool, "bob", "https://app.x.com"), { origin: "https://app.x.com", removed: false });
  assert.equal(rows.length, 1);
  assert.deepEqual(await remove(pool, "alice", "https://app.x.com"), { origin: "https://app.x.com", removed: true });
  assert.equal(rows.length, 0);
});

test("listFor answers the slug's own origins, in order", async () => {
  const { pool } = registry();
  await add(pool, "alice", "https://z.x.com");
  await add(pool, "alice", "http://localhost:5173");
  await add(pool, "bob", "https://bob.x.com");
  assert.deepEqual((await listFor(pool, "alice")).map((o) => o.origin), ["http://localhost:5173", "https://z.x.com"]);
  assert.deepEqual((await listFor(pool, "bob")).map((o) => o.origin), ["https://bob.x.com"]);
});

test("slugFor resolves a registered origin and answers null for an unknown or malformed one", async () => {
  const { pool } = registry();
  await add(pool, "alice", "https://app.x.com");
  assert.equal(await slugFor(pool, "https://app.x.com"), "alice");
  assert.equal(await slugFor(pool, "https://app.x.com/"), "alice");
  assert.equal(await slugFor(pool, "https://other.x.com"), null);
  assert.equal(await slugFor(pool, "not an origin"), null);
});

test("ensureSchema creates the origin registry and the spent tickets alongside the collaborators", async () => {
  const statements = [];
  const pool = { query: async (sql) => (statements.push(sql), { rows: [{ n: 0 }] }) };
  await new CollaboratorStore(pool, Buffer.alloc(32)).ensureSchema();
  const all = statements.join("\n");
  assert.match(all, /CREATE TABLE IF NOT EXISTS stl_mcp\.allowed_origins/);
  assert.match(all, /origin\s+text PRIMARY KEY/);
  assert.match(all, /REFERENCES stl_mcp\.collaborators \(slug\)/);
  assert.match(all, /CREATE TABLE IF NOT EXISTS stl_mcp\.used_tickets/);
  assert.match(all, /jti\s+text PRIMARY KEY/);
  assert.equal(statements.at(-1), "REVOKE ALL ON SCHEMA stl_mcp FROM PUBLIC", "the schema is closed last");
});
