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

  constructor({ store, host, port, statementTimeoutMs }) {
    this.store = store;
    this.host = host;
    this.port = port;
    this.statementTimeoutMs = statementTimeoutMs;
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

  /** After a re-provision the password changed: the cached pool is stale. */
  async drop(slug) {
    const pool = this.#pools.get(slug);
    if (!pool) return;
    this.#pools.delete(slug);
    await pool.end();
  }

  async closeAll() {
    await Promise.all([...this.#pools.values()].map((p) => p.end()));
    this.#pools.clear();
  }
}
