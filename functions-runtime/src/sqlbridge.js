/**
 * The only path from a collaborator's code to their database, and the reason
 * the child process needs no credential at all (I3). Every `ctx.sql` lands here,
 * in the parent, and is wrapped in a transaction that says WHO is asking
 * before it says WHAT is asked:
 *
 *   BEGIN → SET LOCAL statement_timeout → SET LOCAL ROLE <slug>_<role>
 *         → set_config('request.jwt.claims') → [upsert auth.users] → statement → COMMIT
 *
 * The connection is `<slug>_fn`, a LOGIN role that owns nothing: without the
 * `SET LOCAL ROLE` it cannot read a table at all, and with it RLS applies —
 * the owner would have bypassed it (I4).
 */
import pg from "pg";

export const STATEMENT_TIMEOUT_MS = 5_000;
export const MAX_INVOCATION_ROWS = 200;
export const INVOCATION_RETENTION = "24 hours";
export const SLUG_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;
export const ROLES = ["anon", "authenticated"];

/** Postgres refused the login itself: the password changed under us. */
const AUTH_FAILURE_CODES = new Set(["28P01", "28000"]);

export class UnknownSlug extends Error {
  constructor(slug) {
    super(`no execution credential for '${slug}'`);
    this.name = "UnknownSlug";
    this.slug = slug;
  }
}

export class InvalidUser extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidUser";
  }
}

/** The database's verdict, carried as text and SQLSTATE — never as a stack. */
export class SqlError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "SqlError";
    this.code = code ?? null;
  }
}

const UPSERT_USER_SQL = `INSERT INTO auth.users (id, email, name, is_super) VALUES ($1, $2, $3, $4)
  ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), email = EXCLUDED.email, name = EXCLUDED.name, is_super = EXCLUDED.is_super`;

const INSERT_INVOCATION_SQL = `INSERT INTO buildloop.invocations (name, version, status, duration_ms, log, error)
  VALUES ($1, $2, $3, $4, $5::jsonb, $6)`;

/** Retention is BL-24: the last 200 of a function, and nothing older than a day. */
const TRIM_INVOCATIONS_SQL = `DELETE FROM buildloop.invocations
  WHERE name = $1
    AND (at < now() - interval '${INVOCATION_RETENTION}'
         OR id NOT IN (SELECT id FROM buildloop.invocations WHERE name = $1 ORDER BY at DESC, id DESC LIMIT $2))`;

function assertSlug(slug) {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) throw new InvalidUser(`invalid slug: ${slug}`);
  return slug;
}

/**
 * The role is chosen here and nowhere else, from a closed list — the name is
 * interpolated into `SET LOCAL ROLE`, so it may never come from a claim.
 */
export function roleFor(slug, user) {
  assertSlug(slug);
  const role = user?.role;
  if (!ROLES.includes(role)) throw new InvalidUser(`role must be one of ${ROLES.join(", ")}`);
  return `${slug}_${role}`;
}

export class SqlBridge {
  #credentials = new Map();
  #pools = new Map();
  // One upsert per invocation: the gateway builds one `user` object per request
  // and hands the same one to every `ctx.sql` of that invocation.
  #upserted = new WeakSet();

  constructor({ mcp, config, PoolClass = pg.Pool }) {
    this.mcp = mcp;
    this.config = config;
    this.PoolClass = PoolClass;
  }

  /** Cached until Postgres itself refuses the login; then it is asked again. */
  async credentialFor(slug) {
    assertSlug(slug);
    const cached = this.#credentials.get(slug);
    if (cached) return cached;
    const credential = await this.mcp.credential(slug);
    if (!credential) throw new UnknownSlug(slug);
    this.#credentials.set(slug, credential);
    return credential;
  }

  async poolFor(slug) {
    const existing = this.#pools.get(slug);
    if (existing) return existing;
    const credential = await this.credentialFor(slug);
    const pool = new this.PoolClass({
      host: this.config.dbHost,
      port: this.config.dbPort,
      database: credential.database,
      user: credential.user,
      password: credential.password,
      max: 4,
      idleTimeoutMillis: 30_000,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    });
    pool.on?.("error", (err) => console.error(`[sqlbridge:${slug}] ${err.message}`));
    this.#pools.set(slug, pool);
    return pool;
  }

  async forget(slug) {
    this.#credentials.delete(slug);
    const pool = this.#pools.get(slug);
    this.#pools.delete(slug);
    await pool?.end?.();
  }

  async run(slug, user, text, params) {
    if (typeof text !== "string" || text.trim() === "") throw new InvalidUser("sql must be a non-empty string");
    if (params !== undefined && params !== null && !Array.isArray(params)) {
      throw new InvalidUser("sql parameters must be an array");
    }
    const role = roleFor(slug, user);
    const client = await (await this.poolFor(slug)).connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      await client.query(`SET LOCAL ROLE "${role}"`);
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(user.claims ?? {})]);
      if (user.role === "authenticated" && !this.#upserted.has(user)) {
        this.#upserted.add(user);
        await client.query(UPSERT_USER_SQL, claimsToUserRow(user.claims));
      }
      // `queryMode: "extended"` and not merely `values`: pg falls back to the
      // SIMPLE protocol when the array is empty, and the simple protocol accepts
      // several statements in one string. Extended is what makes "one statement
      // per ctx.sql" true by construction instead of by parsing.
      const result = await client.query({ text, values: params ?? [], queryMode: "extended" });
      await client.query("COMMIT");
      return {
        command: result.command ?? null,
        rowCount: result.rowCount ?? null,
        fields: (result.fields ?? []).map((field) => field.name),
        rows: result.rows ?? [],
      };
    } catch (err) {
      await rollback(client);
      if (AUTH_FAILURE_CODES.has(err.code)) await this.forget(slug);
      throw new SqlError(err.message, err.code);
    } finally {
      client.release();
    }
  }

  /**
   * The invocation log, written by `<slug>_fn` in the collaborator's own
   * database. Trimming happens on the same connection right after the insert,
   * so a busy function cannot grow the table past its retention.
   */
  async writeInvocation(slug, { name, version = null, status = null, durationMs = null, log = [], error = null }) {
    const client = await (await this.poolFor(slug)).connect();
    try {
      await client.query(INSERT_INVOCATION_SQL, [name, version, status, durationMs, JSON.stringify(log ?? []), error]);
      await client.query(TRIM_INVOCATIONS_SQL, [name, MAX_INVOCATION_ROWS]);
    } finally {
      client.release();
    }
  }

  async close() {
    await Promise.all([...this.#pools.values()].map((pool) => pool.end?.()));
    this.#pools.clear();
    this.#credentials.clear();
  }
}

/** The platform's id is an integer (design assumption); a claim that is not one is a bug upstream. */
function claimsToUserRow(claims) {
  const id = Number(claims?.sub);
  if (!Number.isInteger(id)) throw new InvalidUser(`an authenticated caller must carry an integer sub, got ${claims?.sub}`);
  return [id, claims.email ?? null, claims.name ?? null, claims.is_super === true];
}

async function rollback(client) {
  try {
    await client.query("ROLLBACK");
  } catch (err) {
    console.error(`[sqlbridge] rollback failed: ${err.message}`);
  }
}
