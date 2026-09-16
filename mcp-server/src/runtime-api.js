/**
 * The only surface the functions runtime may call, behind a key of its own
 * (I5). It answers two questions and nothing else: which credential runs a
 * slug's functions, and what is the published bundle of one function. The admin
 * key does not open it and this key does not open `/admin` — a runtime that is
 * compromised still cannot provision, exec or mint a token.
 */
import express from "express";
import { isValidSlug, secretEquals } from "./auth.js";
import { InvalidFunctionInput, assertFunctionName, bundleFor } from "./edge.js";

export function runtimeRouter({ runtimeKey, credentialsKey, store, pools }) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!secretEquals(req.get("x-runtime-key"), runtimeKey)) {
      return res.status(401).json({ error: "invalid runtime key" });
    }
    next();
  });

  router.param("slug", (req, res, next, slug) => {
    if (!isValidSlug(slug)) return res.status(400).json({ error: "slug must match ^[a-z][a-z0-9_]{1,30}$" });
    next();
  });

  /**
   * `<slug>_fn`: a role that owns nothing and reaches a table only after
   * `SET ROLE`. The owner's password is in the same row and never leaves here.
   */
  router.post("/credential/:slug", async (req, res) => {
    const credential = await store.fnConnectionFor(req.params.slug);
    if (!credential) return res.status(404).json({ error: "not provisioned" });
    res.json({ slug: req.params.slug, ...credential });
  });

  router.post("/function/:slug/:name", async (req, res) => {
    const { slug, name } = req.params;
    try {
      assertFunctionName(name);
    } catch (err) {
      if (err instanceof InvalidFunctionInput) return res.status(400).json({ error: err.message });
      throw err;
    }
    if (!(await store.get(slug))) return res.status(404).json({ error: "not provisioned" });
    // The admin role inside the slug's database: `edge_function_secrets` is
    // revoked from the slug itself, so its own pool could not read this (AD-009).
    const published = await bundleFor(await pools.adminForSlug(slug), name, credentialsKey);
    if (!published) return res.status(404).json({ error: `no published version of '${name}'` });
    res.json({ slug, ...published });
  });

  // Nothing else exists behind this key.
  router.use((_req, res) => res.status(404).json({ error: "not found" }));

  return router;
}
