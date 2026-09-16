/**
 * The origins a collaborator's own pages may log in from, kept in the shared
 * registry (`stl_mcp`) because an origin has to be resolved to a slug BEFORE
 * anyone knows which database to open. An origin belongs to one slug in the
 * whole cluster: whoever registers it first owns it (BL-12).
 */
import { SLUG_PATTERN, isValidSlug } from "./auth.js";

export class InvalidOrigin extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidOrigin";
  }
}

/** The origin is already registered by another collaborator. */
export class OriginTaken extends Error {
  constructor(origin, slug) {
    super(`origin '${origin}' is already registered by another collaborator`);
    this.name = "OriginTaken";
    this.origin = origin;
    this.slug = slug;
  }
}

/**
 * `https://host[:port]` anywhere, or `http://localhost:<port>` for local
 * development — and nothing else: no path, no query, no credentials. The result
 * is the browser's own serialization of the origin, which is the string an
 * `Origin` header carries.
 */
export function normalizeOrigin(origin) {
  if (typeof origin !== "string" || origin.trim() === "") return null;
  let url;
  try {
    url = new URL(origin.trim());
  } catch {
    return null;
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && url.hostname === "localhost" && url.port !== "") return url.origin;
  return null;
}

/** Same rule, as a refusal: nothing reaches the database with a bad origin. */
export function assertOrigin(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) {
    throw new InvalidOrigin("origin must be https://host or http://localhost:<port>, with no path");
  }
  return normalized;
}

function assertSlug(slug) {
  if (!isValidSlug(slug)) throw new InvalidOrigin(`slug must match ${SLUG_PATTERN.source}`);
  return slug;
}

/**
 * Idempotent for the owner: a second `add` of the same origin by the same slug
 * changes nothing and answers `created: false`. By anyone else it is a conflict.
 */
export async function add(pool, slug, origin) {
  assertSlug(slug);
  const normalized = assertOrigin(origin);
  const { rows } = await pool.query(
    `INSERT INTO stl_mcp.allowed_origins (origin, slug) VALUES ($1, $2)
     ON CONFLICT (origin) DO NOTHING RETURNING origin`,
    [normalized, slug],
  );
  if (rows.length > 0) return { origin: normalized, slug, created: true };
  const owner = await slugFor(pool, normalized);
  if (owner !== slug) throw new OriginTaken(normalized, owner);
  return { origin: normalized, slug, created: false };
}

/** Only the owner removes: another slug's DELETE matches no row. */
export async function remove(pool, slug, origin) {
  assertSlug(slug);
  const normalized = assertOrigin(origin);
  const { rowCount } = await pool.query(
    "DELETE FROM stl_mcp.allowed_origins WHERE origin = $1 AND slug = $2",
    [normalized, slug],
  );
  return { origin: normalized, removed: rowCount > 0 };
}

export async function listFor(pool, slug) {
  assertSlug(slug);
  const { rows } = await pool.query(
    "SELECT origin, created_at FROM stl_mcp.allowed_origins WHERE slug = $1 ORDER BY origin",
    [slug],
  );
  return rows.map((row) => ({ origin: row.origin, createdAt: row.created_at }));
}

/** An origin nobody registered — or one that is not an origin at all — is simply unknown. */
export async function slugFor(pool, origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return null;
  const { rows } = await pool.query(
    "SELECT slug FROM stl_mcp.allowed_origins WHERE origin = $1",
    [normalized],
  );
  return rows[0]?.slug ?? null;
}
