/**
 * Edge Functions: the collaborator's own HTTP handlers, kept in their own
 * database (schema `buildloop`) and compiled here. The draft is version 0 — it
 * exists as soon as the editor saves and never answers a request; publishing
 * compiles it into the next version, and only then does `current_version` move.
 * A compilation that fails therefore leaves what is live exactly as it was
 * (BL-20).
 */
import * as esbuild from "esbuild";
import { decrypt, encrypt } from "./crypto.js";

export const FUNCTION_NAME_PATTERN = /^[a-z][a-z0-9-]{1,40}$/;
export const SECRET_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_SOURCE_BYTES = 256 * 1024;
export const MAX_LOGS = 200;

/** Version 0 is the draft: saved, compiled by nothing, served to no one. */
export const DRAFT_VERSION = 0;

export class InvalidFunctionInput extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidFunctionInput";
  }
}

export class UnknownFunction extends Error {
  constructor(name) {
    super(`no edge function named '${name}' in this database`);
    this.name = "UnknownFunction";
    this.functionName = name;
  }
}

/** esbuild's verdict, carried whole: its text and where it stopped reading. */
export class CompileError extends Error {
  constructor({ text, line, column }) {
    super(line === null ? text : `${text} at ${line}:${column}`);
    this.name = "CompileError";
    this.text = text;
    this.line = line;
    this.column = column;
  }
}

export function assertFunctionName(name) {
  if (typeof name !== "string" || !FUNCTION_NAME_PATTERN.test(name)) {
    throw new InvalidFunctionInput(`name must match ${FUNCTION_NAME_PATTERN.source}`);
  }
  return name;
}

function assertSource(source) {
  if (typeof source !== "string" || source.trim() === "") {
    throw new InvalidFunctionInput("source must be a non-empty string");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    throw new InvalidFunctionInput(`source must be at most ${MAX_SOURCE_BYTES} bytes`);
  }
  return source;
}

/**
 * TypeScript in, one ESM module out, nothing written to disk: the bundle is a
 * string that goes into the database, which is the only source of truth the
 * runtime reads. esbuild counts lines from 1 and columns from 0 — the same
 * numbers it prints — and they travel unchanged to the editor.
 */
export async function compile(source, name = "function") {
  try {
    const result = await esbuild.build({
      stdin: { contents: source, loader: "ts", sourcefile: `${name}.ts` },
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      write: false,
    });
    return result.outputFiles[0].text;
  } catch (err) {
    const first = Array.isArray(err.errors) ? err.errors[0] : null;
    if (!first) throw err;
    throw new CompileError({
      text: first.text,
      line: first.location?.line ?? null,
      column: first.location?.column ?? null,
    });
  }
}

async function inTransaction(pool, body) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await body(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error(`[edge] rollback failed: ${rollbackErr.message}`);
    }
    throw err;
  } finally {
    client.release();
  }
}

const LIST_SQL = `SELECT f.name, f.current_version, f.updated_at, v.created_at AS published_at,
    COALESCE((SELECT array_agg(s.key ORDER BY s.key) FROM buildloop.edge_function_secrets s WHERE s.name = f.name), '{}') AS secret_keys
  FROM buildloop.edge_functions f
  LEFT JOIN buildloop.edge_function_versions v ON v.name = f.name AND v.version = f.current_version
  ORDER BY f.name`;

export async function list(pool) {
  const { rows } = await pool.query(LIST_SQL);
  return rows.map((row) => ({
    name: row.name,
    currentVersion: row.current_version,
    publishedAt: row.published_at ?? null,
    updatedAt: row.updated_at ?? null,
    secretKeys: row.secret_keys ?? [],
  }));
}

