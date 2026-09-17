#!/usr/bin/env node
/**
 * One-off backfill for AD-010: databases provisioned before the decision never
 * got the column grant that lets `edge.list` (running as the slug, AD-009)
 * read `buildloop.edge_function_secrets`. Re-provisioning would fix it too,
 * but it rotates the slug's password under a pool that may be live — so this
 * runs the same two statements directly against each already-provisioned
 * database instead. See docs/decisions/010-o-slug-le-a-chave-do-secret-nunca-o-valor.md.
 *
 * Lives here, not in `ops/`, for two reasons: `pg` resolves only inside this
 * package (the repo root has no package.json), and `src` + `scripts` are what
 * the image carries — so the runbook is one line against the live container,
 * which already holds ADMIN_DB_URL:
 *
 *   docker exec buildloop-mcp node scripts/grant-secret-keys.mjs
 *
 * Idempotent: REVOKE and column GRANT both tolerate being applied again.
 * Exit 0: every slug succeeded. Exit 1: at least one failed, named below.
 */
import pg from "pg";
import { executionRolesFor, secretKeyGrantPlan } from "../src/provision.js";

function adminConnectionFrom(adminDbUrl) {
  const url = new URL(adminDbUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

/**
 * The registry is the authority on where a collaborator lives: a database
 * migrated from the old stack carries its own `db_name`, so recomputing it
 * from the slug would silently miss it.
 */
async function collaboratorsFrom(adminPool) {
  const { rows } = await adminPool.query(
    "SELECT slug, db_name, role_name FROM stl_mcp.collaborators ORDER BY slug",
  );
  return rows;
}

async function grantFor(adminConnection, { slug, db_name: dbName, role_name: roleName }) {
  const { anon, authenticated, fn } = executionRolesFor(slug);
  const plan = secretKeyGrantPlan({
    db: dbName,
    slug: roleName,
    everyone: `${roleName}, ${anon}, ${authenticated}, ${fn}`,
  });
  const client = new pg.Client({ ...adminConnection, database: dbName });
  await client.connect();
  try {
    for (const step of plan) await client.query(step.sql);
  } finally {
    await client.end();
  }
}

export async function run({ adminDbUrl, out = console.log }) {
  if (!adminDbUrl) throw new Error("ADMIN_DB_URL is not set");
  const adminConnection = adminConnectionFrom(adminDbUrl);
  const adminPool = new pg.Pool({ connectionString: adminDbUrl, max: 3 });
  let failures = 0;
  try {
    for (const collaborator of await collaboratorsFrom(adminPool)) {
      try {
        await grantFor(adminConnection, collaborator);
        out(`OK    ${collaborator.slug}`);
      } catch (err) {
        failures += 1;
        out(`FAIL  ${collaborator.slug}: ${err.message}`);
      }
    }
  } finally {
    await adminPool.end();
  }
  return failures === 0 ? 0 : 1;
}

async function main() {
  return run({ adminDbUrl: process.env.ADMIN_DB_URL });
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
