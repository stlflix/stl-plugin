import pg from "pg";

const { Pool } = pg;

/**
 * One pool per collaborator, opened with the collaborator's OWN Postgres role —
 * never postgres or service_role. Isolation is therefore enforced by Postgres
 * itself: a bug in this server still cannot reach another collaborator's
 * database.
 */
export class PoolRegistry {
  #pools = new Map();
  #adminPools = new Map();

  constructor({ store, host, port, statementTimeoutMs, adminConnection = null }) {
    this.store = store;
    this.host = host;
    this.port = port;
    this.statementTimeoutMs = statementTimeoutMs;
    this.adminConnection = adminConnection;
  }

  async forSlug(slug) {
    const existing = this.#pools.get(slug);
    if (existing) return existing;

    const credentials = await this.store.connectionFor(slug);
    if (!credentials) throw new Error(`collaborator '${slug}' is not provisioned`);
    const pool = new Pool({
      host: this.host,
      port: this.port,
      ...credentials,
      max: 4,
      idleTimeoutMillis: 30_000,
      statement_timeout: this.statementTimeoutMs,
    });
    // A pool error must not take the process down with it.
    pool.on("error", (err) => console.error(`[pool:${slug}] ${err.message}`));
    this.#pools.set(slug, pool);
    return pool;
  }

  /**
   * The SAME database, opened as the admin role instead of the collaborator's
   * (AD-009). It is how the project's own metadata — the `buildloop` schema —
   * is written: the slug owns `public`, not `buildloop`, and must never be able
   * to read a secret or rewrite a published version. Still one database per
   * slug, so nothing here reaches another collaborator's data either.
   */
  async adminForSlug(slug) {
    const existing = this.#adminPools.get(slug);
    if (existing) return existing;

    if (!this.adminConnection) throw new Error("no admin connection: the registry was built without one");
    const row = await this.store.get(slug);
    if (!row) throw new Error(`collaborator '${slug}' is not provisioned`);
    const pool = new Pool({
      ...this.adminConnection,
      database: row.db_name,
      max: 4,
      idleTimeoutMillis: 30_000,
      statement_timeout: this.statementTimeoutMs,
    });
    pool.on("error", (err) => console.error(`[pool:admin:${slug}] ${err.message}`));
    this.#adminPools.set(slug, pool);
    return pool;
  }

  /** After a re-provision the password changed: the cached pool is stale. */
  async drop(slug) {
    const pool = this.#pools.get(slug);
    const adminPool = this.#adminPools.get(slug);
    this.#pools.delete(slug);
    this.#adminPools.delete(slug);
    await Promise.all([pool?.end(), adminPool?.end()]);
  }

  async closeAll() {
    await Promise.all([...this.#pools.values(), ...this.#adminPools.values()].map((p) => p.end()));
    this.#pools.clear();
    this.#adminPools.clear();
  }
}
