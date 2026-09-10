import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { bearerFrom, loadTokenMap, slugForToken } from "./auth.js";
import { PoolRegistry } from "./db.js";
import { defineTools } from "./tools.js";

const config = {
  port: Number(process.env.PORT ?? 8200),
  tokenFile: process.env.TOKEN_FILE ?? "/etc/stl-supabase/tokens.json",
  credentialsDir: process.env.CREDENTIALS_DIR ?? "/etc/stl-supabase/collaborators",
  dbHost: process.env.DB_HOST ?? "db",
  dbPort: Number(process.env.DB_PORT ?? 5432),
  statementTimeoutMs: Number(process.env.STATEMENT_TIMEOUT_MS ?? 30_000),
};

const tokenMap = loadTokenMap(config.tokenFile);
const pools = new PoolRegistry({
  credentialsDir: config.credentialsDir,
  host: config.dbHost,
  port: config.dbPort,
  statementTimeoutMs: config.statementTimeoutMs,
});
const tools = defineTools({ pools });
const byName = new Map(tools.map((t) => [t.name, t]));

function buildServer(slug) {
  const server = new Server(
    { name: "stl-supabase", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, title, description, inputSchema }) => ({
      name,
      title,
      description,
      inputSchema,
    })),
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

app.get("/healthz", (_req, res) => res.json({ ok: true, collaborators: tokenMap.size }));

app.post("/mcp", async (req, res) => {
  const slug = slugForToken(tokenMap, bearerFrom(req.get("authorization")));
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

const listener = app.listen(config.port, "0.0.0.0", () =>
  console.log(`stl-supabase MCP listening on ${config.port} for ${tokenMap.size} collaborator(s)`),
);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    listener.close();
    await pools.closeAll();
    process.exit(0);
  });
}
