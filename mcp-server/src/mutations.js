/**
 * A collaborator's writes, run on their behalf: every batch is ONE transaction,
 * time-boxed, on a pool opened with the collaborator's OWN role. Same discipline
 * as `readonly.js` — this module never parses the SQL to decide anything;
 * Postgres is the one that refuses. What it adds is the expected row count: an
 * `UPDATE` that touches nothing means the row moved under the client, and the
 * whole batch is undone (BL-02).
 */
import { isPostgresError } from "./readonly.js";

export const EXEC_TIMEOUT_MS = 10_000;
export const MAX_STATEMENTS = 50;
export const MAX_SQL_BYTES = 64 * 1024;

export class InvalidExecInput extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidExecInput";
  }
}

/** The batch was valid SQL but the world had moved: nothing was applied. */
export class ExecConflict extends Error {
  constructor({ index, expected, got }) {
    super(`statement ${index} affected ${got} row(s), expected ${expected}`);
    this.name = "ExecConflict";
    this.index = index;
    this.expected = expected;
    this.got = got;
  }
}

/** The database's own verdict, carried out whole: its text and its SQLSTATE. */
export class SqlRejected extends Error {
  constructor(cause) {
    super(cause.message);
    this.name = "SqlRejected";
    this.code = cause.code;
    this.cause = cause;
  }
}

/** Pure: the batch is checked before a connection is even asked for. */
export function parseStatements(statements) {
  if (!Array.isArray(statements) || statements.length === 0) {
    throw new InvalidExecInput("statements must be a non-empty array");
  }
  if (statements.length > MAX_STATEMENTS) {
    throw new InvalidExecInput(`statements must hold at most ${MAX_STATEMENTS} entries`);
  }
  return statements.map((raw, index) => {
    const where = `statements[${index}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new InvalidExecInput(`${where} must be an object`);
    }
    const { sql, params, expectRowCount } = raw;
    if (typeof sql !== "string" || sql.trim() === "") {
      throw new InvalidExecInput(`${where}.sql must be a non-empty string`);
    }
    if (Buffer.byteLength(sql, "utf8") > MAX_SQL_BYTES) {
      throw new InvalidExecInput(`${where}.sql must be at most ${MAX_SQL_BYTES} bytes`);
    }
    if (params !== undefined && !Array.isArray(params)) {
      throw new InvalidExecInput(`${where}.params must be an array`);
    }
    if (expectRowCount !== undefined && (!Number.isInteger(expectRowCount) || expectRowCount < 0)) {
      throw new InvalidExecInput(`${where}.expectRowCount must be an integer >= 0`);
    }
    const parsed = { sql, params: params ?? [] };
    if (expectRowCount !== undefined) parsed.expectRowCount = expectRowCount;
    return parsed;
  });
}

async function rollbackQuietly(client) {
  try {
    await client.query("ROLLBACK");
  } catch (err) {
    console.error(`[mutations] rollback failed: ${err.message}`);
  }
}

/**
 * Each statement goes through the extended protocol (`{ text, values }`), which
 * carries exactly one statement: a batch smuggled into a single string is
 * refused by the protocol itself, without a parser of ours.
 */
export async function runExec(pool, statements, { timeoutMs = EXEC_TIMEOUT_MS } = {}) {
  const parsed = parseStatements(statements);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // LOCAL: dies with the transaction; the pool's own statement_timeout is untouched.
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    const results = [];
    for (const [index, statement] of parsed.entries()) {
      const result = await client.query({ text: statement.sql, values: statement.params });
      if (statement.expectRowCount !== undefined && result.rowCount !== statement.expectRowCount) {
        throw new ExecConflict({ index, expected: statement.expectRowCount, got: result.rowCount });
      }
      results.push({ command: result.command ?? null, rowCount: result.rowCount ?? null });
    }
    await client.query("COMMIT");
    return results;
  } catch (err) {
    await rollbackQuietly(client);
    // A SQLSTATE is the database's verdict; anything else (a dead socket, a bug
    // of ours, the conflict above) travels on untouched.
    if (isPostgresError(err)) throw new SqlRejected(err);
    throw err;
  } finally {
    client.release();
  }
}
