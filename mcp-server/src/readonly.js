/**
 * A collaborator's SQL, run on the platform's behalf (AD-007): inside one
 * `READ ONLY` transaction, time-boxed, on a pool opened with the collaborator's
 * OWN role. Postgres is the one that refuses a write, a table it cannot see, or
 * a slow query — this module never parses the SQL to decide anything.
 */
export const READ_ONLY_TIMEOUT_MS = 5000;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

const TYPE_NAMES_SQL = "SELECT oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1::oid[])";

export class InvalidQueryInput extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidQueryInput";
  }
}

export function parseQueryInput(body) {
  const sql = body?.sql;
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new InvalidQueryInput("sql must be a non-empty string");
  }
  const limit = body?.limit;
  if (limit === undefined || limit === null) return { sql, limit: DEFAULT_LIMIT };
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new InvalidQueryInput(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return { sql, limit };
}

/** A SQLSTATE-carrying error is the database's verdict, not a bug of ours. */
export function isPostgresError(err) {
  return err instanceof Error && typeof err.code === "string" && /^[0-9A-Z]{5}$/.test(err.code);
}

/** A multi-statement batch yields one result per statement; the last one is shown, as psql does. */
function lastResult(result) {
  const results = Array.isArray(result) ? result : [result];
  return results[results.length - 1];
}

/**
 * Rows come in array mode so two columns with the same name (`select 1, 1`)
 * both survive; `columns[i]` describes `rows[*][i]`. The cut happens here, after
 * the database answered: `rowCount` is what it returned, `truncated` says the
 * client did not get all of it.
 */
export function shapeResult(result, typeNames, limit) {
  const last = lastResult(result);
  const fields = last.fields ?? [];
  const all = last.rows ?? [];
  return {
    command: last.command ?? null,
    columns: fields.map((f) => ({ name: f.name, type: typeNames.get(f.dataTypeID) ?? String(f.dataTypeID) })),
    rows: all.slice(0, limit),
    rowCount: all.length,
    truncated: all.length > limit,
  };
}

export async function runReadOnly(pool, sql, limit) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    // LOCAL: dies with the transaction; the pool's own statement_timeout is untouched.
    await client.query(`SET LOCAL statement_timeout = ${READ_ONLY_TIMEOUT_MS}`);
    const result = await client.query({ text: sql, rowMode: "array" });
    const oids = [...new Set((lastResult(result).fields ?? []).map((f) => f.dataTypeID))];
    const typeNames = new Map();
    if (oids.length > 0) {
      const types = await client.query(TYPE_NAMES_SQL, [oids]);
      for (const row of types.rows) typeNames.set(Number(row.oid), row.name);
    }
    await client.query("COMMIT");
    return shapeResult(result, typeNames, limit);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error(`[readonly] rollback failed: ${rollbackErr.message}`);
    }
    throw err;
  } finally {
    client.release();
  }
}
