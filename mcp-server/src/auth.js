import { createHash, timingSafeEqual } from "node:crypto";

export const SLUG_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;

export function isValidSlug(slug) {
  return typeof slug === "string" && SLUG_PATTERN.test(slug);
}

export function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function bearerFrom(headerValue) {
  if (typeof headerValue !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(headerValue.trim());
  return match ? match[1] : null;
}

/** Constant-time equality for shared secrets, so a wrong key cannot be probed byte by byte. */
export function secretEquals(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
