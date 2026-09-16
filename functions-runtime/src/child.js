/**
 * The process that runs the collaborator's code, and the only one in this
 * system that holds NOTHING (I3): no database URL, no MCP key, no platform
 * secret. It is started by the supervisor as
 *
 *   node --permission --allow-fs-read=<dir of the slug> --max-old-space-size=<MB> child.js
 *
 * so the permission model denies `child_process`, `worker_threads`, WASI,
 * addons and every file outside that one directory (verified against the Node
 * 24 CLI docs: the violations throw `ERR_ACCESS_DENIED`). The only way out is
 * the IPC channel, and the only thing it can ask for is `ctx.sql` — which the
 * PARENT executes, as `<slug>_anon` or `<slug>_authenticated`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";

const SQL_TIMEOUT_MS = 10_000;
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"];

const invocations = new AsyncLocalStorage();
const bundles = new Map();
const pendingSql = new Map();
let sqlCounter = 0;

/**
 * `console.*` belongs to the invocation that wrote it, not to the process: the
 * child answers several requests at once and the log of each goes back with its
 * own response.
 */
for (const method of CONSOLE_METHODS) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    const store = invocations.getStore();
    if (!store) return original(...args);
    store.log.push(`${method}: ${args.map(render).join(" ")}`);
  };
}

function render(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** One module per `name@version`: publishing a new version is what invalidates it. */
async function handlerFor(name, version, bundlePath) {
  const key = `${name}@${version}`;
  if (!bundles.has(key)) bundles.set(key, import(pathToFileURL(bundlePath).href));
  const module = await bundles.get(key);
  const handler = module.default;
  if (typeof handler !== "function") throw new Error(`function '${name}' does not export a default handler`);
  return handler;
}

function sql(invocationId, timeoutMs) {
  return (text, params = []) =>
    new Promise((resolve, reject) => {
      sqlCounter += 1;
      const id = `${invocationId}:${sqlCounter}`;
      const timer = setTimeout(() => {
        pendingSql.delete(id);
        reject(new Error(`ctx.sql timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      pendingSql.set(id, { resolve, reject, timer });
      process.send({ type: "sql", id, invocation: invocationId, text, params });
    });
}

function requestFrom({ method = "GET", url, headers = {}, body = null }) {
  const init = { method, headers };
  if (body !== null && method !== "GET" && method !== "HEAD") init.body = Buffer.from(body, "base64");
  return new Request(url, init);
}

async function serialize(response) {
  const body = Buffer.from(await response.arrayBuffer()).toString("base64");
  return { status: response.status, headers: Object.fromEntries(response.headers), body };
}

async function invoke(message) {
  const { id, name, version, bundlePath, request, user, env = {}, sqlTimeoutMs = SQL_TIMEOUT_MS } = message;
  // The whole environment of this process is the function's own secrets, and it
  // is replaced — never merged — so nothing the supervisor holds can leak in.
  process.env = { ...env };
  const store = { log: [] };
  await invocations.run(store, async () => {
    try {
      const handler = await handlerFor(name, version, bundlePath);
      const response = await handler(requestFrom(request), { sql: sql(id, sqlTimeoutMs), env: { ...env }, user });
      if (!(response instanceof Response)) throw new Error(`function '${name}' did not return a Response`);
      process.send({ type: "result", id, ...(await serialize(response)), log: store.log });
    } catch (err) {
      process.send({ type: "error", id, message: err.message, log: store.log });
    }
  });
}

process.on("message", (message) => {
  if (message?.type === "invoke") {
    invoke(message).catch((err) => process.send({ type: "error", id: message.id, message: err.message, log: [] }));
    return;
  }
  if (message?.type === "sql:result" || message?.type === "sql:error") {
    const pending = pendingSql.get(message.id);
    if (!pending) return;
    pendingSql.delete(message.id);
    clearTimeout(pending.timer);
    if (message.type === "sql:result") pending.resolve(message.result);
    else pending.reject(new Error(message.message));
  }
});

process.send({ type: "ready" });
