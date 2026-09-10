import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

/**
 * Every connection is opened as the collaborator's OWN Postgres role, never as
 * postgres or service_role. Isolation is therefore enforced by Postgres itself:
 * a bug in this server still cannot reach another collaborator's database.
 */
export function readCollaboratorEnv(dir, slug) {
  const file = path.join(dir, `${slug}.env`);
  const values = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    values[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const required = ["SUPABASE_DB_USER", "SUPABASE_DB_PASSWORD", "SUPABASE_DB_NAME"];
  for (const key of required) {
    if (!values[key]) throw new Error(`${file} is missing ${key}`);
  }
  return values;
}

export class PoolRegistry {
  #pools = new Map();

  constructor({ credentialsDir, host, port, statementTimeoutMs }) {
    this.credentialsDir = credentialsDir;
    this.host = host;
    this.port = port;
    this.statementTimeoutMs = statementTimeoutMs;
  }

  forSlug(slug) {
    const existing = this.#pools.get(slug);
    if (existing) return existing;

    const env = readCollaboratorEnv(this.credentialsDir, slug);
    const pool = new Pool({
      host: this.host,
      port: this.port,
      user: env.SUPABASE_DB_USER,
      password: env.SUPABASE_DB_PASSWORD,
      database: env.SUPABASE_DB_NAME,
      max: 4,
      idleTimeoutMillis: 30_000,
      statement_timeout: this.statementTimeoutMs,
    });
    // A pool error must not take the process down with it.
    pool.on("error", (err) => console.error(`[pool:${slug}] ${err.message}`));
    this.#pools.set(slug, pool);
    return pool;
  }

  async closeAll() {
    await Promise.all([...this.#pools.values()].map((p) => p.end()));
    this.#pools.clear();
  }
}
