import { randomBytes } from "node:crypto";
import pg from "pg";
import { isValidSlug } from "./auth.js";

/** Databases a collaborator has no business in. `PUBLIC` holds CONNECT on them by default. */
export const SHARED_DATABASES = ["postgres", "template1", "_supabase"];
export const COLLABORATOR_GROUP = "stl_collaborator";

export function databaseNameFor(slug) {
  return `db_${slug}`;
}

/**
 * The statements that turn a slug into an isolated tenant. Pure, so the plan is
 * testable without a database; `db: null` runs on the maintenance database,
 * anything else on that database.
 *
 * Runs as supabase_admin: in the Supabase image `postgres` is not a superuser
 * and cannot create a database owned by someone else ("must be able to SET ROLE").
 */
export function provisionPlan({ slug, password, roleExists, dbExists }) {
  if (!isValidSlug(slug)) throw new Error(`invalid slug: ${slug}`);
  if (!/^[0-9a-f]{48}$/.test(password)) throw new Error("password must be 48 hex chars");
  const db = databaseNameFor(slug);
  const attrs = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT";
  const plan = [];

  plan.push({
    db: null,
    sql: roleExists
      ? `ALTER ROLE ${slug} WITH ${attrs} PASSWORD '${password}'`
      : `CREATE ROLE ${slug} WITH ${attrs} PASSWORD '${password}'`,
  });
  plan.push({ db: null, sql: `GRANT ${COLLABORATOR_GROUP} TO ${slug}` });
  if (!dbExists) plan.push({ db: null, sql: `CREATE DATABASE ${db} OWNER ${slug}` });

  // Only the owner reaches this database, and the owner reaches only this one.
  plan.push({ db: null, sql: `REVOKE ALL ON DATABASE ${db} FROM PUBLIC` });
  plan.push({ db: null, sql: `GRANT ALL ON DATABASE ${db} TO ${slug}` });
  for (const shared of SHARED_DATABASES) {
    plan.push({ db: null, sql: `REVOKE CONNECT ON DATABASE ${shared} FROM ${slug}`, ifDatabaseExists: shared });
  }
  plan.push({ db, sql: `ALTER SCHEMA public OWNER TO ${slug}` });
  plan.push({ db, sql: `REVOKE ALL ON SCHEMA public FROM PUBLIC` });
  plan.push({ db, sql: `GRANT ALL ON SCHEMA public TO ${slug}` });
  return plan;
}

export function generatePassword() {
  return randomBytes(24).toString("hex"); // hex only: safe inside a connection URI
}

async function databaseExists(adminPool, name) {
  const { rowCount } = await adminPool.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  return rowCount > 0;
}

async function roleExists(adminPool, name) {
  const { rowCount } = await adminPool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
  return rowCount > 0;
}

/** Runs the plan. Statements on the tenant database use a short-lived client. */
export async function executePlan(adminPool, adminConnection, plan) {
  for (const step of plan) {
    if (step.ifDatabaseExists && !(await databaseExists(adminPool, step.ifDatabaseExists))) continue;
    if (step.db === null) {
      await adminPool.query(step.sql);
      continue;
    }
    const client = new pg.Client({ ...adminConnection, database: step.db });
    await client.connect();
    try {
      await client.query(step.sql);
    } finally {
      await client.end();
    }
  }
}

export async function provisionCollaborator(adminPool, adminConnection, slug) {
  const password = generatePassword();
  const plan = provisionPlan({
    slug,
    password,
    roleExists: await roleExists(adminPool, slug),
    dbExists: await databaseExists(adminPool, databaseNameFor(slug)),
  });
  await executePlan(adminPool, adminConnection, plan);
  return { password, dbName: databaseNameFor(slug), created: !plan.some((s) => s.sql.startsWith("ALTER ROLE")) };
}

/**
 * Closes the default PUBLIC CONNECT on every shared database: every service
 * role that logs in today keeps its access explicitly, collaborators get none.
 * Idempotent; runs at boot.
 */
export async function hardenSharedDatabases(adminPool) {
  await adminPool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${COLLABORATOR_GROUP}') THEN
      CREATE ROLE ${COLLABORATOR_GROUP} NOLOGIN;
    END IF;
  END $$`);
  const { rows } = await adminPool.query(
    `SELECT rolname FROM pg_roles
     WHERE rolcanlogin AND NOT pg_has_role(rolname, $1, 'MEMBER') AND rolname <> $1`,
    [COLLABORATOR_GROUP],
  );
  for (const shared of SHARED_DATABASES) {
    if (!(await databaseExists(adminPool, shared))) continue;
    for (const { rolname } of rows) {
      await adminPool.query(`GRANT CONNECT ON DATABASE ${shared} TO "${rolname}"`);
    }
    await adminPool.query(`REVOKE CONNECT ON DATABASE ${shared} FROM PUBLIC`);
  }
}
