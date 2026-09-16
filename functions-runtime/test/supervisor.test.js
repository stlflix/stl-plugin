import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { ChildDied, Supervisor, Timeout, UnknownFunction } from "../src/supervisor.js";

/**
 * A fake `child_process`, so the lifecycle — spawn, timeout, respawn, idle
 * reaping — is judged without waiting on a real process. `child.test.js`
 * already proves the real child obeys the flags; this proves the supervisor
 * gives it those flags and survives it dying.
 */
const CONFIG = { invokeTimeoutMs: 200, childMaxMb: 128, idleMs: 100 };
const REQUEST = { method: "GET", url: "http://fn.test/fn/alice/hello", headers: {}, body: null };
const USER = { role: "anon", claims: {} };

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.killed = null;
  }

  send(message) {
    this.sent.push(message);
  }

  kill(signal) {
    this.killed = signal;
    this.emit("exit", null, signal);
  }

  /** What the real child answers, whenever the test decides it does. */
  answer(id, patch = {}) {
    this.emit("message", {
      type: "result",
      id,
      status: 200,
      headers: { "content-type": "text/plain" },
      body: Buffer.from("hi").toString("base64"),
      log: [],
      ...patch,
    });
  }
}

function harness({ published = { version: 3, bundle: "export default () => {}", secrets: { TOKEN: "t0p" } }, bridge } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "buildloop-sup-")));
  const spawned = [];
  const asked = [];
  const childProcess = {
    spawn: (command, args, options) => {
      const child = new FakeChild();
      spawned.push({ command, args, options, child });
      return child;
    },
  };
  const mcp = {
    function: async (slug, name) => {
      asked.push(`${slug}/${name}`);
      return typeof published === "function" ? published(slug, name) : published;
    },
  };
  const supervisor = new Supervisor({
    config: CONFIG,
    bridge: bridge ?? { run: async () => ({ rows: [] }) },
    mcp,
    childProcess,
    fnDir: dir,
  });
  return { dir, spawned, asked, supervisor, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const last = (spawned) => spawned.at(-1).child;

test("the first invoke spawns one child with the permission flags and an empty environment", async () => {
  const h = harness();
  const pending = h.supervisor.invoke("alice", "hello", REQUEST, USER);
  await sleep(10);

  assert.equal(h.spawned.length, 1);
  const { command, args, options } = h.spawned[0];
  assert.equal(command, process.execPath);
  assert.equal(args[0], "--permission");
  assert.equal(args[1], `--allow-fs-read=${join(h.dir, "alice")}`);
  assert.equal(args[2], "--max-old-space-size=128");
  assert.match(args[3], /child\.js$/);
  assert.deepEqual(options.env, {}, "no credential can reach the child through its environment");
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe", "ipc"]);

  last(h.spawned).answer(last(h.spawned).sent[0].id);
  assert.equal((await pending).status, 200);
  h.cleanup();
});

test("the bundle is written once, and the invoke carries its path, version and secrets", async () => {
  const h = harness();
  const pending = h.supervisor.invoke("alice", "hello", REQUEST, USER);
  await sleep(10);
  const child = last(h.spawned);
  const message = child.sent[0];

  assert.equal(message.type, "invoke");
  assert.equal(message.version, 3);
  assert.equal(message.bundlePath, join(h.dir, "alice", "hello-v3.mjs"));
  assert.equal(readFileSync(message.bundlePath, "utf8"), "export default () => {}");
  assert.deepEqual(message.env, { TOKEN: "t0p" }, "the secrets travel in the message, never in the process env");
  child.answer(message.id);
  await pending;

  const second = h.supervisor.invoke("alice", "hello", REQUEST, USER);
  await sleep(10);
  assert.deepEqual(h.asked, ["alice/hello"], "the published version was fetched once");
  assert.equal(h.spawned.length, 1, "and the same child served both");
  child.answer(child.sent[1].id);
  await second;
  h.cleanup();
});

test("reload makes the next invoke fetch the published version again", async () => {
  let version = 3;
  const h = harness({ published: () => ({ version, bundle: `// v${version}`, secrets: {} }) });
  const first = h.supervisor.invoke("alice", "hello", REQUEST, USER);
  await sleep(10);
  last(h.spawned).answer(last(h.spawned).sent[0].id);
  await first;

  version = 4;
  h.supervisor.reload("alice", "hello");
  const second = h.supervisor.invoke("alice", "hello", REQUEST, USER);
  await sleep(10);
  const child = last(h.spawned);
  assert.equal(child.sent[1].version, 4);
  assert.equal(child.sent[1].bundlePath, join(h.dir, "alice", "hello-v4.mjs"));
  assert.deepEqual(h.asked, ["alice/hello", "alice/hello"], "one extra call, not a poll");
  child.answer(child.sent[1].id);
  await second;
  h.cleanup();
});

test("a sql message is answered by the bridge, as the user of that very invocation", async () => {
  const asked = [];
  const h = harness({
    bridge: {
      run: async (slug, user, text, params) => {
        asked.push({ slug, user, text, params });
        return { rows: [{ n: 1 }] };
      },
    },
  });
  const user = { role: "authenticated", claims: { sub: "9" } };
  const pending = h.supervisor.invoke("alice", "hello", REQUEST, user);
  await sleep(10);
  const child = last(h.spawned);
  const invocation = child.sent[0].id;

  child.emit("message", { type: "sql", id: `${invocation}:1`, invocation, text: "select 1", params: [] });
  await sleep(10);
  assert.deepEqual(asked, [{ slug: "alice", user, text: "select 1", params: [] }]);
  assert.deepEqual(child.sent[1], { type: "sql:result", id: `${invocation}:1`, result: { rows: [{ n: 1 }] } });

  child.answer(invocation);
  await pending;
  h.cleanup();
});

test("a sql the database refuses comes back to the child as an error, not as a dead invocation", async () => {
  const h = harness({
    bridge: {
      run: async () => {
        throw Object.assign(new Error("permission denied for table notes"), { code: "42501" });
      },
    },
  });
  const pending = h.supervisor.invoke("alice", "hello", REQUEST, USER);
  await sleep(10);
  const child = last(h.spawned);
  const invocation = child.sent[0].id;
  child.emit("message", { type: "sql", id: `${invocation}:1`, invocation, text: "select 1", params: [] });
  await sleep(10);
  assert.deepEqual(child.sent[1], {
    type: "sql:error",
    id: `${invocation}:1`,
    message: "permission denied for table notes",
    code: "42501",
  });
  child.answer(invocation);
  await pending;
  h.cleanup();
});

test("a handler that throws is a 500 with its log, and the child stays alive", async () => {
  const h = harness();
  const pending = h.supervisor.invoke("alice", "hello", REQUEST, USER);
  await sleep(10);
  const child = last(h.spawned);
  child.emit("message", { type: "error", id: child.sent[0].id, message: "nope", log: ["log: before"] });
  const answer = await pending;
  assert.equal(answer.status, 500);
  assert.equal(answer.error, "nope");
  assert.deepEqual(answer.log, ["log: before"]);
  assert.deepEqual(JSON.parse(Buffer.from(answer.body, "base64").toString("utf8")), { error: "nope" });
  assert.equal(child.killed, null);
  h.cleanup();
});

test("a handler over the timeout is killed with SIGKILL, and the next invoke spawns a new child", async () => {
  const h = harness();
  const pending = h.supervisor.invoke("alice", "hello", REQUEST, USER);
  await assert.rejects(() => pending, Timeout);
  assert.equal(h.spawned[0].child.killed, "SIGKILL");

  const again = h.supervisor.invoke("alice", "hello", REQUEST, USER);
  await sleep(10);
  assert.equal(h.spawned.length, 2, "the function is available for the next request (BL-23)");
  last(h.spawned).answer(last(h.spawned).sent[0].id);
  assert.equal((await again).status, 200);
  h.cleanup();
});

test("the requests in flight when a child dies are rejected as ChildDied, not left hanging", async () => {
  const h = harness();
  const first = h.supervisor.invoke("alice", "hello", REQUEST, USER);
  const second = h.supervisor.invoke("alice", "hello", REQUEST, USER);
  await sleep(10);
  // What an out-of-memory child does: it goes, without answering.
  last(h.spawned).emit("exit", null, "SIGKILL");
  await assert.rejects(() => first, ChildDied);
  await assert.rejects(() => second, ChildDied);
  h.cleanup();
});

test("a child with nothing to do is killed after the idle window, and respawned on demand", async () => {
  const h = harness();
  const pending = h.supervisor.invoke("alice", "hello", REQUEST, USER);
  await sleep(10);
  last(h.spawned).answer(last(h.spawned).sent[0].id);
  await pending;
  assert.equal(h.spawned[0].child.killed, null, "it is not killed while the window is open");

  await sleep(CONFIG.idleMs + 60);
  assert.equal(h.spawned[0].child.killed, "SIGKILL");

  const again = h.supervisor.invoke("alice", "hello", REQUEST, USER);
  await sleep(10);
  assert.equal(h.spawned.length, 2);
  last(h.spawned).answer(last(h.spawned).sent[0].id);
  await again;
  h.cleanup();
});

test("a function with no published version is refused without spawning anything", async () => {
  const h = harness({ published: () => null });
  await assert.rejects(() => h.supervisor.invoke("alice", "ghost", REQUEST, USER), UnknownFunction);
  assert.equal(h.spawned.length, 0);
  h.cleanup();
});
