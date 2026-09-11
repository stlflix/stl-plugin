import assert from "node:assert/strict";
import { test } from "node:test";
import { bearerFrom, hashToken, isValidSlug, secretEquals } from "../src/auth.js";

test("bearerFrom accepts only a well-formed Bearer header", () => {
  assert.equal(bearerFrom("Bearer abc123"), "abc123");
  assert.equal(bearerFrom("bearer abc123"), "abc123");
  assert.equal(bearerFrom("Basic abc123"), null);
  assert.equal(bearerFrom("Bearer"), null);
  assert.equal(bearerFrom(undefined), null);
});

test("isValidSlug is the same rule the table CHECK enforces", () => {
  for (const ok of ["lucas", "a1", "alice_b", "x".repeat(31)]) assert.equal(isValidSlug(ok), true, ok);
  for (const bad of ["Lucas", "1abc", "a", "a-b", "a b", "x".repeat(32), "", null, "drop;"]) {
    assert.equal(isValidSlug(bad), false, String(bad));
  }
});

test("secretEquals refuses anything but the exact secret", () => {
  assert.equal(secretEquals("k1", "k1"), true);
  assert.equal(secretEquals("k1", "k2"), false);
  assert.equal(secretEquals("k", "k1"), false);
  assert.equal(secretEquals(undefined, "k1"), false);
  assert.equal(secretEquals("k1", undefined), false);
});

test("hashToken is sha256 hex, and differs per token", () => {
  assert.match(hashToken("stl_a"), /^[0-9a-f]{64}$/);
  assert.notEqual(hashToken("stl_a"), hashToken("stl_b"));
});
