import express from "express";
import pg from "pg";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { adminRouter } from "./admin.js";
import { bearerFrom, hashToken } from "./auth.js";
import { loadKey } from "./crypto.js";
import { PoolRegistry } from "./db.js";
import { hardenSharedDatabases } from "./provision.js";
import { CollaboratorStore } from "./store.js";
import { defineTools } from "./tools.js";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const config = {
  port: Number(process.env.PORT ?? 8200),
  dbHost: process.env.DB_HOST ?? "db",
  dbPort: Number(process.env.DB_PORT ?? 5432),
  statementTimeoutMs: Number(process.env.STATEMENT_TIMEOUT_MS ?? 30_000),
  // supabase_admin on the shared database: provisioning and the registry.
  adminDbUrl: required("ADMIN_DB_URL"),
  adminKey: required("ADMIN_KEY"),
  credentialsKey: loadKey(required("CREDENTIALS_KEY")),
};

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
const pools = new PoolRegistry({ store, host: config.dbHost, port: config.dbPort, statementTimeoutMs: config.statementTimeoutMs });
const tools = defineTools({ pools });
const byName = new Map(tools.map((t) => [t.name, t]));

function buildServer(slug) {
  const server = new Server({ name: "stl-supabase", version: "0.2.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) throw new Error(`unknown tool: ${request.params.name}`);
    try {
      const result = await tool.handler(slug, request.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      // Surface the database's own message; it is the collaborator's own database.
      return { content: [{ type: "text", text: `error: ${err.message}` }], isError: true };
    }
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

app.use("/admin", adminRouter({ adminKey: config.adminKey, adminPool, adminConnection, store, pools }));

app.post("/mcp", async (req, res) => {
  const token = bearerFrom(req.get("authorization"));
  const slug = token ? await store.slugForTokenHash(hashToken(token)) : null;
  if (!slug) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="stl-supabase"');
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
  console.log(`stl-supabase MCP listening on ${config.port} for ${await store.count()} collaborator(s)`),
);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    listener.close();
    await pools.closeAll();
    await adminPool.end();
    process.exit(0);
  });
}
