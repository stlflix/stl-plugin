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
import * as edge from "./edge.js";
import { runExec } from "./mutations.js";
import * as origins from "./origins.js";
import { createPolicySql, dropPolicySql, setRlsSql } from "./policy-sql.js";

const MIGRATIONS_SCHEMA = "supabase_migrations";
const MIGRATIONS_TABLE = "schema_migrations";

/**
 * One tool call, as the MCP protocol wants it back: the database's own verdict
 * is the text, and a refusal is `isError` — the collaborator reads what
 * Postgres or the compiler said, not a message of ours. `server.js` answers
 * with exactly this.
 */
export async function callTool(tool, slug, args) {
  try {
    const result = await tool.handler(slug, args ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `error: ${err.message}` }], isError: true };
  }
}

export function defineTools({ pools, adminPool, credentialsKey, functionsUrl = "http://functions:8300", fetchImpl = globalThis.fetch }) {
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
    {
      name: "list_edge_functions",
      title: "List edge functions",
      description: "Your HTTP functions: the live version of each, when it was published, and the KEYS of its secrets (never their values).",
      inputSchema: { type: "object", properties: {} },
      handler: async (slug) => edge.list(await pools.forSlug(slug)),
    },
    {
      name: "deploy_edge_function",
      title: "Deploy an edge function",
      description: "Save TypeScript source and publish it in one step: the new version answers at /fn/<your slug>/<name>. If it does not compile, nothing is published and the error comes back with line and column.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Function name, ^[a-z][a-z0-9-]{1,40}$" },
          source: { type: "string", description: "TypeScript: export default (req: Request, ctx) => Response" },
        },
        required: ["name", "source"],
      },
      // Writes to the `buildloop` schema go through the admin role on the
      // slug's own database — the slug has SELECT there and nothing more (AD-009).
      handler: async (slug, { name, source }) => {
        const pool = await pools.adminForSlug(slug);
        await edge.save(pool, name, source);
        return edge.publish(pool, name);
      },
    },
    {
      name: "invoke_edge_function",
      title: "Invoke an edge function",
      description: "Call one of your published functions over HTTP. The call carries NO bearer token, so the function runs as <your slug>_anon — this tool is you, not one of your logged-in users.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Function name" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method; defaults to GET" },
          body: { type: "string", description: "Request body, for the methods that take one" },
        },
        required: ["name"],
      },
      handler: async (slug, { name, method = "GET", body }) => {
        edge.assertFunctionName(name);
        const url = `${functionsUrl}/fn/${slug}/${name}`;
        const response = await fetchImpl(url, {
          method,
          // No Authorization header: the anonymous role is the point (BL-21).
          headers: body === undefined ? {} : { "Content-Type": "application/json" },
          body,
        });
        return { url, status: response.status, body: await response.text() };
      },
    },
    {
      name: "set_secrets",
      title: "Set the secrets of an edge function",
      description: "Store KEY: value pairs for one function, encrypted at rest and readable only by that function's own process (ctx.env). Nothing here is ever read back: set a key to null to remove it.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Function name" },
          secrets: { type: "object", description: "KEY: value pairs; the value null removes the key" },
        },
        required: ["name", "secrets"],
      },
      handler: async (slug, { name, secrets }) => edge.setSecrets(await pools.adminForSlug(slug), name, secrets, credentialsKey),
    },
    {
      name: "list_allowed_origins",
      title: "List allowed origins",
      description: "The origins your pages may log in from. Registered per collaborator in the shared registry, because an origin has to be resolved before anyone knows whose it is.",
      inputSchema: { type: "object", properties: {} },
      handler: async (slug) => origins.listFor(adminPool, slug),
    },
    {
      name: "add_allowed_origin",
      title: "Add an allowed origin",
      description: "Let one origin (https://host, or http://localhost:<port>) send its users through the platform login and back. An origin another collaborator already registered is refused.",
      inputSchema: {
        type: "object",
        properties: { origin: { type: "string", description: "https://app.example.com or http://localhost:5173" } },
        required: ["origin"],
      },
      handler: async (slug, { origin }) => origins.add(adminPool, slug, origin),
    },
  ];
}
