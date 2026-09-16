import assert from "node:assert/strict";
import { test } from "node:test";
import { PoolRegistry } from "../src/db.js";

/**
 * `PoolRegistry` opens two kinds of pool on the SAME database, and the point of
 * the class is that they are never confused: one carries the collaborator's own
 * role, the other the admin role (AD-009). `pg.Pool` does not connect until a
 * query asks it to, so the credentials it was built with can be read off it
 * without a database anywhere.
 */
const store = {
  get: async (slug) => (slug === "alice" ? { slug, db_name: "db_alice", role_name: "alice" } : null),
  connectionFor: async (slug) =>
    slug === "alice" ? { database: "db_alice", user: "alice", password: "owner-password" } : null,
};

const adminConnection = { host: "db", port: 5432, user: "buildloop_admin", password: "admin-password" };

function registry() {
  return new PoolRegistry({ store, host: "db", port: 5432, statementTimeoutMs: 30_000, adminConnection });
}

test("forSlug opens the collaborator's database with the collaborator's own role", async () => {
  const pools = registry();
  const pool = await pools.forSlug("alice");
  assert.equal(pool.options.database, "db_alice");
  assert.equal(pool.options.user, "alice");
  assert.equal(pool.options.password, "owner-password");
  await pools.closeAll();
});

test("adminForSlug opens the SAME database with the admin role, never the collaborator's", async () => {
  const pools = registry();
  const pool = await pools.adminForSlug("alice");
  assert.equal(pool.options.database, "db_alice", "still one database per slug");
  assert.equal(pool.options.user, "buildloop_admin");
  assert.equal(pool.options.password, "admin-password");
  assert.notEqual(pool.options.password, "owner-password");
  await pools.closeAll();
});

test("the two pools of a slug are distinct objects, each cached on its own", async () => {
  const pools = registry();
  const own = await pools.forSlug("alice");
  const admin = await pools.adminForSlug("alice");
  assert.notEqual(own, admin);
  assert.equal(await pools.forSlug("alice"), own);
  assert.equal(await pools.adminForSlug("alice"), admin);
  await pools.closeAll();
});

test("adminForSlug refuses a slug that is not provisioned, like forSlug", async () => {
  const pools = registry();
  await assert.rejects(() => pools.adminForSlug("bob"), /collaborator 'bob' is not provisioned/);
  await assert.rejects(() => pools.forSlug("bob"), /collaborator 'bob' is not provisioned/);
  await pools.closeAll();
});

test("a registry built without an admin connection refuses to open an admin pool", async () => {
  const pools = new PoolRegistry({ store, host: "db", port: 5432, statementTimeoutMs: 30_000 });
  await assert.rejects(() => pools.adminForSlug("alice"), /no admin connection/);
  await pools.closeAll();
});

test("drop forgets both pools of the slug, so a re-provision cannot be served a stale one", async () => {
  const pools = registry();
  const own = await pools.forSlug("alice");
  const admin = await pools.adminForSlug("alice");
  await pools.drop("alice");
  assert.notEqual(await pools.forSlug("alice"), own);
  assert.notEqual(await pools.adminForSlug("alice"), admin);
  await pools.closeAll();
});
