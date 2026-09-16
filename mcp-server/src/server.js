import express from "express";
import pg from "pg";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { adminRouter } from "./admin.js";
import { bearerFrom, hashToken } from "./auth.js";
import { loadConfig } from "./config.js";
import { PoolRegistry } from "./db.js";
import { hardenSharedDatabases } from "./provision.js";
import { runtimeRouter } from "./runtime-api.js";
import { CollaboratorStore } from "./store.js";
import { callTool, defineTools } from "./tools.js";

// By allowlist, and never with an env that belongs to the platform (I1).
const config = loadConfig();

const adminUrl = new URL(config.adminDbUrl);
const adminConnection = {
  host: adminUrl.hostname,
  port: Number(adminUrl.port || 5432),
  user: decodeURIComponent(adminUrl.username),
  password: decodeURIComponent(adminUrl.password),
};
const adminPool = new pg.Pool({ connectionString: config.adminDbUrl, max: 3 });
adminPool.on("error", (err) => console.error(`[admin pool] ${err.message}`));

const store = new CollaboratorStore(adminPool, config.credentialsKey);
const pools = new PoolRegistry({
  store,
  host: config.dbHost,
  port: config.dbPort,
  statementTimeoutMs: config.statementTimeoutMs,
  // The same identity provisioning already uses inside a collaborator's
  // database: it owns the `buildloop` schema, so it is what writes there (AD-009).
  adminConnection,
});
const tools = defineTools({
  pools,
  adminPool,
  credentialsKey: config.credentialsKey,
  functionsUrl: config.functionsUrl,
});
const byName = new Map(tools.map((t) => [t.name, t]));

function buildServer(slug) {
  const server = new Server({ name: "stl-buildloop", version: "0.4.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) throw new Error(`unknown tool: ${request.params.name}`);
    // The wrapper lives in tools.js, so what a tool answers is testable there.
    return callTool(tool, slug, request.params.arguments);
  });

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", async (_req, res) => {
  try {
    res.json({ ok: true, collaborators: await store.count() });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// The runtime's own surface is mounted first: `/admin/runtime/*` belongs to the
// runtime key alone, and never falls through to the admin key's router.
app.use(
  "/admin/runtime",
  runtimeRouter({ runtimeKey: config.runtimeKey, credentialsKey: config.credentialsKey, store, pools }),
);
app.use(
  "/admin",
  adminRouter({ adminKey: config.adminKey, adminPool, adminConnection, credentialsKey: config.credentialsKey, store, pools }),
);

app.post("/mcp", async (req, res) => {
  const token = bearerFrom(req.get("authorization"));
  const slug = token ? await store.slugForTokenHash(hashToken(token)) : null;
  if (!slug) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="stl-buildloop"');
    return res.status(401).json({ error: "unknown or missing bearer token" });
  }

  // Stateless: one server and one transport per request, so no session can leak
  // from one collaborator to the next.
  const server = buildServer(slug);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// GET and DELETE only exist for stateful sessions, which this server does not use.
app.all("/mcp", (_req, res) => res.status(405).json({ error: "method not allowed" }));

// Express 5 forwards rejected promises here; without it a failed admin call hangs.
app.use((err, _req, res, _next) => {
  console.error(`[http] ${err.message}`);
  res.status(500).json({ error: err.message });
});

await store.ensureSchema();
await hardenSharedDatabases(adminPool);

const listener = app.listen(config.port, "0.0.0.0", async () =>
  console.log(`stl-buildloop MCP listening on ${config.port} for ${await store.count()} collaborator(s)`),
);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    listener.close();
    await pools.closeAll();
    await adminPool.end();
    process.exit(0);
  });
}
