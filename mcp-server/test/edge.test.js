import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { decrypt } from "../src/crypto.js";
import {
  CompileError,
  InvalidFunctionInput,
  UnknownFunction,
  bundleFor,
  compile,
  list,
  logs,
  publish,
  save,
  secretKeys,
  setSecrets,
} from "../src/edge.js";

const KEY = Buffer.alloc(32, 7);

/**
 * The `buildloop` schema of one collaborator's database, in memory: enough for
 * a version to really advance and for a secret to really be written, so the
 * tests judge the outcome and not the SQL.
 */
function database({ functions = [], versions = [], secrets = [], invocations = [] } = {}) {
  const state = { functions: [...functions], versions: [...versions], secrets: [...secrets], invocations: [...invocations] };
  const statements = [];
  const run = async (sql, params = []) => {
    statements.push(sql);
    if (sql.includes("INSERT INTO buildloop.edge_functions")) {
      const row = state.functions.find((f) => f.name === params[0]);
      if (row) row.updated_at = "now";
      else state.functions.push({ name: params[0], current_version: 0, updated_at: "now" });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO buildloop.edge_function_versions")) {
      const [name, version, source, bundle] = params;
      const row = state.versions.find((v) => v.name === name && v.version === version);
      if (row) Object.assign(row, { source, bundle: bundle ?? "" });
      else state.versions.push({ name, version, source, bundle: bundle ?? "" });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE buildloop.edge_functions SET current_version")) {
      const row = state.functions.find((f) => f.name === params[0]);
      row.current_version = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT source FROM buildloop.edge_function_versions")) {
      return { rows: state.versions.filter((v) => v.name === params[0] && v.version === params[1]).map((v) => ({ source: v.source })) };
    }
    if (sql.includes("SELECT current_version FROM buildloop.edge_functions")) {
      return { rows: state.functions.filter((f) => f.name === params[0]).map((f) => ({ current_version: f.current_version })) };
    }
    if (sql.includes("INSERT INTO buildloop.edge_function_secrets")) {
      const [name, key, valueEnc] = params;
      const row = state.secrets.find((s) => s.name === name && s.key === key);
      if (row) row.value_enc = valueEnc;
      else state.secrets.push({ name, key, value_enc: valueEnc });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM buildloop.edge_function_secrets")) {
      state.secrets = state.secrets.filter((s) => !(s.name === params[0] && s.key === params[1]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT key FROM buildloop.edge_function_secrets")) {
      return { rows: state.secrets.filter((s) => s.name === params[0]).map((s) => ({ key: s.key })).sort((a, b) => a.key.localeCompare(b.key)) };
    }
    if (sql.includes("SELECT key, value_enc FROM buildloop.edge_function_secrets")) {
      return { rows: state.secrets.filter((s) => s.name === params[0]).sort((a, b) => a.key.localeCompare(b.key)) };
    }
    if (sql.includes("JOIN buildloop.edge_function_versions v") && !sql.includes("array_agg")) {
      const fn = state.functions.find((f) => f.name === params[0] && f.current_version > params[1]);
      if (!fn) return { rows: [] };
      const version = state.versions.find((v) => v.name === fn.name && v.version === fn.current_version);
      return { rows: version ? [{ current_version: fn.current_version, bundle: version.bundle }] : [] };
    }
    if (sql.includes("FROM buildloop.invocations")) {
      return { rows: state.invocations.filter((i) => i.name === params[0]) };
    }
    if (sql.includes("FROM buildloop.edge_functions f")) {
      return {
        rows: [...state.functions].sort((a, b) => a.name.localeCompare(b.name)).map((f) => ({
          name: f.name,
          current_version: f.current_version,
          updated_at: f.updated_at,
          published_at: state.versions.find((v) => v.name === f.name && v.version === f.current_version)?.created_at ?? null,
          secret_keys: state.secrets.filter((s) => s.name === f.name).map((s) => s.key).sort(),
        })),
      };
    }
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    throw new Error(`unexpected query: ${sql.slice(0, 50)}`);
  };
  const pool = {
    query: (sql, params) => run(sql, params),
    connect: async () => ({ query: (sql, params) => run(sql, params), release() {} }),
  };
  return { pool, state, statements };
}

const HELLO = 'export default () => new Response("hi")';

test("save refuses a name outside the pattern without touching the database", async () => {
  const { pool, statements } = database();
  for (const name of ["Hello", "1hello", "h", "hello_world", "a".repeat(42), "hello;drop", 7, undefined]) {
    await assert.rejects(save(pool, name, HELLO), InvalidFunctionInput, String(name));
  }
  assert.deepEqual(statements, []);
});

test("save refuses an empty or oversized source without touching the database", async () => {
  const { pool, statements } = database();
  for (const source of ["", "   ", 42, null, "x".repeat(256 * 1024 + 1)]) {
    await assert.rejects(save(pool, "hello", source), InvalidFunctionInput, String(source).slice(0, 12));
  }
  assert.deepEqual(statements, []);
});

test("save upserts the function and keeps the source as the draft, in one transaction", async () => {
  const { pool, state, statements } = database();
  assert.deepEqual(await save(pool, "hello", HELLO), { name: "hello", saved: true });
  assert.deepEqual(state.functions.map((f) => [f.name, f.current_version]), [["hello", 0]]);
  assert.deepEqual(state.versions.map((v) => [v.version, v.source]), [[0, HELLO]]);
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements.at(-1), "COMMIT");

  await save(pool, "hello", "export default () => new Response('bye')");
  assert.equal(state.versions.length, 1, "the draft is rewritten, not multiplied");
  assert.match(state.versions[0].source, /bye/);
});

test("publish compiles the draft into an ESM bundle a runtime can import, and advances the version", async () => {
  const { pool, state } = database();
  await save(pool, "hello", HELLO);
  assert.deepEqual(await publish(pool, "hello"), { name: "hello", version: 1, bytes: state.versions.find((v) => v.version === 1).bundle.length });
  assert.equal(state.functions[0].current_version, 1);

  const dir = mkdtempSync(join(tmpdir(), "edge-test-"));
  try {
    const file = join(dir, "hello-v1.mjs");
    writeFileSync(file, state.versions.find((v) => v.version === 1).bundle, "utf8");
    const module = await import(pathToFileURL(file).href);
    assert.equal(typeof module.default, "function");
    assert.equal(await (await module.default(new Request("http://x/"))).text(), "hi");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  await publish(pool, "hello");
  assert.equal(state.functions[0].current_version, 2, "every publish is a new version");
});

test("a source that does not compile throws CompileError with line and column, and the live version stays put", async () => {
  const { pool, state } = database();
  await save(pool, "hello", HELLO);
  await publish(pool, "hello");
  await save(pool, "hello", "export default (");
  await assert.rejects(publish(pool, "hello"), (err) => {
    assert.ok(err instanceof CompileError);
    assert.equal(err.line, 1);
    assert.equal(err.column, 16);
    assert.match(err.text, /Unexpected end of file/);
    assert.match(err.message, /1:16/);
    return true;
  });
  assert.equal(state.functions[0].current_version, 1, "the version that was live is still live");
  assert.equal(state.versions.filter((v) => v.version > 0).length, 1, "no version was written");
});

test("publish of a name that was never saved says so without compiling anything", async () => {
  const { pool } = database();
  await assert.rejects(publish(pool, "ghost"), (err) => {
    assert.ok(err instanceof UnknownFunction);
    assert.match(err.message, /no edge function named 'ghost'/);
    return true;
  });
});

test("compile turns TypeScript into one module, types and all", async () => {
  const bundle = await compile("const greet = (who: string): string => `hi ${who}`;\nexport default () => new Response(greet('x'))", "hello");
  assert.match(bundle, /export \{/);
  assert.doesNotMatch(bundle, /: string/, "the types are gone");
});

test("setSecrets stores the value encrypted and answers only the keys", async () => {
  const { pool, state } = database();
  const out = await setSecrets(pool, "hello", { STRIPE_KEY: "sk_live_x", OTHER: "b" }, KEY);
  assert.deepEqual(out, { name: "hello", keys: ["OTHER", "STRIPE_KEY"] });
  const stored = state.secrets.find((s) => s.key === "STRIPE_KEY");
  assert.notEqual(stored.value_enc, "sk_live_x");
  assert.equal(decrypt(stored.value_enc, KEY), "sk_live_x");
  assert.ok(!JSON.stringify(out).includes("sk_live_x"), "no read path ever answers a value");
});

test("setSecrets overwrites a key and removes the one set to null", async () => {
  const { pool, state } = database();
  await setSecrets(pool, "hello", { A: "1", B: "2" }, KEY);
  await setSecrets(pool, "hello", { A: "3", B: null }, KEY);
  assert.deepEqual(await secretKeys(pool, "hello"), ["A"]);
  assert.equal(decrypt(state.secrets.find((s) => s.key === "A").value_enc, KEY), "3");
});

test("setSecrets refuses a bad key, a bad value or an empty set without touching the database", async () => {
  const { pool, statements } = database();
  for (const entries of [{ "lower": "x" }, { "A-B": "x" }, { A: 7 }, {}, [], null, "A=1"]) {
    await assert.rejects(setSecrets(pool, "hello", entries, KEY), InvalidFunctionInput, JSON.stringify(entries));
  }
  assert.deepEqual(statements, []);
});

test("bundleFor answers the live bundle with the secrets decrypted, and nothing before the first publish", async () => {
  const { pool } = database();
  await save(pool, "hello", HELLO);
  await setSecrets(pool, "hello", { TOKEN: "t0p" }, KEY);
  assert.equal(await bundleFor(pool, "hello", KEY), null, "a draft is not served");

  await publish(pool, "hello");
  const live = await bundleFor(pool, "hello", KEY);
  assert.equal(live.version, 1);
  assert.match(live.bundle, /new Response\("hi"\)/);
  assert.deepEqual(live.secrets, { TOKEN: "t0p" });
});

test("logs answer the last invocations, newest first, shaped for the panel", async () => {
  const { pool, statements } = database({
    invocations: [
      { name: "hello", at: "2026-09-16T10:00:00Z", version: 2, status: 200, duration_ms: 12, log: ["hi"], error: null },
      { name: "hello", at: "2026-09-16T09:00:00Z", version: 1, status: 500, duration_ms: 4, log: null, error: "boom" },
    ],
  });
  const rows = await logs(pool, "hello");
  assert.deepEqual(rows, [
    { at: "2026-09-16T10:00:00Z", version: 2, status: 200, durationMs: 12, log: ["hi"], error: null },
    { at: "2026-09-16T09:00:00Z", version: 1, status: 500, durationMs: 4, log: [], error: "boom" },
  ]);
  assert.match(statements.at(-1), /ORDER BY at DESC, id DESC LIMIT 200/);
});

test("list answers every function with its live version and the keys of its secrets", async () => {
  const { pool } = database();
  await save(pool, "hello", HELLO);
  await publish(pool, "hello");
  await setSecrets(pool, "hello", { TOKEN: "t0p" }, KEY);
  await save(pool, "draft-only", HELLO);
  const all = await list(pool);
  assert.deepEqual(all.map((f) => [f.name, f.currentVersion, f.secretKeys]), [
    ["draft-only", 0, []],
    ["hello", 1, ["TOKEN"]],
  ]);
  assert.ok(!JSON.stringify(all).includes("t0p"));
});
