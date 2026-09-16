import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * A REAL child, with the real flags. Nothing here is a mock: the permission
 * model either denies `/etc/hostname` and `child_process` inside that process
 * or it does not, and the whole of I3 rests on it doing so.
 */
const CHILD = fileURLToPath(new URL("../src/child.js", import.meta.url));
const MAX_MB = 128;

let dir;
let child;
const inbox = [];
const waiters = [];

function push(message) {
  inbox.push(message);
  for (let i = waiters.length - 1; i >= 0; i -= 1) {
    if (waiters[i].match(message)) waiters.splice(i, 1)[0].resolve(message);
  }
}

function waitFor(match, timeoutMs = 10_000) {
  const found = inbox.find(match);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no message matched in time")), timeoutMs);
    waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
  });
}

function bundle(name, source) {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, source);
  return path;
}

before(async () => {
  // `realpathSync`: on macOS `os.tmpdir()` is the symlink /var/folders/…, and
  // the permission model matches the REAL path — the allowlist would never hit.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "buildloop-child-")));
  child = spawn(
    process.execPath,
    ["--permission", `--allow-fs-read=${dir}`, `--max-old-space-size=${MAX_MB}`, CHILD],
    { env: {}, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  child.on("message", push);
  await waitFor((m) => m.type === "ready");
});

after(() => {
  child?.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

let nextId = 0;
async function invoke(bundlePath, { name = "hello", version = 1, request = {}, user = {}, env = {}, sqlTimeoutMs } = {}) {
  const id = `i${(nextId += 1)}`;
  child.send({
    type: "invoke",
    id,
    name,
    version,
    bundlePath,
    request: { method: "GET", url: "http://fn.test/fn/alice/hello", headers: {}, body: null, ...request },
    user,
    env,
    sqlTimeoutMs,
  });
  return waitFor((m) => (m.type === "result" || m.type === "error") && m.id === id);
}

function body(message) {
  return Buffer.from(message.body, "base64").toString("utf8");
}

test("the child's environment holds the function's secrets and nothing else", async () => {
  const path = bundle("env", 'export default async () => new Response(JSON.stringify(process.env));');
  const result = await invoke(path, { name: "env", env: { TOKEN: "t0p", OTHER: "x" } });
  assert.equal(result.type, "result");
  assert.deepEqual(JSON.parse(body(result)), { TOKEN: "t0p", OTHER: "x" });
});

test("reading a file outside the slug's directory is denied by the permission model", async () => {
  const path = bundle(
    "readfs",
    `import { readFileSync } from "node:fs";
     export default async () => {
       try { readFileSync("/etc/hostname"); return new Response("read it", { status: 500 }); }
       catch (err) { return new Response(err.code ?? err.message, { status: 200 }); }
     };`,
  );
  const result = await invoke(path, { name: "readfs" });
  assert.equal(result.type, "result");
  assert.equal(body(result), "ERR_ACCESS_DENIED");
});

test("spawning a child process is denied by the permission model", async () => {
  const path = bundle(
    "spawner",
    `import { spawn } from "node:child_process";
     export default async () => {
       try { spawn("id", []); return new Response("spawned", { status: 500 }); }
       catch (err) { return new Response(err.code ?? err.message, { status: 200 }); }
     };`,
  );
  const result = await invoke(path, { name: "spawner" });
  assert.equal(result.type, "result");
  assert.equal(body(result), "ERR_ACCESS_DENIED");
});

test("ctx.sql is an IPC round trip the parent answers — the child never touches a database", async () => {
  const path = bundle(
    "query",
    `export default async (req, ctx) => {
       const result = await ctx.sql("select $1::int as n", [7]);
       return new Response(JSON.stringify(result.rows));
     };`,
  );
  const asked = waitFor((m) => m.type === "sql");
  const pending = invoke(path, { name: "query" });
  const question = await asked;
  assert.equal(question.text, "select $1::int as n");
  assert.deepEqual(question.params, [7]);
  assert.match(question.id, /^i\d+:\d+$/, "each call carries an id of its own");
  child.send({ type: "sql:result", id: question.id, result: { rows: [{ n: 7 }] } });
  const result = await pending;
  assert.deepEqual(JSON.parse(body(result)), [{ n: 7 }]);
});

test("a ctx.sql the parent never answers times out instead of hanging the invocation", async () => {
  const path = bundle(
    "silent",
    `export default async (req, ctx) => {
       await ctx.sql("select 1", []);
       return new Response("never");
     };`,
  );
  const result = await invoke(path, { name: "silent", sqlTimeoutMs: 200 });
  assert.equal(result.type, "error");
  assert.match(result.message, /ctx\.sql timed out after 200 ms/);
});

test("a handler that throws answers as an error, with what it logged before it threw", async () => {
  const path = bundle(
    "boom",
    `export default async () => { console.log("about to fail"); throw new Error("nope"); };`,
  );
  const result = await invoke(path, { name: "boom" });
  assert.equal(result.type, "error");
  assert.equal(result.message, "nope");
  assert.deepEqual(result.log, ["log: about to fail"]);
});

test("the status, the headers and the body of the handler's Response travel back whole", async () => {
  const path = bundle(
    "created",
    `export default async (req, ctx) => new Response(JSON.stringify({ method: req.method, user: ctx.user }), {
       status: 201,
       headers: { "X-Thing": "made", "Content-Type": "application/json" },
     });`,
  );
  const result = await invoke(path, { name: "created", request: { method: "POST", body: Buffer.from("{}").toString("base64") }, user: { role: "anon" } });
  assert.equal(result.type, "result");
  assert.equal(result.status, 201);
  assert.equal(result.headers["x-thing"], "made");
  assert.deepEqual(JSON.parse(body(result)), { method: "POST", user: { role: "anon" } });
});

test("a bundle is imported once per name and version", async () => {
  const path = bundle(
    "counter",
    `let loaded = 0; loaded += 1;
     export default async () => new Response(String(loaded));`,
  );
  assert.equal(body(await invoke(path, { name: "counter", version: 2 })), "1");
  assert.equal(body(await invoke(path, { name: "counter", version: 2 })), "1", "the module was not re-imported");
});
