/**
 * Tools exposed to a collaborator, all scoped to their own database by the
 * Postgres role the pool authenticates with.
 */
import {
  DESCRIBE_SQL,
  FUNCTIONS_SQL,
  FUNCTION_DEF_SQL,
  LIST_TABLES_SQL,
  POLICIES_SQL,
  RLS_STATE_SQL,
  TABLE_POLICIES_SQL,
  rowsToFunctions,
  rowsToRlsState,
  runLints,
} from "./catalog.js";
import { runExec } from "./mutations.js";
import { createPolicySql, dropPolicySql, setRlsSql } from "./policy-sql.js";

const MIGRATIONS_SCHEMA = "supabase_migrations";
const MIGRATIONS_TABLE = "schema_migrations";

export function defineTools({ pools }) {
  const query = async (slug, sql, params = []) => {
    const result = await (await pools.forSlug(slug)).query(sql, params);
    return result;
  };

  /**
   * A statement written by `policy-sql.js` — the same one the Studio's `exec`
   * route sends — applied in one transaction. `policy-sql` throws before this
   * runs, so a refused name never reaches the pool (BL-26).
   */
  const exec = async (slug, sql) => ({ sql, results: await runExec(await pools.forSlug(slug), [{ sql }]) });

  const relation = {
    type: "object",
    properties: {
      schema: { type: "string", description: "Schema name; defaults to public" },
      table: { type: "string", description: "Table name" },
    },
    required: ["table"],
  };

  return [
    {
      name: "list_tables",
      title: "List tables",
      description: "Every table, view and materialized view in your database, with whether RLS is on.",
      inputSchema: { type: "object", properties: {} },
      handler: async (slug) => (await query(slug, LIST_TABLES_SQL)).rows,
    },
    {
      name: "describe_table",
      title: "Describe a table",
      description: "Columns, types, defaults and RLS policies of one table (schema-qualified, e.g. public.users).",
      inputSchema: {
        type: "object",
        properties: { table: { type: "string", description: "Table name, optionally schema-qualified" } },
        required: ["table"],
      },
      handler: async (slug, { table }) => {
        const columns = (await query(slug, DESCRIBE_SQL, [table])).rows;
        if (columns.length === 0) throw new Error(`no table named '${table}' in your database`);
        const policies = (await query(slug, TABLE_POLICIES_SQL, [table])).rows;
        return { table, columns, policies };
      },
    },
    {
      name: "run_sql",
      title: "Run SQL",
      description: "Run SQL against your own database. Your Postgres role is the only authority — nothing outside your database is reachable.",
      inputSchema: {
        type: "object",
        properties: { sql: { type: "string", description: "SQL to execute" } },
        required: ["sql"],
      },
      handler: async (slug, { sql }) => {
        const result = await query(slug, sql);
        const results = Array.isArray(result) ? result : [result];
        return results.map((r) => ({ command: r.command, rowCount: r.rowCount, rows: r.rows ?? [] }));
      },
    },
    {
      name: "apply_migration",
      title: "Apply a migration",
      description: "Run a named migration in one transaction and record it, the same way `supabase db push` does.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Migration name, e.g. create_profiles" },
          sql: { type: "string", description: "DDL to apply" },
        },
        required: ["name", "sql"],
      },
      handler: async (slug, { name, sql }) => {
        if (!/^[a-z0-9_]{1,60}$/.test(name)) {
          throw new Error("migration name must match ^[a-z0-9_]{1,60}$");
        }
        const version = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
        const client = await (await pools.forSlug(slug)).connect();
        try {
          await client.query("BEGIN");
          await client.query(`CREATE SCHEMA IF NOT EXISTS ${MIGRATIONS_SCHEMA}`);
          await client.query(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE} (
            version text PRIMARY KEY, name text, statements text[], applied_at timestamptz DEFAULT now())`);
          await client.query(sql);
          await client.query(
            `INSERT INTO ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE} (version, name, statements) VALUES ($1, $2, $3)`,
            [version, name, [sql]],
          );
          await client.query("COMMIT");
          return { version, name, applied: true };
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      },
    },
    {
      name: "list_migrations",
      title: "List migrations",
      description: "Migrations already applied to your database, newest first.",
      inputSchema: { type: "object", properties: {} },
      handler: async (slug) => {
        const result = await query(
          slug,
          `SELECT version, name, applied_at FROM ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE} ORDER BY version DESC`,
        ).catch((err) => {
          if (err.code === "42P01") return { rows: [] }; // no migration table yet
          throw err;
        });
        return result.rows;
      },
    },
    {
      name: "list_functions",
      title: "List functions",
      description: "Every function of your own schemas, with its arguments, return type, language, SECURITY DEFINER/INVOKER and volatility.",
      inputSchema: { type: "object", properties: {} },
      handler: async (slug) => rowsToFunctions((await query(slug, FUNCTIONS_SQL)).rows),
    },
    {
      name: "get_function",
      title: "Get a function",
      description: "The full definition of one function, as Postgres re-prints it (pg_get_functiondef).",
      inputSchema: {
        type: "object",
        properties: { oid: { type: "integer", description: "Function oid, from list_functions" } },
        required: ["oid"],
      },
      handler: async (slug, { oid }) => {
        if (!Number.isInteger(oid) || oid <= 0) throw new Error("oid must be a positive integer");
        const { rows } = await query(slug, FUNCTION_DEF_SQL, [oid]);
        const definition = rows[0]?.definition ?? null;
        if (!definition) throw new Error(`no function with oid ${oid} in your database`);
        return { oid, definition };
      },
    },
    {
      name: "list_policies",
      title: "List RLS state and policies",
      description: "Every table with its row level security state (off, on, forced) and the policies attached to it.",
      inputSchema: { type: "object", properties: {} },
      handler: async (slug) => {
        const state = await query(slug, RLS_STATE_SQL);
        const policies = await query(slug, POLICIES_SQL);
        return rowsToRlsState(state.rows, policies.rows);
      },
    },
    {
      name: "set_rls",
      title: "Turn row level security on or off",
      description: "Enable, disable, force or unforce row level security on one of your tables.",
      inputSchema: {
        ...relation,
        properties: {
          ...relation.properties,
          mode: { type: "string", enum: ["enable", "disable", "force", "noforce"], description: "What to do" },
        },
        required: ["table", "mode"],
      },
      handler: async (slug, args) => exec(slug, setRlsSql(args)),
    },
    {
      name: "create_policy",
      title: "Create a policy",
      description: "Create a row level security policy. USING and WITH CHECK are your own SQL expressions; Postgres judges them.",
      inputSchema: {
        ...relation,
        properties: {
          ...relation.properties,
          name: { type: "string", description: "Policy name" },
          command: { type: "string", enum: ["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"], description: "Command the policy covers" },
          roles: { type: "array", items: { type: "string" }, description: "Roles the policy applies to, e.g. <slug>_authenticated" },
          using: { type: "string", description: "USING expression" },
          withCheck: { type: "string", description: "WITH CHECK expression" },
          permissive: { type: "boolean", description: "PERMISSIVE (default) or RESTRICTIVE" },
        },
        required: ["table", "name", "roles"],
      },
      handler: async (slug, args) => exec(slug, createPolicySql(args)),
    },
    {
      name: "drop_policy",
      title: "Drop a policy",
      description: "Remove one policy from one of your tables.",
      inputSchema: {
        ...relation,
        properties: { ...relation.properties, name: { type: "string", description: "Policy name" } },
        required: ["table", "name"],
      },
      handler: async (slug, args) => exec(slug, dropPolicySql(args)),
    },
    {
      name: "security_lint",
      title: "Security lint",
      description: "Run the fixed catalogue of eight security checks on your database, worst first, each with the SQL that fixes it when there is one.",
      inputSchema: { type: "object", properties: {} },
      handler: async (slug) => runLints(await pools.forSlug(slug)),
    },
  ];
}
