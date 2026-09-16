import { randomBytes } from "node:crypto";
import express from "express";
import { hashToken, isValidSlug, secretEquals } from "./auth.js";
import { DESCRIBE_SQL, LIST_TABLES_SQL } from "./catalog.js";
import { provisionCollaborator } from "./provision.js";
import { InvalidQueryInput, isPostgresError, parseQueryInput, runReadOnly } from "./readonly.js";

/**
 * Admin surface, for the platform (plataforma-product-ops) and for Lucas's shell.
 * Authenticated by a shared secret in `X-Admin-Key`; never reachable through
 * Traefik — the public router only forwards `/mcp`.
 */
export function adminRouter({ adminKey, adminPool, adminConnection, store, pools }) {
  const router = express.Router();

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
    const { password, fnPassword, dbName, created } = await provisionCollaborator(adminPool, adminConnection, slug);
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
