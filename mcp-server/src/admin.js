import { randomBytes } from "node:crypto";
import express from "express";
import { hashToken, isValidSlug, secretEquals } from "./auth.js";
import { provisionCollaborator } from "./provision.js";

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
    const { password, dbName, created } = await provisionCollaborator(adminPool, adminConnection, slug);
    await store.upsert({ slug, email, dbName, password });
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
