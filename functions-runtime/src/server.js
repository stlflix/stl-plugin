/**
 * The runtime's HTTP surface: the public URL of every collaborator function,
 * the JWKS the apps verify their own token with, and one internal route the
 * MCP calls when a new version is published. Written on `node:http` on
 * purpose — this container runs other people's code, and every dependency it
 * does not have is one it cannot be attacked through.
 */
import { createServer as createHttpServer } from "node:http";
import { createLocalJWKSet, exportJWK } from "jose";
import { loadConfig } from "./config.js";
import { BodyTooLarge, NO_STORE, gateway, readLimitedBody } from "./gateway.js";
import { McpClient } from "./mcp.js";
import { SqlBridge } from "./sqlbridge.js";
import { ChildDied, Supervisor, Timeout, UnknownFunction } from "./supervisor.js";

const JWKS_CACHE = { "cache-control": "public, max-age=300" };

/**
 * A collaborator's page calls its functions from another origin, so every
 * `/fn` answer — and the preflight before it — carries CORS. `*` is safe here
 * because identity travels in the `Authorization` header, never in a cookie:
 * the browser does not attach credentials, and a token it does not hold buys
 * nothing. Which origins may LOG IN is the platform's decision (its exchange
 * route checks the registry); which pages may CALL a published function is
 * the function's own business.
 */
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-expose-headers": "retry-after",
  "access-control-max-age": "600",
};

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), "utf8");
  const type = Buffer.isBuffer(body) ? {} : { "content-type": "application/json" };
  res.writeHead(status, { ...type, ...headers, "content-length": payload.length });
  res.end(payload);
}

export function createServer({ config, admit, supervisor, bridge, jwk, runtimeKey }) {
  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://runtime.invalid");
      const parts = url.pathname.split("/").filter(Boolean);

      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/auth/jwks") {
        return send(res, 200, { keys: [jwk] }, JWKS_CACHE);
      }
      if (parts[0] === "_reload") return reload(req, res, parts, supervisor, runtimeKey);
      if (parts[0] === "fn") return await invoke(req, res, parts, { admit, supervisor, bridge });
      return send(res, 404, { error: "not found" }, NO_STORE);
    } catch (err) {
      console.error(`[http] ${err.message}`);
      send(res, 500, { error: err.message }, NO_STORE);
    }
  });
}

/** Internal only, behind the runtime's own key: publishing moved a version. */
function reload(req, res, parts, supervisor, runtimeKey) {
  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
  if (req.headers["x-runtime-key"] !== runtimeKey) return send(res, 401, { error: "invalid runtime key" });
  const [, slug, name] = parts;
  if (!slug || !name) return send(res, 400, { error: "expected /_reload/:slug/:name" });
  supervisor.reload(slug, name);
  send(res, 200, { slug, name, reloaded: true });
}

async function invoke(req, res, parts, { admit, supervisor, bridge }) {
  const started = Date.now();
  const [, slug, name] = parts;
  // The preflight carries no bearer and must not be judged as a call.
  if (req.method === "OPTIONS") return send(res, 204, Buffer.alloc(0), { ...CORS, ...NO_STORE });
  const verdict = await admit({ slug, name, headers: req.headers });
  if (!verdict.ok) return send(res, verdict.status, { error: verdict.error }, { ...CORS, ...verdict.headers });

  let body;
  try {
    body = await readLimitedBody(req);
  } catch (err) {
    if (!(err instanceof BodyTooLarge)) throw err;
    return send(res, 413, { error: err.message }, { ...CORS, ...verdict.headers });
  }

  const request = {
    method: req.method,
    url: `https://${req.headers.host ?? "runtime.invalid"}${req.url}`,
    headers: { ...req.headers },
    body: body.length > 0 ? body.toString("base64") : null,
  };

  try {
    const answer = await supervisor.invoke(slug, name, request, verdict.user);
    await log(bridge, slug, { name, status: answer.status, durationMs: Date.now() - started, log: answer.log, error: answer.error });
    return send(res, answer.status, Buffer.from(answer.body ?? "", "base64"), { ...CORS, ...answer.headers, ...verdict.headers });
  } catch (err) {
    // The three ways an invocation ends without an answer, each its own status:
    // nothing published (404), too slow (504), the process is gone (503).
    const status = err instanceof UnknownFunction ? 404 : err instanceof Timeout ? 504 : err instanceof ChildDied ? 503 : 500;
    if (status !== 404) {
      await log(bridge, slug, { name, status, durationMs: Date.now() - started, log: [], error: err.message });
    }
    return send(res, status, { error: err.message }, { ...CORS, ...verdict.headers });
  }
}

/** A log that cannot be written must not take the answer down with it. */
async function log(bridge, slug, row) {
  try {
    await bridge.writeInvocation(slug, row);
  } catch (err) {
    console.error(`[invocations:${slug}] ${err.message}`);
  }
}

async function main() {
  const config = loadConfig();
  const jwk = { ...(await exportJWK(config.authPublicKey)), alg: "ES256", use: "sig" };
  const mcp = new McpClient({ baseUrl: config.mcpUrl, runtimeKey: config.runtimeKey });
  const bridge = new SqlBridge({ mcp, config });
  const supervisor = new Supervisor({ config, bridge, mcp });
  const admit = gateway(config, createLocalJWKSet({ keys: [jwk] }));

  const server = createServer({ config, admit, supervisor, bridge, jwk, runtimeKey: config.runtimeKey });
  server.listen(config.port, "0.0.0.0", () => console.log(`stl-buildloop functions listening on ${config.port}`));

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, async () => {
      server.close();
      supervisor.killAll();
      await bridge.close();
      process.exit(0);
    });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
