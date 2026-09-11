import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for the collaborator role passwords at rest. The key is the
 * server's own (`CREDENTIALS_KEY`): a dump of the table alone yields nothing.
 * Wire format: base64(iv[12] | tag[16] | ciphertext).
 */
export function loadKey(hex) {
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("CREDENTIALS_KEY must be 32 bytes as 64 hex characters");
  }
  return Buffer.from(hex, "hex");
}

export function encrypt(plain, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function decrypt(encoded, key) {
  const raw = Buffer.from(encoded, "base64");
  if (raw.length < 28) throw new Error("ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
