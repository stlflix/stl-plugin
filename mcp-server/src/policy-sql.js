/**
 * The SQL for RLS and policies, written here and nowhere else: the MCP tools
 * and the Studio's `exec` route send the very same statement, so what the
 * collaborator is shown is what runs. Pure — it never touches a database.
 *
 * The client names objects, this module writes the SQL (ACC-06). Identifiers are
 * quoted so a table called `My Table` survives; the `USING` and `WITH CHECK`
 * expressions are the collaborator's own SQL and go to Postgres as written —
 * their parser is the one that judges them.
 */
export const OBJECT_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export const RLS_MODES = {
  enable: "ENABLE ROW LEVEL SECURITY",
  disable: "DISABLE ROW LEVEL SECURITY",
  force: "FORCE ROW LEVEL SECURITY",
  noforce: "NO FORCE ROW LEVEL SECURITY",
};

export const POLICY_COMMANDS = ["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"];

export class InvalidObjectName extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidObjectName";
  }
}

/** An identifier is always exactly what was named: embedded quotes are doubled. */
export function quoteIdent(name) {
  if (typeof name !== "string" || name === "") {
    throw new InvalidObjectName("identifier must be a non-empty string");
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** The names a tool accepts at all — checked before the database is touched (BL-26). */
export function assertObjectName(kind, name) {
  if (typeof name !== "string" || !OBJECT_NAME_PATTERN.test(name)) {
    throw new InvalidObjectName(`${kind} must match ${OBJECT_NAME_PATTERN.source}`);
  }
  return name;
}

export function qualifiedName({ schema = "public", table }) {
  assertObjectName("schema", schema);
  assertObjectName("table", table);
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

export function setRlsSql({ schema, table, mode }) {
  const clause = RLS_MODES[mode];
  if (!clause) throw new InvalidObjectName(`mode must be one of ${Object.keys(RLS_MODES).join(", ")}`);
  return `ALTER TABLE ${qualifiedName({ schema, table })} ${clause}`;
}

function expression(kind, value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidObjectName(`${kind} must be a non-empty SQL expression`);
  }
  return value.trim();
}

export function createPolicySql({ schema, table, name, command = "ALL", roles, using, withCheck, permissive = true }) {
  const relation = qualifiedName({ schema, table });
  assertObjectName("policy name", name);
  const cmd = typeof command === "string" ? command.toUpperCase() : command;
  if (!POLICY_COMMANDS.includes(cmd)) {
    throw new InvalidObjectName(`command must be one of ${POLICY_COMMANDS.join(", ")}`);
  }
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new InvalidObjectName("roles must be a non-empty array");
  }
  const to = roles.map((role) => quoteIdent(assertObjectName("role", role))).join(", ");
  const parts = [
    `CREATE POLICY ${quoteIdent(name)} ON ${relation}`,
    `AS ${permissive ? "PERMISSIVE" : "RESTRICTIVE"}`,
    `FOR ${cmd}`,
    `TO ${to}`,
  ];
  const usingExpr = expression("using", using);
  if (usingExpr) parts.push(`USING (${usingExpr})`);
  const checkExpr = expression("withCheck", withCheck);
  if (checkExpr) parts.push(`WITH CHECK (${checkExpr})`);
  return parts.join(" ");
}

export function dropPolicySql({ schema, table, name }) {
  const relation = qualifiedName({ schema, table });
  return `DROP POLICY ${quoteIdent(assertObjectName("policy name", name))} ON ${relation}`;
}
