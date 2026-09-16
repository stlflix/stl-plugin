import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import { SignJWT, createLocalJWKSet, exportJWK } from "jose";
import { BodyTooLarge, MAX_BODY_BYTES, gateway, readLimitedBody } from "../src/gateway.js";

/**
 * Every status of BL-23 that is decided before the collaborator's code runs.
 * The keys are generated here: the platform holds the private one, and this
 * process only ever sees the public half (I6).
 */
const platform = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const impostor = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const jwk = await exportJWK(platform.publicKey);
const jwks = createLocalJWKSet({ keys: [{ ...jwk, alg: "ES256" }] });

const CONFIG = { rateLimitPerMin: 3 };
const CLAIMS = { sub: "9", email: "nine@x.com", name: "Nine", is_super: false };

async function token({ key = platform.privateKey, audience = "buildloop:alice", issuer = "productops", expiresIn = "8h" } = {}) {
  return new SignJWT(CLAIMS)
    .setProtectedHeader({ alg: "ES256" })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(expiresIn)
    .sign(key);
}

function admitter(config = CONFIG, options) {
  return gateway({ rateLimitPerMin: 120, ...config }, jwks, options);
}

test("a slug or a name outside its pattern is 400, before anything else is decided", async () => {
  const admit = admitter();
  for (const [slug, name] of [["Alice", "hello"], ["alice", "Hello"], ["alice", "a"], ["", "hello"]]) {
    const verdict = await admit({ slug, name, headers: {} });
    assert.equal(verdict.ok, false, `${slug}/${name}`);
    assert.equal(verdict.status, 400);
  }
});

test("no bearer is not an error: the call runs as the anonymous role", async () => {
  const verdict = await admitter()({ slug: "alice", name: "hello", headers: {} });
  assert.deepEqual(verdict.user, { role: "anon", claims: {} });
  assert.equal(verdict.ok, true);
});

test("a valid bearer of this slug runs as the authenticated role, carrying its claims", async () => {
  const verdict = await admitter()({ slug: "alice", name: "hello", headers: { authorization: `Bearer ${await token()}` } });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.user.role, "authenticated");
  assert.equal(verdict.user.claims.sub, "9");
  assert.equal(verdict.user.claims.aud, "buildloop:alice");
});

test("a token that is not this slug's, not the platform's, or not current is 401", async () => {
  const admit = admitter({ rateLimitPerMin: 120 });
  const cases = {
    "another collaborator's audience": await token({ audience: "buildloop:bob" }),
    "a key that is not the platform's": await token({ key: impostor.privateKey }),
    "another issuer": await token({ issuer: "someone-else" }),
    expired: await token({ expiresIn: "-1s" }),
    "not a token at all": "abc.def.ghi",
  };
  for (const [why, value] of Object.entries(cases)) {
    const verdict = await admit({ slug: "alice", name: "hello", headers: { authorization: `Bearer ${value}` } });
    assert.equal(verdict.ok, false, why);
    assert.equal(verdict.status, 401, why);
    assert.equal(verdict.error, "invalid token", "why it failed is not described to whoever sent it");
  }
});

test("past the rate limit the slug gets 429 with Retry-After, and its neighbour is untouched", async () => {
  let clock = 0;
  const admit = admitter({ rateLimitPerMin: 3 }, { now: () => clock });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await admit({ slug: "alice", name: "hello", headers: {} })).ok, true, `call ${i}`);
  }
  const refused = await admit({ slug: "alice", name: "hello", headers: {} });
  assert.equal(refused.status, 429);
  assert.equal(refused.headers["retry-after"], "20", "three a minute: one token back in twenty seconds");

  assert.equal((await admit({ slug: "bob", name: "hello", headers: {} })).ok, true, "the bucket is per collaborator");

  clock += 20_000;
  assert.equal((await admit({ slug: "alice", name: "hello", headers: {} })).ok, true, "the bucket refills with time");
});

test("a body larger than 1 MB is 413 on the declared length alone", async () => {
  const admit = admitter();
  const verdict = await admit({ slug: "alice", name: "hello", headers: { "content-length": String(MAX_BODY_BYTES + 1) } });
  assert.equal(verdict.status, 413);
  assert.equal((await admit({ slug: "alice", name: "hello", headers: { "content-length": String(MAX_BODY_BYTES) } })).ok, true);
});

test("a stream that lies about its length is cut the moment it passes the cap", async () => {
  const chunk = Buffer.alloc(64 * 1024, 7);
  const oversized = Readable.from(Array.from({ length: 20 }, () => chunk));
  await assert.rejects(() => readLimitedBody(oversized, 512 * 1024), BodyTooLarge);
  const fine = await readLimitedBody(Readable.from([Buffer.from("hello")]), 512 * 1024);
  assert.equal(fine.toString("utf8"), "hello");
});

test("every verdict carries Cache-Control private, no-store", async () => {
  const admit = admitter({ rateLimitPerMin: 1 });
  const verdicts = [
    await admit({ slug: "Alice", name: "hello", headers: {} }),
    await admit({ slug: "alice", name: "hello", headers: {} }),
    await admit({ slug: "alice", name: "hello", headers: {} }),
    await admit({ slug: "bob", name: "hello", headers: { authorization: "Bearer nope" } }),
  ];
  assert.deepEqual(verdicts.map((v) => v.status ?? 200), [400, 200, 429, 401]);
  for (const verdict of verdicts) assert.equal(verdict.headers["cache-control"], "private, no-store");
});
