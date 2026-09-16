/**
 * One child per collaborator, not one per request: a long-lived process that
 * pays the ~100 ms import once and is killed when it goes quiet. The
 * supervisor is the only thing that talks to it, and it is what makes the
 * child's poverty possible — the bundle, the secrets and every answer to
 * `ctx.sql` come through this process, so nothing the child holds is a
 * credential (I3).
 *
 * Everything that can go wrong with a foreign process is answered by killing
 * it: a handler over the invocation timeout, an out-of-memory exit, a silent
 * child. The next request spawns a new one (BL-23: the function stays
 * available).
 */
import { spawn as realSpawn } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_FN_DIR = "/var/fn";
const CHILD_ENTRY = fileURLToPath(new URL("./child.js", import.meta.url));

export class Timeout extends Error {
  constructor(ms) {
    super(`the handler did not answer in ${ms} ms`);
    this.name = "Timeout";
  }
}

export class ChildDied extends Error {
  constructor(reason) {
    super(`the function process died: ${reason}`);
    this.name = "ChildDied";
  }
}

export class UnknownFunction extends Error {
  constructor(slug, name) {
    super(`no published version of '${name}' for '${slug}'`);
    this.name = "UnknownFunction";
  }
}

export class Supervisor {
  #children = new Map();
  #bundles = new Map();
  #counter = 0;

  constructor({ config, bridge, mcp, childProcess = { spawn: realSpawn }, fnDir = DEFAULT_FN_DIR }) {
    this.config = config;
    this.bridge = bridge;
    this.mcp = mcp;
    this.childProcess = childProcess;
    this.fnDir = fnDir;
  }

  /**
   * The published bundle, on disk because `--allow-fs-read` needs a path. The
   * database is the source of truth; this file is a cache that a `reload` — or
   * a restart of the container, since the directory is a tmpfs — throws away.
   */
  async bundleFor(slug, name) {
    const key = `${slug}/${name}`;
    const cached = this.#bundles.get(key);
    // The PROMISE is cached, not its value: two requests that arrive together
    // ask the MCP once and write the file once.
    if (cached) return cached;
    const loading = this.#load(slug, name);
    this.#bundles.set(key, loading);
    try {
      return await loading;
    } catch (err) {
      this.#bundles.delete(key);
      throw err;
    }
  }

  async #load(slug, name) {
    const published = await this.mcp.function(slug, name);
    if (!published) throw new UnknownFunction(slug, name);
    const path = join(this.#dirFor(slug), `${name}-v${published.version}.mjs`);
    writeFileSync(path, published.bundle, { mode: 0o600 });
    return { version: published.version, path, secrets: published.secrets ?? {} };
  }

  /** Publishing moved `current_version`: forget what we cached, keep the child. */
  reload(slug, name) {
    this.#bundles.delete(`${slug}/${name}`);
  }

  async invoke(slug, name, request, user) {
    const bundle = await this.bundleFor(slug, name);
    const child = this.#childFor(slug);
    this.#counter += 1;
    const id = `${slug}-${this.#counter}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.pending.delete(id);
        reject(new Timeout(this.config.invokeTimeoutMs));
        // Whatever it is still doing, it is doing it without us: kill, and the
        // exit handler fails the other requests that were in flight.
        this.#kill(slug, "timeout");
      }, this.config.invokeTimeoutMs);
      timer.unref?.();

      child.pending.set(id, { resolve, reject, timer, user });
      this.#clearIdle(child);
      child.proc.send({
        type: "invoke",
        id,
        name,
        version: bundle.version,
        bundlePath: bundle.path,
        request,
        user,
        env: bundle.secrets,
        sqlTimeoutMs: this.config.invokeTimeoutMs,
      });
    });
  }

  #dirFor(slug) {
    const dir = join(this.fnDir, slug);
    mkdirSync(dir, { recursive: true });
    // The permission model matches the RESOLVED path: a symlinked temp dir
    // would be denied its own bundle.
    return realpathSync(dir);
  }

  #childFor(slug) {
    const existing = this.#children.get(slug);
    if (existing) return existing;

    const dir = this.#dirFor(slug);
    const proc = this.childProcess.spawn(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${dir}`,
        `--max-old-space-size=${this.config.childMaxMb}`,
        CHILD_ENTRY,
      ],
      // No environment and no credential: the child gets the function's secrets
      // in the invoke message, and nothing else ever.
      { env: {}, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    const child = { proc, pending: new Map(), idleTimer: null, dir };
    proc.on("message", (message) => this.#onMessage(slug, child, message));
    proc.on("exit", (code, signal) => this.#onExit(slug, child, `exit ${code ?? ""}${signal ? ` ${signal}` : ""}`.trim()));
    proc.on("error", (err) => this.#onExit(slug, child, err.message));
    this.#children.set(slug, child);
    return child;
  }

  async #onMessage(slug, child, message) {
    if (message?.type === "sql") {
      const pending = child.pending.get(message.invocation);
      if (!pending) return;
      try {
        const result = await this.bridge.run(slug, pending.user, message.text, message.params);
        child.proc.send({ type: "sql:result", id: message.id, result });
      } catch (err) {
        child.proc.send({ type: "sql:error", id: message.id, message: err.message, code: err.code ?? null });
      }
      return;
    }
    if (message?.type !== "result" && message?.type !== "error") return;

    const pending = child.pending.get(message.id);
    if (!pending) return;
    child.pending.delete(message.id);
    clearTimeout(pending.timer);
    this.#armIdle(slug, child);
    if (message.type === "result") {
      pending.resolve({
        status: message.status,
        headers: message.headers,
        body: message.body,
        log: message.log ?? [],
        error: null,
      });
      return;
    }
    // A handler that threw is an answer, not a dead child: 500 with its log.
    pending.resolve({
      status: 500,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ error: message.message }), "utf8").toString("base64"),
      log: message.log ?? [],
      error: message.message,
    });
  }

  #onExit(slug, child, reason) {
    if (this.#children.get(slug) === child) this.#children.delete(slug);
    this.#clearIdle(child);
    for (const [id, pending] of child.pending) {
      child.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new ChildDied(reason));
    }
  }

  #kill(slug, reason) {
    const child = this.#children.get(slug);
    if (!child) return;
    this.#children.delete(slug);
    this.#clearIdle(child);
    child.proc.kill("SIGKILL");
    // A fake or an already-dead process may never emit `exit`: fail what is
    // still in flight here, so no request hangs on a process nobody owns.
    this.#onExit(slug, child, reason);
  }

  #armIdle(slug, child) {
    if (child.pending.size > 0) return;
    this.#clearIdle(child);
    child.idleTimer = setTimeout(() => this.#kill(slug, "idle"), this.config.idleMs);
    child.idleTimer.unref?.();
  }

  #clearIdle(child) {
    if (!child.idleTimer) return;
    clearTimeout(child.idleTimer);
    child.idleTimer = null;
  }

  killAll() {
    for (const slug of [...this.#children.keys()]) this.#kill(slug, "shutdown");
  }
}
