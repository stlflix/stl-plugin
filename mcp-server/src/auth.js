import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Token store: { "<sha256 of token>": "<collaborator slug>" }.
 * Only the hash is ever written to disk, so the file is not a list of credentials.
 */
export function loadTokenMap(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const map = new Map();
  for (const [hash, slug] of Object.entries(raw)) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`token map key is not a sha256: ${hash}`);
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(slug)) throw new Error(`invalid slug in token map: ${slug}`);
    map.set(hash, slug);
  }
  if (map.size === 0) throw new Error(`token map ${path} is empty`);
  return map;
}

export function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time lookup, so a wrong token cannot be probed byte by byte. */
export function slugForToken(tokenMap, token) {
  if (typeof token !== "string" || token.length === 0) return null;
  const candidate = Buffer.from(hashToken(token), "hex");
  for (const [hash, slug] of tokenMap) {
    const known = Buffer.from(hash, "hex");
    if (known.length === candidate.length && timingSafeEqual(known, candidate)) return slug;
  }
  return null;
}

export function bearerFrom(headerValue) {
  if (typeof headerValue !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(headerValue.trim());
  return match ? match[1] : null;
}
