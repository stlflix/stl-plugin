import { decrypt, encrypt } from "./crypto.js";

/**
 * Collaborator registry, in the shared `postgres` database under `stl_mcp`.
 * Collaborators cannot CONNECT to that database, so the table is out of their
 * reach by the same rule that keeps them out of `auth.users`.
 */
export class CollaboratorStore {
  constructor(adminPool, key) {
    this.pool = adminPool;
    this.key = key;
  }

  async ensureSchema() {
    await this.pool.query("CREATE SCHEMA IF NOT EXISTS stl_mcp");
    await this.pool.query(`CREATE TABLE IF NOT EXISTS stl_mcp.collaborators (
      slug            text PRIMARY KEY CHECK (slug ~ '^[a-z][a-z0-9_]{1,30}$'),
      email           text,
      db_name         text NOT NULL,
      role_name       text NOT NULL,
      password_enc    text NOT NULL,
      token_hash      text UNIQUE,
      token_issued_at timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    )`);
    await this.pool.query("REVOKE ALL ON SCHEMA stl_mcp FROM PUBLIC");
  }

  async count() {
    const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM stl_mcp.collaborators");
    return rows[0].n;
  }

  async get(slug) {
    const { rows } = await this.pool.query(
      `SELECT slug, email, db_name, role_name, token_hash IS NOT NULL AS has_token,
              token_issued_at, created_at
       FROM stl_mcp.collaborators WHERE slug = $1`,
      [slug],
    );
    return rows[0] ?? null;
  }

  /** Credentials for opening a pool AS the collaborator. Never leaves the server. */
  async connectionFor(slug) {
    const { rows } = await this.pool.query(
      "SELECT db_name, role_name, password_enc FROM stl_mcp.collaborators WHERE slug = $1",
      [slug],
    );
    const row = rows[0];
    if (!row) return null;
    return { database: row.db_name, user: row.role_name, password: decrypt(row.password_enc, this.key) };
  }

  async slugForTokenHash(hash) {
    const { rows } = await this.pool.query(
      "SELECT slug FROM stl_mcp.collaborators WHERE token_hash = $1",
      [hash],
    );
    return rows[0]?.slug ?? null;
  }

  async upsert({ slug, email, dbName, password }) {
    await this.pool.query(
      `INSERT INTO stl_mcp.collaborators (slug, email, db_name, role_name, password_enc)
       VALUES ($1, $2, $3, $1, $4)
       ON CONFLICT (slug) DO UPDATE
         SET email = COALESCE(EXCLUDED.email, stl_mcp.collaborators.email),
             password_enc = EXCLUDED.password_enc,
             updated_at = now()`,
      [slug, email ?? null, dbName, encrypt(password, this.key)],
    );
  }

  async setTokenHash(slug, hash) {
    const { rowCount } = await this.pool.query(
      `UPDATE stl_mcp.collaborators
       SET token_hash = $2, token_issued_at = now(), updated_at = now() WHERE slug = $1`,
      [slug, hash],
    );
    if (rowCount === 0) throw new Error(`collaborator '${slug}' is not provisioned`);
  }
}
