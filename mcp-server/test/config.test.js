import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOWED_ENV, ConfigError, DEFAULTS, loadConfig } from "../src/config.js";

const KEY = "a".repeat(64);
const MINIMAL = {
  ADMIN_DB_URL: "postgres://buildloop_admin:pw@db:5432/postgres",
  ADMIN_KEY: "k".repeat(32),
  RUNTIME_KEY: "r".repeat(32),
  CREDENTIALS_KEY: KEY,
};

test("an env that belongs to the platform stops the server, and is named", () => {
  for (const [name, value] of [
    ["N8N_URL", "https://n8n.example"],
    ["PLATFORM_DB_URL", "postgres://x"],
    ["PRODUCTOPS_API", "https://ops.example"],
    ["JWT_SECRET", "s"],
    ["n8n_webhook", "x"],
  ]) {
    assert.throws(() => loadConfig({ ...MINIMAL, [name]: value }), (err) => {
      assert.ok(err instanceof ConfigError, name);
      assert.match(err.message, new RegExp(name), "the offending env is named");
      return true;
    }, name);
  }
});

test("a required env that is missing stops the server, and is named", () => {
  for (const name of ["ADMIN_DB_URL", "ADMIN_KEY", "RUNTIME_KEY", "CREDENTIALS_KEY"]) {
    const env = { ...MINIMAL };
    delete env[name];
    assert.throws(() => loadConfig(env), new RegExp(`${name} is required`), name);
  }
});

test("the loader reads the allowlist and ignores everything else in the environment", () => {
  const config = loadConfig({ ...MINIMAL, HOME: "/root", PATH: "/usr/bin", TERM: "xterm", SHLVL: "1" });
  assert.deepEqual(Object.keys(config).sort(), [
    "adminDbUrl", "adminKey", "credentialsKey", "dbHost", "dbPort", "functionsUrl", "port", "runtimeKey", "statementTimeoutMs",
  ]);
  assert.equal(config.port, DEFAULTS.PORT);
  assert.equal(config.dbHost, DEFAULTS.DB_HOST);
  assert.equal(config.dbPort, DEFAULTS.DB_PORT);
  assert.equal(config.statementTimeoutMs, DEFAULTS.STATEMENT_TIMEOUT_MS);
  assert.equal(config.functionsUrl, DEFAULTS.FUNCTIONS_URL);
  assert.ok(ALLOWED_ENV.includes("RUNTIME_KEY"));
  assert.ok(!ALLOWED_ENV.some((name) => /N8N|PLATFORM|PRODUCTOPS|JWT_SECRET/i.test(name)));
});

test("what the allowlist does read is read: ports, host, timeout and the functions URL", () => {
  const config = loadConfig({
    ...MINIMAL,
    PORT: "9000",
    DB_HOST: "postgres",
    DB_PORT: "5433",
    STATEMENT_TIMEOUT_MS: "5000",
    FUNCTIONS_URL: "https://db.stlflix.com.br/",
  });
  assert.equal(config.port, 9000);
  assert.equal(config.dbHost, "postgres");
  assert.equal(config.dbPort, 5433);
  assert.equal(config.statementTimeoutMs, 5000);
  assert.equal(config.functionsUrl, "https://db.stlflix.com.br", "no trailing slash to double when a path is joined");
});

test("a number that is not one, and a credentials key that is not 32 bytes, are refused", () => {
  for (const env of [{ PORT: "no" }, { PORT: "0" }, { DB_PORT: "-1" }, { STATEMENT_TIMEOUT_MS: "1.5" }]) {
    assert.throws(() => loadConfig({ ...MINIMAL, ...env }), ConfigError, JSON.stringify(env));
  }
  assert.throws(() => loadConfig({ ...MINIMAL, CREDENTIALS_KEY: "short" }), /64 hex characters/);
});

test("the two keys are separate values, and both are carried", () => {
  const config = loadConfig(MINIMAL);
  assert.equal(config.adminKey, MINIMAL.ADMIN_KEY);
  assert.equal(config.runtimeKey, MINIMAL.RUNTIME_KEY);
  assert.notEqual(config.adminKey, config.runtimeKey);
  assert.ok(Buffer.isBuffer(config.credentialsKey));
});
