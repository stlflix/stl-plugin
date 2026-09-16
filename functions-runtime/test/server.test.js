import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, test } from "node:test";
import { SignJWT, createLocalJWKSet, exportJWK, jwtVerify } from "jose";
import { gateway } from "../src/gateway.js";
import { createServer } from "../src/server.js";
import { ChildDied, Timeout, UnknownFunction } from "../src/supervisor.js";

/**
 * The whole surface on an ephemeral port, with a fake supervisor: the real
 * gateway decides who is calling, and the test judges what the outside world
 * sees — the status, and the invocation line that was written for it.
 */
const RUNTIME_KEY = "r".repeat(32);
const platform = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = { ...(await exportJWK(platform.publicKey)), alg: "ES256", use: "sig" };

const invocations = [];
const reloads = [];
let answer = null;

const supervisor = {
  invoke: async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  },
  reload: (slug, name) => reloads.push([slug, name]),
};

const bridge = { writeInvocation: async (slug, row) => invocations.push({ slug, ...row }) };

let server;
let base;

before(async () => {
  server = createServer({
    config: { port: 0 },
    admit: gateway({ rateLimitPerMin: 120 }, createLocalJWKSet({ keys: [jwk] })),
    supervisor,
    bridge,
    jwk,
    runtimeKey: RUNTIME_KEY,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function ok(status = 200, { body = "hi", headers = { "content-type": "text/plain" }, log = [], error = null } = {}) {
  return { status, headers, body: Buffer.from(body).toString("base64"), log, error };
}

async function call(path, init = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

test("healthz answers without touching anything else", async () => {
  const res = await call("/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { ok: true });
});

test("the JWKS is the platform's public key, cacheable, and verifies a real token", async () => {
  const res = await call("/auth/jwks");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  const { keys } = JSON.parse(res.text);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kty, "EC");
  assert.equal(keys[0].crv, "P-256");
  assert.ok(!("d" in keys[0]), "the private half never leaves the platform");

  const token = await new SignJWT({ sub: "9" })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("productops")
    .setAudience("buildloop:alice")
    .setExpirationTime("8h")
    .sign(platform.privateKey);
  const { payload } = await jwtVerify(token, createLocalJWKSet({ keys }), {
    issuer: "productops",
    audience: "buildloop:alice",
  });
  assert.equal(payload.sub, "9");
});

test("a successful invocation answers the handler's response and writes one invocation line", async () => {
  invocations.length = 0;
  answer = ok(201, { body: "made", headers: { "x-thing": "made" } });
  const res = await call("/fn/alice/hello");
  assert.equal(res.status, 201);
  assert.equal(res.text, "made");
  assert.equal(res.headers.get("x-thing"), "made");
  assert.equal(res.headers.get("cache-control"), "private, no-store", "nothing of a function's is cacheable");
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].slug, "alice");
  assert.equal(invocations[0].name, "hello");
  assert.equal(invocations[0].status, 201);
  assert.ok(invocations[0].durationMs >= 0);
});

test("a handler over its time is 504, and the line says so", async () => {
  invocations.length = 0;
  answer = new Timeout(10_000);
  const res = await call("/fn/alice/hello");
  assert.equal(res.status, 504);
  assert.deepEqual(invocations.map((i) => i.status), [504]);
  assert.match(invocations[0].error, /did not answer in 10000 ms/);
});

test("a child that died is 503, and a function that was never published is 404 with no line", async () => {
  invocations.length = 0;
  answer = new ChildDied("SIGKILL");
  assert.equal((await call("/fn/alice/hello")).status, 503);
  assert.deepEqual(invocations.map((i) => i.status), [503]);

  invocations.length = 0;
  answer = new UnknownFunction("alice", "ghost");
  assert.equal((await call("/fn/alice/ghost")).status, 404);
  assert.deepEqual(invocations, [], "nothing ran, so nothing is logged");
});

test("a handler that threw is a 500 whose line carries the error and what it logged", async () => {
  invocations.length = 0;
  answer = ok(500, { body: JSON.stringify({ error: "nope" }), log: ["log: before"], error: "nope" });
  const res = await call("/fn/alice/hello");
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.text), { error: "nope" });
  assert.equal(invocations[0].error, "nope");
  assert.deepEqual(invocations[0].log, ["log: before"]);
});

test("the gateway's refusals come out of the server untouched, and log nothing", async () => {
  invocations.length = 0;
  answer = ok();
  assert.equal((await call("/fn/Alice/hello")).status, 400);
  assert.equal((await call("/fn/alice/hello", { headers: { authorization: "Bearer nope" } })).status, 401);
  assert.deepEqual(invocations, [], "a call that never reached a handler is not an invocation");
});

test("_reload is the MCP's door and needs the runtime key", async () => {
  reloads.length = 0;
  assert.equal((await call("/_reload/alice/hello", { method: "POST" })).status, 401);
  assert.equal((await call("/_reload/alice/hello", { method: "POST", headers: { "x-runtime-key": "nope" } })).status, 401);
  assert.deepEqual(reloads, []);

  const res = await call("/_reload/alice/hello", { method: "POST", headers: { "x-runtime-key": RUNTIME_KEY } });
  assert.equal(res.status, 200);
  assert.deepEqual(reloads, [["alice", "hello"]]);
});

test("a page on another origin gets CORS: the preflight is 204 without a bearer, and every /fn answer allows *", async () => {
  invocations.length = 0;
  answer = ok(201);
  const pre = await call("/fn/alice/hello", {
    method: "OPTIONS",
    headers: { origin: "https://app.example.com", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.equal(pre.headers.get("access-control-allow-headers"), "authorization, content-type");
  assert.match(pre.headers.get("access-control-allow-methods"), /POST/);
  assert.deepEqual(invocations, [], "a preflight is not an invocation");

  const answered = await call("/fn/alice/hello", { method: "POST", headers: { origin: "https://app.example.com" }, body: "{}" });
  assert.equal(answered.status, 201);
  assert.equal(answered.headers.get("access-control-allow-origin"), "*");

  const refused = await call("/fn/alice/hello", { headers: { authorization: "Bearer nope" } });
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get("access-control-allow-origin"), "*", "a refusal the page can read beats a network error it cannot");

  const jwks = await call("/auth/jwks");
  assert.equal(jwks.headers.get("access-control-allow-origin"), null, "only /fn is a cross-origin surface");
});

test("anything else is 404", async () => {
  assert.equal((await call("/")).status, 404);
  assert.equal((await call("/admin/collaborators/alice")).status, 404);
});
