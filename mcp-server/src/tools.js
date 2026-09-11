/**
 * Tools exposed to a collaborator, all scoped to their own database by the
 * Postgres role the pool authenticates with.
 */
const MIGRATIONS_SCHEMA = "supabase_migrations";
const MIGRATIONS_TABLE = "schema_migrations";

const LIST_TABLES_SQL = `
  SELECT n.nspname AS schema,
         c.relname AS name,
         CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view'
                        WHEN 'm' THEN 'materialized view' WHEN 'p' THEN 'partitioned table'
                        WHEN 'f' THEN 'foreign table' END AS kind,
         c.relrowsecurity AS rls_enabled,
         obj_description(c.oid) AS comment
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = ANY (ARRAY['r','v','m','p','f'])
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  ORDER BY 1, 2`;

const DESCRIBE_SQL = `
  SELECT a.attname AS column,
         format_type(a.atttypid, a.atttypmod) AS type,
         NOT a.attnotnull AS nullable,
         pg_get_expr(d.adbin, d.adrelid) AS default,
         a.attnum AS position
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attnum`;

const POLICIES_SQL = `
  SELECT policyname AS name, cmd, roles, qual AS using_expression, with_check
  FROM pg_policies WHERE schemaname || '.' || tablename = $1 OR tablename = $1`;

export function defineTools({ pools }) {
  const query = async (slug, sql, params = []) => {
    const result = await (await pools.forSlug(slug)).query(sql, params);
    return result;
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
        const policies = (await query(slug, POLICIES_SQL, [table])).rows;
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
  ];
}
