import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidTicket, TicketReused, consume } from "../src/tickets.js";

/** One in-memory table: the second `consume` of a jti has to find it there. */
function registry() {
  const spent = new Set();
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("INSERT INTO stl_mcp.used_tickets")) {
        const [jti] = params;
        if (spent.has(jti)) return { rows: [], rowCount: 0 };
        spent.add(jti);
        return { rows: [{ jti }], rowCount: 1 };
      }
      if (sql.startsWith("DELETE FROM stl_mcp.used_tickets")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected query: ${sql.slice(0, 40)}`);
    },
  };
  return { pool, calls, spent };
}

const IN_A_MINUTE = new Date(Date.now() + 60_000);

test("a ticket is spent once and refused the second time", async () => {
  const { pool } = registry();
  const first = await consume(pool, "jti-1", IN_A_MINUTE);
  assert.equal(first.jti, "jti-1");
  assert.ok(!Number.isNaN(Date.parse(first.consumedAt)));
  await assert.rejects(consume(pool, "jti-1", IN_A_MINUTE), (err) => {
    assert.ok(err instanceof TicketReused);
    assert.equal(err.jti, "jti-1");
    return true;
  });
});

test("two different tickets do not collide", async () => {
  const { pool, spent } = registry();
  await consume(pool, "jti-1", IN_A_MINUTE);
  await consume(pool, "jti-2", IN_A_MINUTE);
  assert.deepEqual([...spent], ["jti-1", "jti-2"]);
});

test("the insert claims the jti and the very next statement sweeps what expired", async () => {
  const { pool, calls } = registry();
  await consume(pool, "jti-1", IN_A_MINUTE);
  assert.match(calls[0].sql, /ON CONFLICT \(jti\) DO NOTHING RETURNING jti/);
  assert.equal(calls[1].sql, "DELETE FROM stl_mcp.used_tickets WHERE expires_at < now()");
  assert.equal(calls.length, 2);
});

test("a reused ticket is still swept before it is refused", async () => {
  const { pool, calls } = registry();
  await consume(pool, "jti-1", IN_A_MINUTE);
  await assert.rejects(consume(pool, "jti-1", IN_A_MINUTE), TicketReused);
  assert.equal(calls.at(-1).sql, "DELETE FROM stl_mcp.used_tickets WHERE expires_at < now()");
});

test("the expiry is stored as an ISO instant, whether it came as a Date or as text", async () => {
  const { pool, calls } = registry();
  await consume(pool, "jti-1", IN_A_MINUTE);
  assert.equal(calls[0].params[1], IN_A_MINUTE.toISOString());
  await consume(pool, "jti-2", "2026-09-16T12:00:00.000Z");
  assert.equal(calls[2].params[1], "2026-09-16T12:00:00.000Z");
});

test("a malformed jti or expiry is refused without touching the database", async () => {
  const { pool, calls } = registry();
  for (const [jti, exp] of [["", IN_A_MINUTE], ["   ", IN_A_MINUTE], [42, IN_A_MINUTE], ["x".repeat(201), IN_A_MINUTE], ["jti-1", "soon"], ["jti-1", undefined]]) {
    await assert.rejects(consume(pool, jti, exp), InvalidTicket, JSON.stringify([jti, String(exp)]));
  }
  assert.deepEqual(calls, []);
});
