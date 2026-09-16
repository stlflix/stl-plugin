import { randomBytes } from "node:crypto";
import express from "express";
import { hashToken, isValidSlug, secretEquals } from "./auth.js";
import {
  DESCRIBE_SQL,
  FUNCTIONS_SQL,
  FUNCTION_DEF_SQL,
  LIST_TABLES_SQL,
  POLICIES_SQL,
  RLS_STATE_SQL,
  rowsToFunctions,
  rowsToRlsState,
  runLints,
} from "./catalog.js";
import * as edge from "./edge.js";
import { ExecConflict, InvalidExecInput, SqlRejected, runExec } from "./mutations.js";
import * as origins from "./origins.js";
import { provisionCollaborator, upgradeCollaborator } from "./provision.js";
import { InvalidQueryInput, isPostgresError, parseQueryInput, runReadOnly } from "./readonly.js";
import * as tickets from "./tickets.js";

/**
 * Admin surface, for the platform (plataforma-product-ops) and for Lucas's shell.
 * Authenticated by a shared secret in `X-Admin-Key`; never reachable through
 * Traefik — the public router only forwards `/mcp`.
 */
export function adminRouter({
  adminKey,
  adminPool,
  adminConnection,
  credentialsKey,
  store,
  pools,
  // The two calls that need the admin role are injected so a test can prove
  // which routes reach for it — and which never do.
  provision = { provisionCollaborator, upgradeCollaborator },
}) {
  const router = express.Router();

  /** Every data route answers 404 before a pool is opened, never after. */
  async function poolFor(req, res) {
    if (!(await store.get(req.params.slug))) {
      res.status(404).json({ error: "not provisioned" });
      return null;
    }
    return pools.forSlug(req.params.slug);
  }

  router.use((req, res, next) => {
    if (!secretEquals(req.get("x-admin-key"), adminKey)) {
      return res.status(401).json({ error: "invalid admin key" });
    }
    next();
  });

  router.param("slug", (req, res, next, slug) => {
    if (!isValidSlug(slug)) return res.status(400).json({ error: "slug must match ^[a-z][a-z0-9_]{1,30}$" });
    next();
  });

  router.get("/collaborators/:slug", async (req, res) => {
    const row = await store.get(req.params.slug);
    if (!row) return res.status(404).json({ error: "not provisioned" });
    res.json(present(row));
  });

  // Idempotent: a second call re-issues the role password and keeps the database.
  router.put("/collaborators/:slug", async (req, res) => {
    const { slug } = req.params;
    const email = typeof req.body?.email === "string" ? req.body.email : null;
    const { password, fnPassword, dbName, created } = await provision.provisionCollaborator(adminPool, adminConnection, slug);
    await store.upsert({ slug, email, dbName, password, fnPassword });
    await pools.drop(slug);
    res.status(created ? 201 : 200).json({ ...present(await store.get(slug)), created });
  });

  // One live token per collaborator; the previous one dies here. Shown once.
  router.post("/collaborators/:slug/token", async (req, res) => {
    const { slug } = req.params;
    if (!(await store.get(slug))) return res.status(404).json({ error: "not provisioned" });
    const token = `stl_${randomBytes(24).toString("hex")}`;
    await store.setTokenHash(slug, hashToken(token));
    res.json({ slug, token, issuedAt: new Date().toISOString() });
  });

  // Reads on the platform's behalf (AD-007). Both routes open the pool through
  // `pools.forSlug` — the collaborator's own role — and never touch `adminPool`:
  // whatever that role cannot see, the platform cannot show.
  router.post("/collaborators/:slug/tables", async (req, res) => {
    const { slug } = req.params;
    const table = req.body?.table;
    if (table !== undefined && (typeof table !== "string" || table.trim() === "")) {
      return res.status(400).json({ error: "table must be a non-empty string" });
    }
    if (!(await store.get(slug))) return res.status(404).json({ error: "not provisioned" });
    const pool = await pools.forSlug(slug);
    if (table === undefined) {
      const { rows } = await pool.query(LIST_TABLES_SQL);
      return res.json({ slug, tables: rows });
    }
    const { rows } = await pool.query(DESCRIBE_SQL, [table]);
    if (rows.length === 0) return res.status(404).json({ error: `no table named '${table}' in this database` });
    res.json({ slug, table, columns: rows });
  });

  router.post("/collaborators/:slug/query", async (req, res) => {
    const { slug } = req.params;
    let input;
    try {
      input = parseQueryInput(req.body);
    } catch (err) {
      if (err instanceof InvalidQueryInput) return res.status(400).json({ error: err.message });
      throw err;
    }
    if (!(await store.get(slug))) return res.status(404).json({ error: "not provisioned" });
    try {
      const result = await runReadOnly(await pools.forSlug(slug), input.sql, input.limit);
      res.json({ slug, ...result });
    } catch (err) {
      // The database's verdict — a write inside READ ONLY, a typo, the timeout —
      // goes back as text. Anything without a SQLSTATE is ours and stays a 500.
      if (!isPostgresError(err)) throw err;
      res.status(422).json({ error: err.message, code: err.code });
    }
  });

  // Writes on the platform's behalf (I7): with the collaborator's OWN role, in
  // one transaction, never with `adminPool`. What the database refuses, the
  // platform shows as text.
  router.post("/collaborators/:slug/exec", async (req, res) => {
    const { slug } = req.params;
    const pool = await poolFor(req, res);
    if (!pool) return;
    try {
      const results = await runExec(pool, req.body?.statements, { timeoutMs: req.body?.timeoutMs });
      res.json({ slug, results });
    } catch (err) {
      if (err instanceof InvalidExecInput) return res.status(400).json({ error: err.message });
      // Nothing was applied: the row moved under the client.
      if (err instanceof ExecConflict) {
        return res.status(409).json({ error: err.message, index: err.index, expected: err.expected, got: err.got });
      }
      if (err instanceof SqlRejected) return res.status(422).json({ error: err.message, code: err.code });
      throw err;
    }
  });

  // `{}` lists the functions, `{ oid }` asks Postgres to re-print one of them —
  // the definition always comes from the database, never from the text sent in.
  router.post("/collaborators/:slug/functions", async (req, res) => {
    const { slug } = req.params;
    const { oid } = req.body ?? {};
    if (oid !== undefined && (!Number.isInteger(oid) || oid <= 0)) {
      return res.status(400).json({ error: "oid must be a positive integer" });
    }
    const pool = await poolFor(req, res);
    if (!pool) return;
    if (oid === undefined) {
      const { rows } = await pool.query(FUNCTIONS_SQL);
      return res.json({ slug, functions: rowsToFunctions(rows) });
    }
    try {
      const { rows } = await pool.query(FUNCTION_DEF_SQL, [oid]);
      const definition = rows[0]?.definition ?? null;
      if (!definition) return res.status(404).json({ error: `no function with oid ${oid} in this database` });
      return res.json({ slug, oid, definition });
    } catch (err) {
      if (!isPostgresError(err)) throw err;
      return res.status(404).json({ error: `no function with oid ${oid} in this database` });
    }
  });

  router.post("/collaborators/:slug/policies", async (req, res) => {
    const { slug } = req.params;
    const pool = await poolFor(req, res);
    if (!pool) return;
    const state = await pool.query(RLS_STATE_SQL);
    const policies = await pool.query(POLICIES_SQL);
    res.json({ slug, tables: rowsToRlsState(state.rows, policies.rows) });
  });

  router.post("/collaborators/:slug/lint", async (req, res) => {
    const { slug } = req.params;
    const pool = await poolFor(req, res);
    if (!pool) return;
    res.json({ slug, checkedAt: new Date().toISOString(), findings: await runLints(pool) });
  });

  // The one data-plane route that needs the admin role: only it can create a
  // role or a schema owned by someone other than the collaborator.
  router.post("/collaborators/:slug/upgrade", async (req, res) => {
    const { slug } = req.params;
    if (!(await store.get(slug))) return res.status(404).json({ error: "not provisioned" });
    const { fnPassword } = await provision.upgradeCollaborator(adminPool, adminConnection, slug);
    await store.setFnPassword(slug, fnPassword);
    res.json({ slug, upgraded: true });
  });

  /**
   * One route, five operations, told apart by the shape of the body — the same
   * multiplexing the Studio's panel speaks. Every one of them runs on the
   * collaborator's own pool: their functions live in their database.
   */
  router.post("/collaborators/:slug/edge", async (req, res) => {
    const { slug } = req.params;
    const body = req.body ?? {};
    const pool = await poolFor(req, res);
    if (!pool) return;
    try {
      if (body.name === undefined) return res.json({ slug, functions: await edge.list(pool) });
      if (body.source !== undefined) {
        return res.json({ slug, ...(await edge.save(pool, body.name, body.source)) });
      }
      if (body.publish === true) return res.json({ slug, ...(await edge.publish(pool, body.name)) });
      if (body.secrets !== undefined) {
        return res.json({ slug, ...(await edge.setSecrets(pool, body.name, body.secrets, credentialsKey)) });
      }
      if (body.logs === true) {
        return res.json({ slug, name: body.name, invocations: await edge.logs(pool, body.name) });
      }
      return res.status(400).json({
        error: "body must be {}, { name, source }, { name, publish: true }, { name, secrets } or { name, logs: true }",
      });
    } catch (err) {
      // The compiler's verdict travels whole, so the editor can point at it.
      if (err instanceof edge.CompileError) {
        return res.status(400).json({ error: err.message, text: err.text, line: err.line, column: err.column });
      }
      if (err instanceof edge.InvalidFunctionInput) return res.status(400).json({ error: err.message });
      if (err instanceof edge.UnknownFunction) return res.status(404).json({ error: err.message });
      if (isPostgresError(err)) return res.status(422).json({ error: err.message, code: err.code });
      throw err;
    }
  });

  // The registry routes, and the only ones that use the admin pool for data:
  // an origin and a ticket have to be resolved BEFORE anyone knows the slug, so
  // they live in `stl_mcp` and never open a collaborator's pool.
  function registrySlug(value, res) {
    if (!isValidSlug(value)) {
      res.status(400).json({ error: "slug must match ^[a-z][a-z0-9_]{1,30}$" });
      return null;
    }
    return value;
  }

  function registryFailure(err, res) {
    if (err instanceof origins.OriginTaken) return res.status(409).json({ error: err.message, slug: err.slug });
    if (err instanceof origins.InvalidOrigin) return res.status(400).json({ error: err.message });
    if (err instanceof tickets.TicketReused) return res.status(409).json({ error: err.message });
    if (err instanceof tickets.InvalidTicket) return res.status(400).json({ error: err.message });
    throw err;
  }

  router.get("/origins/resolve", async (req, res) => {
    const slug = await origins.slugFor(adminPool, req.query.origin);
    if (!slug) return res.status(404).json({ error: "origin not registered" });
    res.json({ origin: req.query.origin, slug });
  });

  router.get("/origins", async (req, res) => {
    const slug = registrySlug(req.query.slug, res);
    if (!slug) return;
    res.json({ slug, origins: await origins.listFor(adminPool, slug) });
  });

  router.post("/origins", async (req, res) => {
    const slug = registrySlug(req.body?.slug, res);
    if (!slug) return;
    try {
      const added = await origins.add(adminPool, slug, req.body?.origin);
      res.status(added.created ? 201 : 200).json(added);
    } catch (err) {
      registryFailure(err, res);
    }
  });

  router.delete("/origins", async (req, res) => {
    const slug = registrySlug(req.body?.slug, res);
    if (!slug) return;
    try {
      res.json(await origins.remove(adminPool, slug, req.body?.origin));
    } catch (err) {
      registryFailure(err, res);
    }
  });

  // 204 or 409: the platform turns the conflict into a 401, so whoever replays
  // a ticket learns nothing from the difference.
  router.post("/tickets/consume", async (req, res) => {
    try {
      await tickets.consume(adminPool, req.body?.jti, req.body?.expiresAt);
      res.status(204).end();
    } catch (err) {
      registryFailure(err, res);
    }
  });

  return router;
}

function present(row) {
  return {
    slug: row.slug,
    email: row.email,
    dbName: row.db_name,
    roleName: row.role_name,
    hasToken: row.has_token,
    tokenIssuedAt: row.token_issued_at,
    createdAt: row.created_at,
  };
}
