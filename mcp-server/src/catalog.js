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

export const POLICIES_SQL = `
  SELECT policyname AS name, cmd, roles, qual AS using_expression, with_check
  FROM pg_policies WHERE schemaname || '.' || tablename = $1 OR tablename = $1`;
