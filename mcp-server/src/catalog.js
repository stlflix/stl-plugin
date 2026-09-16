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

/**
 * The fixed catalogue of security lints (BL-27). Fixed on purpose: eight rules
 * the collaborator can learn, not a moving score. Every `sql` reads the catalog
 * with the collaborator's own role, so a finding is always about something they
 * can see; `format('%I.%I', …)` lets Postgres quote the identifier, so the fix
 * SQL is safe for a table called `My Table` without a quoter of our own.
 */
const LINT_RELKINDS = "c.relkind::text = ANY (ARRAY['r', 'p'])";
const FUNCTION_SIGNATURE = "format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))";

export const LINTS = [
  {
    id: "rls_disabled",
    severity: "warn",
    explain:
      "A tabela não tem row level security: qualquer role com privilégio de SELECT lê todas as linhas.",
    sql: `
      SELECT format('%I.%I', n.nspname, c.relname) AS object,
             format('%I.%I', n.nspname, c.relname) AS relation
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${LINT_RELKINDS} AND NOT c.relrowsecurity AND n.nspname NOT IN ${HIDDEN_SCHEMAS}
      ORDER BY 1`,
    fix: (row) => `ALTER TABLE ${row.relation} ENABLE ROW LEVEL SECURITY`,
  },
  {
    id: "policy_always_true",
    severity: "warn",
    explain:
      "A policy usa USING (true) para uma role de execução: ela não filtra nada, só faz a tabela parecer protegida.",
    sql: `
      SELECT format('%I.%I', schemaname, tablename) || ' · ' || policyname AS object,
             format('%I.%I', schemaname, tablename) AS relation,
             policyname AS policy
      FROM pg_policies
      WHERE btrim(coalesce(qual, '')) = 'true'
        AND schemaname NOT IN ${HIDDEN_SCHEMAS}
        AND EXISTS (
          SELECT 1 FROM unnest(roles::text[]) AS r
          WHERE r = 'public' OR r LIKE '%\\_anon' OR r LIKE '%\\_authenticated')
      ORDER BY 1`,
    // No mechanical fix: only the author knows which rows should be visible.
    fix: () => null,
  },
  {
    id: "definer_without_search_path",
    severity: "error",
    explain:
      "A função é SECURITY DEFINER e não fixa search_path: quem a chama pode apontá-la para objetos próprios e executar código como o dono.",
    sql: `
      SELECT ${FUNCTION_SIGNATURE} AS object,
             ${FUNCTION_SIGNATURE} AS signature
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef
        AND p.prokind::text = 'f'
        AND n.nspname NOT IN ${HIDDEN_SCHEMAS}
        AND NOT EXISTS (
          SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS cfg
          WHERE cfg LIKE 'search_path=%')
      ORDER BY 1`,
    fix: (row) => `ALTER FUNCTION ${row.signature} SET search_path = ''`,
  },
  {
    id: "definer_executable_by_public",
    severity: "error",
    explain:
      "A função roda como o dono e PUBLIC pode executá-la: qualquer role do banco usa os privilégios do dono através dela.",
    sql: `
      SELECT ${FUNCTION_SIGNATURE} AS object,
             ${FUNCTION_SIGNATURE} AS signature
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef
        AND p.prokind::text = 'f'
        AND n.nspname NOT IN ${HIDDEN_SCHEMAS}
        AND has_function_privilege('public', p.oid, 'EXECUTE')
      ORDER BY 1`,
    fix: (row) => `REVOKE EXECUTE ON FUNCTION ${row.signature} FROM PUBLIC`,
  },
  {
    id: "extension_in_public",
    severity: "info",
    explain:
      "A extensão está instalada em public: os objetos dela ficam misturados com os seus e no search_path de todo mundo.",
    sql: `
      SELECT e.extname AS object, quote_ident(e.extname) AS extension
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE n.nspname = 'public'
      ORDER BY 1`,
    fix: (row) => `ALTER EXTENSION ${row.extension} SET SCHEMA extensions`,
  },
  {
    id: "rls_without_policies",
    severity: "info",
    explain:
      "A tabela tem RLS ligado e nenhuma policy: nenhuma linha é visível para as roles de execução.",
    sql: `
      SELECT format('%I.%I', n.nspname, c.relname) AS object,
             format('%I.%I', n.nspname, c.relname) AS relation
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${LINT_RELKINDS} AND c.relrowsecurity
        AND n.nspname NOT IN ${HIDDEN_SCHEMAS}
        AND NOT EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid = c.oid)
      ORDER BY 1`,
    // No mechanical fix: an empty policy set is a decision, not a typo.
    fix: () => null,
  },
  {
    id: "fk_without_index",
    severity: "info",
    explain:
      "A chave estrangeira não tem índice que comece pelas colunas dela: cada DELETE ou UPDATE no lado referenciado varre a tabela inteira.",
    sql: `
      SELECT format('%I.%I', n.nspname, c.relname) || ' (' || fk.columns || ')' AS object,
             format('%I.%I', n.nspname, c.relname) AS relation,
             fk.columns AS columns
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL (
        SELECT string_agg(format('%I', a.attname), ', ' ORDER BY k.ord) AS columns
        FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS fk
      WHERE con.contype::text = 'f'
        AND n.nspname NOT IN ${HIDDEN_SCHEMAS}
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = con.conrelid AND i.indkey[0] = con.conkey[1])
      ORDER BY 1`,
    fix: (row) => `CREATE INDEX ON ${row.relation} (${row.columns})`,
  },
  {
    id: "table_without_pk",
    severity: "info",
    explain:
      "A tabela não tem chave primária: a grade do Studio fica somente leitura e não há como endereçar uma linha com segurança.",
    sql: `
      SELECT format('%I.%I', n.nspname, c.relname) AS object,
             format('%I.%I', n.nspname, c.relname) AS relation
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${LINT_RELKINDS}
        AND n.nspname NOT IN ${HIDDEN_SCHEMAS}
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint con WHERE con.conrelid = c.oid AND con.contype::text = 'p')
      ORDER BY 1`,
    // No mechanical fix: which column is the key is the author's call.
    fix: () => null,
  },
];

/** Worst first, so the badge on the tab and the first line of the list agree. */
export const LINT_SEVERITY_ORDER = ["error", "warn", "info"];

/**
 * Runs the eight lints on one connection (the collaborator's own role) and
 * returns the findings ordered by severity. A lint with no rows simply
 * contributes nothing — an empty result is the good outcome.
 */
export async function runLints(client) {
  const findings = [];
  for (const lint of LINTS) {
    const { rows } = await client.query(lint.sql);
    for (const row of rows) {
      findings.push({
        id: lint.id,
        severity: lint.severity,
        object: row.object,
        explain: lint.explain,
        fixSql: lint.fix(row),
      });
    }
  }
  return findings.sort(
    (a, b) => LINT_SEVERITY_ORDER.indexOf(a.severity) - LINT_SEVERITY_ORDER.indexOf(b.severity),
  );
}
