import assert from "node:assert/strict";
import { test } from "node:test";
import { COLLABORATOR_GROUP, SHARED_DATABASES, databaseNameFor, generatePassword, provisionPlan } from "../src/provision.js";

const password = "f".repeat(48);

test("a fresh collaborator gets role, database, and no reach into shared databases", () => {
  const plan = provisionPlan({ slug: "alice", password, roleExists: false, dbExists: false });
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
  assert.deepEqual(tenantSteps, [
    "ALTER SCHEMA public OWNER TO alice",
    "REVOKE ALL ON SCHEMA public FROM PUBLIC",
    "GRANT ALL ON SCHEMA public TO alice",
  ]);
});

test("re-provisioning rotates the password and keeps the database", () => {
  const plan = provisionPlan({ slug: "alice", password, roleExists: true, dbExists: true });
  const sql = plan.map((s) => s.sql);
  assert.ok(sql.some((s) => s.startsWith("ALTER ROLE alice WITH LOGIN")));
  assert.ok(!sql.some((s) => s.startsWith("CREATE ROLE")));
  assert.ok(!sql.some((s) => s.startsWith("CREATE DATABASE")));
});

test("the plan refuses a slug or password it cannot interpolate safely", () => {
  assert.throws(() => provisionPlan({ slug: "Alice; DROP", password, roleExists: false, dbExists: false }), /invalid slug/);
  assert.throws(() => provisionPlan({ slug: "alice", password: "x'", roleExists: false, dbExists: false }), /48 hex/);
  assert.match(generatePassword(), /^[0-9a-f]{48}$/);
  assert.equal(databaseNameFor("alice"), "db_alice");
});
