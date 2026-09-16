/**
 * The public door of every collaborator function: it decides WHO is calling
 * before anything of theirs runs, and it is the only place that turns a bearer
 * into a database role.
 *
 * Order matters and is the order of the checks below — a name that does not
 * exist must not cost a rate-limit token, and a 2 MB body must not be read
 * before it is refused.
 */
import { jwtVerify } from "jose";

export const SLUG_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;
export const FUNCTION_NAME_PATTERN = /^[a-z][a-z0-9-]{1,40}$/;
export const MAX_BODY_BYTES = 1024 * 1024;
export const ISSUER = "productops";

/** Nothing a function answers may ever sit in a shared cache (AD-003, AD-028). */
export const NO_STORE = { "cache-control": "private, no-store" };

export class BodyTooLarge extends Error {
  constructor() {
    super("request body is larger than 1 MB");
    this.name = "BodyTooLarge";
  }
}

export function audienceFor(slug) {
  return `buildloop:${slug}`;
}

/**
 * A bucket per slug: 120 tokens that refill continuously over a minute, so a
 * burst is allowed and a sustained flood is not. `Retry-After` is whole
 * seconds, as the header demands.
 */
class Buckets {
  #buckets = new Map();

  constructor(perMinute, now = () => Date.now()) {
    this.perMinute = perMinute;
    this.now = now;
  }

  take(slug) {
    const at = this.now();
    const bucket = this.#buckets.get(slug) ?? { tokens: this.perMinute, at };
    const refilled = Math.min(this.perMinute, bucket.tokens + ((at - bucket.at) * this.perMinute) / 60_000);
    if (refilled < 1) {
      this.#buckets.set(slug, { tokens: refilled, at });
      return { allowed: false, retryAfter: Math.max(1, Math.ceil(((1 - refilled) * 60_000) / this.perMinute / 1000)) };
    }
    this.#buckets.set(slug, { tokens: refilled - 1, at });
    return { allowed: true };
  }
}

function refuse(status, error) {
  return { ok: false, status, error, headers: { ...NO_STORE } };
}

/**
 * `jwks` is a resolver over the platform's PUBLIC key (`createLocalJWKSet`):
 * this process can verify an identity and can never mint one (I6).
 */
export function gateway(config, jwks, { now = () => Date.now() } = {}) {
  const buckets = new Buckets(config.rateLimitPerMin, now);

  return async function admit({ slug, name, headers = {} }) {
    if (!SLUG_PATTERN.test(slug ?? "")) return refuse(400, "slug must match ^[a-z][a-z0-9_]{1,30}$");
    if (!FUNCTION_NAME_PATTERN.test(name ?? "")) return refuse(400, "name must match ^[a-z][a-z0-9-]{1,40}$");

    const rate = buckets.take(slug);
    if (!rate.allowed) {
      return { ...refuse(429, "too many requests"), headers: { ...NO_STORE, "retry-after": String(rate.retryAfter) } };
    }

    const declared = Number(headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return refuse(413, "request body is larger than 1 MB");

    const bearer = bearerFrom(headers.authorization);
    // No bearer is not an error: that is what `<slug>_anon` exists for.
    if (!bearer) return { ok: true, user: { role: "anon", claims: {} }, headers: { ...NO_STORE } };

    try {
      const { payload } = await jwtVerify(bearer, jwks, {
        issuer: ISSUER,
        audience: audienceFor(slug),
        algorithms: ["ES256"],
      });
      return { ok: true, user: { role: "authenticated", claims: payload }, headers: { ...NO_STORE } };
    } catch {
      // Why it failed — signature, audience, expiry — is the caller's business
      // to fix and not ours to describe.
      return refuse(401, "invalid token");
    }
  };
}

function bearerFrom(value) {
  if (typeof value !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return match ? match[1] : null;
}

/**
 * A `Content-Length` can lie, and a chunked request has none: the stream is cut
 * the moment it passes the cap, so a body too large is never held in memory.
 */
export async function readLimitedBody(stream, max = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > max) {
      stream.destroy?.();
      throw new BodyTooLarge();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