/** Saving never compiles: a draft that does not build is still the collaborator's work. */
export async function save(pool, name, source) {
  assertFunctionName(name);
  assertSource(source);
  return inTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO buildloop.edge_functions (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET updated_at = now()`,
      [name],
    );
    await client.query(
      `INSERT INTO buildloop.edge_function_versions (name, version, source, bundle) VALUES ($1, $2, $3, '')
       ON CONFLICT (name, version) DO UPDATE SET source = EXCLUDED.source, created_at = now()`,
      [name, DRAFT_VERSION, source],
    );
    return { name, saved: true };
  });
}

/**
 * Compile first, write after: `CompileError` is thrown before the transaction
 * opens, so `current_version` — the version the runtime serves — cannot move
 * because of a source that does not build.
 */
export async function publish(pool, name) {
  assertFunctionName(name);
  const { rows } = await pool.query(
    "SELECT source FROM buildloop.edge_function_versions WHERE name = $1 AND version = $2",
    [name, DRAFT_VERSION],
  );
  const source = rows[0]?.source;
  if (typeof source !== "string") throw new UnknownFunction(name);
  const bundle = await compile(source, name);

  return inTransaction(pool, async (client) => {
    const current = await client.query(
      "SELECT current_version FROM buildloop.edge_functions WHERE name = $1 FOR UPDATE",
      [name],
    );
    const version = (current.rows[0]?.current_version ?? DRAFT_VERSION) + 1;
    await client.query(
      "INSERT INTO buildloop.edge_function_versions (name, version, source, bundle) VALUES ($1, $2, $3, $4)",
      [name, version, source, bundle],
    );
    await client.query(
      "UPDATE buildloop.edge_functions SET current_version = $2, updated_at = now() WHERE name = $1",
      [name, version],
    );
    return { name, version, bytes: Buffer.byteLength(bundle, "utf8") };
  });
}

/**
 * Write-only by construction: what comes back is the set of keys, never a value
 * (BL-20). A key set to `null` is removed.
 */
export async function setSecrets(pool, name, entries, key) {
  assertFunctionName(name);
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
    throw new InvalidFunctionInput("secrets must be an object of KEY: value");
  }
  const pairs = Object.entries(entries);
  if (pairs.length === 0) throw new InvalidFunctionInput("secrets must hold at least one key");
  for (const [secretKey, value] of pairs) {
    if (!SECRET_KEY_PATTERN.test(secretKey)) {
      throw new InvalidFunctionInput(`secret key must match ${SECRET_KEY_PATTERN.source}`);
    }
    if (value !== null && typeof value !== "string") {
      throw new InvalidFunctionInput(`secret '${secretKey}' must be a string, or null to remove it`);
    }
  }
  await inTransaction(pool, async (client) => {
    for (const [secretKey, value] of pairs) {
      if (value === null) {
        await client.query("DELETE FROM buildloop.edge_function_secrets WHERE name = $1 AND key = $2", [name, secretKey]);
        continue;
      }
      await client.query(
        `INSERT INTO buildloop.edge_function_secrets (name, key, value_enc) VALUES ($1, $2, $3)
         ON CONFLICT (name, key) DO UPDATE SET value_enc = EXCLUDED.value_enc`,
        [name, secretKey, encrypt(value, key)],
      );
    }
  });
  return { name, keys: await secretKeys(pool, name) };
}

export async function secretKeys(pool, name) {
  assertFunctionName(name);
  const { rows } = await pool.query(
    "SELECT key FROM buildloop.edge_function_secrets WHERE name = $1 ORDER BY key",
    [name],
  );
  return rows.map((row) => row.key);
}

/**
 * The only place a secret is ever decrypted, and the only caller is the runtime
 * API: what it answers goes into a child process's `env` and nowhere else.
 * A function that was never published has nothing to serve.
 */
export async function bundleFor(pool, name, key) {
  assertFunctionName(name);
  const { rows } = await pool.query(
    `SELECT f.current_version, v.bundle
     FROM buildloop.edge_functions f
     JOIN buildloop.edge_function_versions v ON v.name = f.name AND v.version = f.current_version
     WHERE f.name = $1 AND f.current_version > $2`,
    [name, DRAFT_VERSION],
  );
  const row = rows[0];
  if (!row) return null;
  const secrets = await pool.query(
    "SELECT key, value_enc FROM buildloop.edge_function_secrets WHERE name = $1 ORDER BY key",
    [name],
  );
  return {
    name,
    version: row.current_version,
    bundle: row.bundle,
    secrets: Object.fromEntries(secrets.rows.map((s) => [s.key, decrypt(s.value_enc, key)])),
  };
}

export async function logs(pool, name) {
  assertFunctionName(name);
  const { rows } = await pool.query(
    `SELECT at, version, status, duration_ms, log, error FROM buildloop.invocations
     WHERE name = $1 ORDER BY at DESC, id DESC LIMIT ${MAX_LOGS}`,
    [name],
  );
  return rows.map((row) => ({
    at: row.at,
    version: row.version,
    status: row.status,
    durationMs: row.duration_ms,
    log: row.log ?? [],
    error: row.error ?? null,
  }));
}
