/**
 * Catalog SQL shared by the collaborator tools (`tools.js`) and the admin API
 * (`admin.js`), so both list and describe exactly the same thing. Every query
 * runs on a pool opened with the collaborator's own role: the catalog only ever
 * shows what that role can see.
 */
export const LIST_TABLES_SQL = `
  SELECT n.nspname AS schema,
         c.relname AS name,
         CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view'
                        WHEN 'm' THEN 'materialized view' WHEN 'p' THEN 'partitioned table'
                        WHEN 'f' THEN 'foreign table' END AS kind,
         c.relrowsecurity AS rls_enabled,
         -- Planner estimate; -1 means the relation was never analyzed, so: unknown.
         CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows,
         obj_description(c.oid) AS comment
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = ANY (ARRAY['r','v','m','p','f'])
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  ORDER BY 1, 2`;

export const DESCRIBE_SQL = `
  SELECT a.attname AS column,
         format_type(a.atttypid, a.atttypmod) AS type,
         NOT a.attnotnull AS nullable,
         pg_get_expr(d.adbin, d.adrelid) AS default,
         a.attnum AS position
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attnum`;

/** Policies of ONE relation, in the shape `describe_table` has always returned. */
export const TABLE_POLICIES_SQL = `
  SELECT policyname AS name, cmd, roles, qual AS using_expression, with_check
  FROM pg_policies WHERE schemaname || '.' || tablename = $1 OR tablename = $1`;

/**
 * Schemas that belong to the platform, not to the collaborator: `auth` and
 * `buildloop` are owned by the admin role and are not theirs to edit, so the
 * Studio never lists them next to their own objects.
 */
export const HIDDEN_SCHEMAS = "('pg_catalog', 'information_schema', 'pg_toast', 'auth', 'buildloop')";

/**
 * Functions the collaborator owns. `provolatile` and `prokind` are `"char"`
 * columns: compared without a cast Postgres answers `operator is not unique`,
 * so every one of them is cast to `text` first. `prosecdef` is a boolean and
 * needs no cast.
 */
export const FUNCTIONS_SQL = `
  SELECT p.oid::bigint AS oid,
         n.nspname AS schema,
         p.proname AS name,
         pg_get_function_arguments(p.oid) AS args,
         pg_get_function_result(p.oid) AS returns,
         l.lanname AS language,
         CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END AS security,
         CASE p.provolatile::text WHEN 'i' THEN 'immutable'
                                  WHEN 's' THEN 'stable' ELSE 'volatile' END AS volatility
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname NOT IN ${HIDDEN_SCHEMAS}
    AND p.prokind::text = 'f'
  ORDER BY 2, 3`;

/** The whole source of one function, as Postgres re-prints it — never as it was sent. */
export const FUNCTION_DEF_SQL = `SELECT pg_get_functiondef($1::oid) AS definition`;

/** RLS is three states, not a boolean: off, on, and forced (which binds the owner too). */
export const RLS_STATE_SQL = `
  SELECT n.nspname AS schema,
         c.relname AS name,
         c.relrowsecurity AS rls_enabled,
         c.relforcerowsecurity AS rls_forced,
         (SELECT count(*)::int FROM pg_policy pol WHERE pol.polrelid = c.oid) AS policy_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind::text = ANY (ARRAY['r', 'p'])
    AND n.nspname NOT IN ${HIDDEN_SCHEMAS}
  ORDER BY 1, 2`;

/**
 * Every policy of the database, normalized. Read from the `pg_policies` view,
 * which already resolves `polcmd` (`"char"`) to a command name and the policy
 * expressions to text, so nothing here compares a `"char"` column.
 */
export const POLICIES_SQL = `
  SELECT policyname AS name,
         schemaname || '.' || tablename AS "table",
         cmd AS command,
         roles::text[] AS roles,
         qual AS "using",
         with_check,
         permissive = 'PERMISSIVE' AS permissive
  FROM pg_policies
  WHERE schemaname NOT IN ${HIDDEN_SCHEMAS}
  ORDER BY 2, 1`;

/** `FUNCTIONS_SQL` rows as the API and the tools hand them out. */
export function rowsToFunctions(rows) {
  return rows.map((row) => ({
    oid: Number(row.oid),
    schema: row.schema,
    name: row.name,
    args: row.args ?? "",
    returns: row.returns,
    language: row.language,
    security: row.security,
    volatility: row.volatility,
  }));
}

function toPolicy(row) {
  return {
    name: row.name,
    command: row.command,
    roles: row.roles ?? [],
    using: row.using ?? null,
    withCheck: row.with_check ?? null,
    permissive: row.permissive,
  };
}

/**
 * One entry per relation, with its policies attached. A table with RLS on and
 * no policy keeps an empty list: that combination is exactly the one the Studio
 * has to warn about ("no row is visible"), so it must not be missing from here.
 */
export function rowsToRlsState(rows, policyRows = []) {
  const byTable = new Map();
  for (const row of policyRows) {
    const list = byTable.get(row.table) ?? [];
    list.push(toPolicy(row));
    byTable.set(row.table, list);
  }
  return rows.map((row) => ({
    table: { schema: row.schema, name: row.name },
    rls: row.rls_forced ? "forced" : row.rls_enabled ? "on" : "off",
    policies: byTable.get(`${row.schema}.${row.name}`) ?? [],
  }));
}
