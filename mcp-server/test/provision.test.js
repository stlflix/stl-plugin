import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COLLABORATOR_GROUP,
  SHARED_DATABASES,
  commonPlan,
  databaseNameFor,
  executionRolesFor,
  generatePassword,
  provisionPlan,
} from "../src/provision.js";

const password = "f".repeat(48);
const fnPassword = "a".repeat(48);
const sqlOf = (plan) => plan.map((s) => s.sql);

test("a fresh collaborator gets role, database, and no reach into shared databases", () => {
  const plan = provisionPlan({ slug: "alice", password, fnPassword, roleExists: false, dbExists: false });
  const sql = plan.map((s) => s.sql);
  assert.ok(sql.some((s) => s.startsWith("CREATE ROLE alice WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS")));
  assert.ok(sql.includes(`GRANT ${COLLABORATOR_GROUP} TO alice`));
  assert.ok(sql.includes("CREATE DATABASE db_alice OWNER alice"));
  assert.ok(sql.includes("REVOKE ALL ON DATABASE db_alice FROM PUBLIC"));
  for (const shared of SHARED_DATABASES) {
    const step = plan.find((s) => s.sql === `REVOKE CONNECT ON DATABASE ${shared} FROM alice`);
    assert.ok(step, shared);
    assert.equal(step.ifDatabaseExists, shared);
  }
  const tenantSteps = plan.filter((s) => s.db === "db_alice").map((s) => s.sql);
  assert.deepEqual(tenantSteps.slice(0, 4), [
    "ALTER SCHEMA public OWNER TO alice",
    "REVOKE ALL ON SCHEMA public FROM PUBLIC",
    "GRANT ALL ON SCHEMA public TO alice",
    "GRANT USAGE ON SCHEMA public TO alice_anon, alice_authenticated, alice_fn",
  ]);
});

test("re-provisioning rotates the password and keeps the database", () => {
  const plan = provisionPlan({ slug: "alice", password, fnPassword, roleExists: true, dbExists: true });
  const sql = plan.map((s) => s.sql);
  assert.ok(sql.some((s) => s.startsWith("ALTER ROLE alice WITH LOGIN")));
  assert.ok(!sql.some((s) => s.startsWith("CREATE ROLE")));
  assert.ok(!sql.some((s) => s.startsWith("CREATE DATABASE")));
});

test("the plan refuses a slug or password it cannot interpolate safely", () => {
  assert.throws(() => provisionPlan({ slug: "Alice; DROP", password, fnPassword, roleExists: false, dbExists: false }), /invalid slug/);
  assert.throws(() => provisionPlan({ slug: "alice", password: "x'", fnPassword, roleExists: false, dbExists: false }), /48 hex/);
  assert.match(generatePassword(), /^[0-9a-f]{48}$/);
  assert.equal(databaseNameFor("alice"), "db_alice");
});

test("the three execution roles are created before anything is granted to them", () => {
  const sql = sqlOf(commonPlan({ slug: "alice", fnPassword }));
  assert.deepEqual(executionRolesFor("alice"), { anon: "alice_anon", authenticated: "alice_authenticated", fn: "alice_fn" });
  assert.deepEqual(sql.slice(0, 4), [
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alice_anon') THEN CREATE ROLE alice_anon NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END $$",
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alice_authenticated') THEN CREATE ROLE alice_authenticated NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END $$",
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alice_fn') THEN CREATE ROLE alice_fn LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END $$",
    `ALTER ROLE alice_fn WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${fnPassword}'`,
  ]);
  const firstGrant = sql.findIndex((s) => s.startsWith("GRANT"));
  const lastRole = sql.findIndex((s) => s.startsWith("ALTER ROLE"));
  assert.ok(lastRole < firstGrant, "roles come before grants");
});

test("_fn may assume the execution roles but inherits nothing, and the slug may hand privileges to them", () => {
  const sql = sqlOf(commonPlan({ slug: "alice", fnPassword }));
  assert.ok(sql.includes("GRANT alice_anon, alice_authenticated TO alice_fn WITH SET TRUE, INHERIT FALSE"));
  assert.ok(sql.includes("GRANT alice_anon, alice_authenticated TO alice WITH ADMIN TRUE"));
  assert.ok(sql.includes("GRANT CONNECT ON DATABASE db_alice TO alice_anon, alice_authenticated, alice_fn"));
  for (const shared of SHARED_DATABASES) {
    const step = commonPlan({ slug: "alice", fnPassword }).find(
      (s) => s.sql === `REVOKE CONNECT ON DATABASE ${shared} FROM alice_anon, alice_authenticated, alice_fn`,
    );
    assert.ok(step, shared);
    assert.equal(step.ifDatabaseExists, shared);
  }
});

