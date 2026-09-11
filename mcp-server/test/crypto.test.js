import assert from "node:assert/strict";
import { test } from "node:test";
import { decrypt, encrypt, loadKey } from "../src/crypto.js";

const key = loadKey("a".repeat(64));

test("loadKey demands 32 bytes of hex", () => {
  assert.throws(() => loadKey("short"), /64 hex/);
  assert.throws(() => loadKey(undefined), /64 hex/);
  assert.equal(key.length, 32);
});

test("encrypt/decrypt round-trips and never repeats a ciphertext", () => {
  const a = encrypt("p4ssw0rd", key);
  const b = encrypt("p4ssw0rd", key);
  assert.notEqual(a, b);
  assert.equal(decrypt(a, key), "p4ssw0rd");
  assert.equal(decrypt(b, key), "p4ssw0rd");
});

test("a tampered or foreign ciphertext is rejected, not decrypted to garbage", () => {
  const raw = Buffer.from(encrypt("secret", key), "base64");
  raw[raw.length - 1] ^= 0x01;
  assert.throws(() => decrypt(raw.toString("base64"), key));
  assert.throws(() => decrypt(encrypt("secret", key), loadKey("b".repeat(64))));
  assert.throws(() => decrypt("AAAA", key), /too short/);
});
