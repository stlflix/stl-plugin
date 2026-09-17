import { randomBytes } from "node:crypto";
import pg from "pg";
import { isValidSlug } from "./auth.js";

/** Databases a collaborator has no business in. `PUBLIC` holds CONNECT on them by default. */
export const SHARED_DATABASES = ["postgres", "template1", "_supabase"];
export const COLLABORATOR_GROUP = "stl_collaborator";

/** Nothing any of the collaborator's roles may ever be. */
const SAFE_ROLE_ATTRS = "NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS";

export function databaseNameFor(slug) {
  return `db_${slug}`;
}

/**
 * The three roles a function runs as. `_fn` is the only one that can log in and
 * it owns nothing: it reaches a table only after `SET ROLE`, which is why RLS
 * applies to it (the owner would bypass it). `NOINHERIT` is what makes the
 * `SET ROLE` mandatory instead of automatic.
 */
export function executionRolesFor(slug) {
  return { anon: `${slug}_anon`, authenticated: `${slug}_authenticated`, fn: `${slug}_fn` };
}

/** Idempotent role creation as one statement, so the plan stays a list of strings. */
function ensureRole(name, attrs) {
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN CREATE ROLE ${name} ${attrs}; END IF; END $$`;
}

/**
 * The two statements AD-010 requires, in the order that makes them safe: the
 * revoke first, or the grant it runs after would wipe out the column grant.
 * Shared by `commonPlan` and `grant-secret-keys.mjs`, the one-off script for
 * databases provisioned before this decision (docs/decisions/010-…md).
 */
export function secretKeyGrantPlan({ db, slug, everyone }) {
  return [
    { db, sql: `REVOKE ALL ON buildloop.edge_function_secrets FROM ${everyone}` },
    { db, sql: `GRANT SELECT (name, key) ON buildloop.edge_function_secrets TO ${slug}` },
  ];
}

/**
 * Everything a database needs on top of "a role and a database": the execution
 * roles, the `auth` schema the platform's identity lands in, and the `buildloop`
 * schema that holds the collaborator's Edge Functions. Idempotent, so it is also
 * the whole of `upgradeCollaborator` for a database that was migrated in.
 *
 * `GRANT … WITH SET TRUE, INHERIT FALSE` and `WITH ADMIN TRUE` are PostgreSQL 16
 * spellings (verified against the PG16 GRANT synopsis): `_fn` may assume the two
 * execution roles but inherits nothing from them, and the collaborator may hand
 * privileges to them without being able to become them by accident.
 */
export function commonPlan({ slug, fnPassword }) {
  if (!isValidSlug(slug)) throw new Error(`invalid slug: ${slug}`);
  if (!/^[0-9a-f]{48}$/.test(fnPassword)) throw new Error("fnPassword must be 48 hex chars");
  const db = databaseNameFor(slug);
  const { anon, authenticated, fn } = executionRolesFor(slug);
  const execRoles = `${anon}, ${authenticated}, ${fn}`;
  const everyone = `${slug}, ${anon}, ${authenticated}, ${fn}`;
  const plan = [];

  // Roles first: nothing can be granted to a role that does not exist yet.
  plan.push({ db: null, sql: ensureRole(anon, `NOLOGIN NOINHERIT ${SAFE_ROLE_ATTRS}`) });
  plan.push({ db: null, sql: ensureRole(authenticated, `NOLOGIN NOINHERIT ${SAFE_ROLE_ATTRS}`) });
  plan.push({ db: null, sql: ensureRole(fn, `LOGIN NOINHERIT ${SAFE_ROLE_ATTRS}`) });
  plan.push({ db: null, sql: `ALTER ROLE ${fn} WITH LOGIN NOINHERIT ${SAFE_ROLE_ATTRS} PASSWORD '${fnPassword}'` });
  plan.push({ db: null, sql: `GRANT ${anon}, ${authenticated} TO ${fn} WITH SET TRUE, INHERIT FALSE` });
  plan.push({ db: null, sql: `GRANT ${anon}, ${authenticated} TO ${slug} WITH ADMIN TRUE` });
  plan.push({ db: null, sql: `GRANT CONNECT ON DATABASE ${db} TO ${execRoles}` });
  for (const shared of SHARED_DATABASES) {
    plan.push({ db: null, sql: `REVOKE CONNECT ON DATABASE ${shared} FROM ${execRoles}`, ifDatabaseExists: shared });
  }
  plan.push({ db, sql: `GRANT USAGE ON SCHEMA public TO ${execRoles}` });

  // `auth`: owned by the admin role that runs this plan, so the collaborator can
  // read who logged in but cannot rewrite identity.
  plan.push({ db, sql: `CREATE SCHEMA IF NOT EXISTS auth` });
  plan.push({
    db,
    sql: `CREATE TABLE IF NOT EXISTS auth.users (id integer PRIMARY KEY, email text, name text, is_super boolean NOT NULL DEFAULT false, first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now())`,
  });
  plan.push({
    db,
    sql: `CREATE OR REPLACE FUNCTION auth.uid() RETURNS integer LANGUAGE sql STABLE AS $fn$ SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::integer $fn$`,
  });
  plan.push({
    db,
    sql: `CREATE OR REPLACE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $fn$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email' $fn$`,
  });
  plan.push({
    db,
    sql: `CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $fn$ SELECT current_user::text $fn$`,
  });
  plan.push({ db, sql: `REVOKE ALL ON SCHEMA auth FROM PUBLIC` });
  plan.push({ db, sql: `GRANT USAGE ON SCHEMA auth TO ${everyone}` });
  plan.push({ db, sql: `REVOKE CREATE ON SCHEMA auth FROM ${slug}` });
  plan.push({ db, sql: `GRANT SELECT ON auth.users TO ${everyone}` });
  // The runtime upserts the caller once per invocation, as `<slug>_authenticated`.
  plan.push({ db, sql: `GRANT INSERT, UPDATE ON auth.users TO ${authenticated}` });
  plan.push({ db, sql: `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO ${everyone}` });

  // `buildloop`: the project's own metadata. Secrets are the one table nobody
  // but the admin role can read — not the collaborator, not their functions.
  plan.push({ db, sql: `CREATE SCHEMA IF NOT EXISTS buildloop` });
  plan.push({
    db,
    sql: `CREATE TABLE IF NOT EXISTS buildloop.edge_functions (name text PRIMARY KEY, current_version integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
  });
  plan.push({
    db,
    sql: `CREATE TABLE IF NOT EXISTS buildloop.edge_function_versions (name text NOT NULL, version integer NOT NULL, source text NOT NULL, bundle text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (name, version))`,
  });
  plan.push({
    db,
    sql: `CREATE TABLE IF NOT EXISTS buildloop.edge_function_secrets (name text NOT NULL, key text NOT NULL, value_enc text NOT NULL, PRIMARY KEY (name, key))`,
  });
  plan.push({
    db,
    sql: `CREATE TABLE IF NOT EXISTS buildloop.invocations (id bigserial PRIMARY KEY, name text NOT NULL, version integer, at timestamptz NOT NULL DEFAULT now(), status integer, duration_ms integer, log jsonb, error text)`,
  });
  plan.push({ db, sql: `REVOKE ALL ON SCHEMA buildloop FROM PUBLIC` });
  plan.push({ db, sql: `GRANT USAGE ON SCHEMA buildloop TO ${slug}, ${fn}` });
  plan.push({
    db,
    sql: `GRANT SELECT ON buildloop.edge_functions, buildloop.edge_function_versions, buildloop.invocations TO ${slug}`,
  });
  // The runtime writes the log AND trims it (BL-24: the last 200 of a function,
  // nothing older than a day), and it does both as `_fn`, the only identity it
  // holds. Trimming reads the ids it keeps, so SELECT comes with DELETE.
  plan.push({ db, sql: `GRANT SELECT, INSERT, DELETE ON buildloop.invocations TO ${fn}` });
  plan.push({ db, sql: `GRANT USAGE ON SEQUENCE buildloop.invocations_id_seq TO ${fn}` });
  // `edge.list` runs as the slug (AD-009) and needs the key set, never the
  // value: a column grant, not a table grant, so `value_enc` stays admin-only (AD-010).
  plan.push(...secretKeyGrantPlan({ db, slug, everyone }));
  return plan;
}

/**
 * The statements that turn a slug into an isolated tenant. Pure, so the plan is
 * testable without a database; `db: null` runs on the maintenance database,
 * anything else on that database.
 *
 * Runs as supabase_admin: in the Supabase image `postgres` is not a superuser
 * and cannot create a database owned by someone else ("must be able to SET ROLE").
 */
export function provisionPlan({ slug, password, fnPassword, roleExists, dbExists }) {
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
  return [...plan, ...commonPlan({ slug, fnPassword })];
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
  const fnPassword = generatePassword();
  const existed = await roleExists(adminPool, slug);
  const plan = provisionPlan({
    slug,
    password,
    fnPassword,
    roleExists: existed,
    dbExists: await databaseExists(adminPool, databaseNameFor(slug)),
  });
  await executePlan(adminPool, adminConnection, plan);
  return { password, fnPassword, dbName: databaseNameFor(slug), created: !existed };
}

/**
 * The same plan for a database that already exists — one migrated in from the
 * old stack, or one provisioned before the execution roles existed. It never
 * creates the database and never touches the collaborator's own role or
 * password: only what `commonPlan` adds is (re)applied.
 */
export async function upgradeCollaborator(adminPool, adminConnection, slug) {
  const fnPassword = generatePassword();
  await executePlan(adminPool, adminConnection, commonPlan({ slug, fnPassword }));
  return { fnPassword, dbName: databaseNameFor(slug) };
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
