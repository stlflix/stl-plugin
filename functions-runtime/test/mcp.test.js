import assert from "node:assert/strict";
import { test } from "node:test";
import { McpClient, McpUnavailable, RuntimeKeyRejected } from "../src/mcp.js";

const KEY = "r".repeat(32);

function client(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, mcp: new McpClient({ baseUrl: "http://mcp:8200/", runtimeKey: KEY, fetchImpl }) };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("both calls are POSTs under the runtime key, and only under it", async () => {
  const { calls, mcp } = client(() => json(200, { database: "db_alice", user: "alice_fn", password: "p" }));
  await mcp.credential("alice");
  await mcp.function("alice", "hello");
  assert.deepEqual(
    calls.map((c) => c.url),
    ["http://mcp:8200/admin/runtime/credential/alice", "http://mcp:8200/admin/runtime/function/alice/hello"],
  );
  for (const { init } of calls) {
    assert.equal(init.method, "POST");
    assert.equal(init.headers["X-Runtime-Key"], KEY);
    assert.ok(!("Authorization" in init.headers), "the runtime has no bearer of its own");
  }
});

test("404 is an answer — no credential, no published version — and not a failure", async () => {
  const { mcp } = client(() => json(404, { error: "not provisioned" }));
  assert.equal(await mcp.credential("bob"), null);
  assert.equal(await mcp.function("bob", "hello"), null);
});

test("a refused key and an unreachable server are told apart", async () => {
  const refused = client(() => json(401, { error: "invalid runtime key" }));
  await assert.rejects(() => refused.mcp.credential("alice"), RuntimeKeyRejected);
  const broken = client(() => new Response("bad gateway", { status: 502 }));
  await assert.rejects(() => broken.mcp.function("alice", "hello"), McpUnavailable);
});