test("the auth schema carries the identity the platform signs, and the slug cannot extend it", () => {
  const sql = sqlOf(commonPlan({ slug: "alice", fnPassword }));
  const at = (needle) => sql.findIndex((s) => s.includes(needle));
  assert.ok(sql.includes("CREATE SCHEMA IF NOT EXISTS auth"));
  assert.ok(at("CREATE SCHEMA IF NOT EXISTS auth") < at("auth.users"), "schema before its tables");
  assert.ok(at("CREATE TABLE IF NOT EXISTS auth.users") < at("GRANT SELECT ON auth.users"), "table before its grants");
  assert.match(sql.find((s) => s.includes("auth.uid()")), /RETURNS integer .*request\.jwt\.claims.*->> 'sub'\)::integer/);
  assert.match(sql.find((s) => s.includes("auth.email()")), /RETURNS text .*->> 'email'/);
  assert.match(sql.find((s) => s.includes("auth.role()")), /SELECT current_user::text/);
  assert.ok(sql.includes("REVOKE CREATE ON SCHEMA auth FROM alice"));
  assert.ok(sql.includes("GRANT USAGE ON SCHEMA auth TO alice, alice_anon, alice_authenticated, alice_fn"));
  assert.ok(sql.includes("GRANT INSERT, UPDATE ON auth.users TO alice_authenticated"), "the runtime upserts the caller");
});

test("the buildloop schema is readable by the slug, writable to invocations by _fn, and its secrets by neither", () => {
  const sql = sqlOf(commonPlan({ slug: "alice", fnPassword }));
  const at = (needle) => sql.findIndex((s) => s.includes(needle));
  assert.ok(at("CREATE SCHEMA IF NOT EXISTS buildloop") < at("buildloop.edge_functions"), "schema before its tables");
  for (const table of ["edge_functions", "edge_function_versions", "edge_function_secrets", "invocations"]) {
    assert.ok(sql.some((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS buildloop.${table} `)), table);
  }
  assert.ok(sql.includes("GRANT SELECT ON buildloop.edge_functions, buildloop.edge_function_versions, buildloop.invocations TO alice"));
  assert.ok(sql.includes("GRANT INSERT ON buildloop.invocations TO alice_fn"));
  assert.ok(sql.includes("GRANT USAGE ON SEQUENCE buildloop.invocations_id_seq TO alice_fn"));
  assert.ok(sql.includes("REVOKE ALL ON buildloop.edge_function_secrets FROM alice, alice_anon, alice_authenticated, alice_fn"));
  assert.ok(!sql.some((s) => /GRANT[^;]*edge_function_secrets/.test(s)), "nobody but the admin role reads the secrets");
});

test("the upgrade of a migrated database creates no database and does not touch the collaborator's own role", () => {
  const sql = sqlOf(commonPlan({ slug: "alice", fnPassword }));
  assert.ok(!sql.some((s) => s.includes("CREATE DATABASE")));
  assert.ok(!sql.some((s) => /^(CREATE|ALTER) ROLE alice /.test(s)), "the slug's own password is not rotated");
  assert.ok(!sql.some((s) => s.includes("ALTER SCHEMA public OWNER")));
});

test("provisioning a fresh collaborator is the bootstrap followed by exactly the upgrade plan", () => {
  const full = sqlOf(provisionPlan({ slug: "alice", password, fnPassword, roleExists: false, dbExists: false }));
  const common = sqlOf(commonPlan({ slug: "alice", fnPassword }));
  assert.deepEqual(full.slice(-common.length), common, "one plan, applied twice over");
  assert.ok(full.indexOf("CREATE DATABASE db_alice OWNER alice") < full.indexOf(common[0]));
});

test("the shared plan refuses a slug or an fn password it cannot interpolate safely", () => {
  assert.throws(() => commonPlan({ slug: "Alice; DROP", fnPassword }), /invalid slug/);
  assert.throws(() => commonPlan({ slug: "alice", fnPassword: "x'" }), /48 hex/);
  assert.match(generatePassword(), /^[0-9a-f]{48}$/);
});
