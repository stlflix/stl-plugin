import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { ALLOWED_ENV, ConfigError, DEFAULTS, loadConfig } from "../src/config.js";

const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" });

const base = {
  MCP_URL: "http://mcp:8200/",
  RUNTIME_KEY: "r".repeat(32),
  AUTH_PUBLIC_KEY: PUBLIC_PEM,
};

test("an environment that mentions the platform or an admin key stops the boot, naming it", () => {
  for (const name of [
    "ADMIN_KEY",
    "CREDENTIALS_KEY",
    "N8N_WEBHOOK_URL",
    "PLATFORM_DB_URL",
    "BUILDLOOP_AUTH_PRIVATE_KEY",
  ]) {
    assert.throws(
      () => loadConfig({ ...base, [name]: "x" }),
      (err) => err instanceof ConfigError && err.message.includes(name),
      name,
    );
  }
});

test("the three required variables are required, each named on its own", () => {
  for (const name of ["MCP_URL", "RUNTIME_KEY", "AUTH_PUBLIC_KEY"]) {
    const env = { ...base };
    delete env[name];
    assert.throws(() => loadConfig(env), new RegExp(`${name} is required`), name);
  }
  assert.throws(() => loadConfig({ ...base, AUTH_PUBLIC_KEY: "not a key" }), /AUTH_PUBLIC_KEY is not a public key/);
});

test("everything outside the allowlist is ignored, and the limits have defaults", () => {
  const config = loadConfig({ ...base, HOME: "/root", NODE_ENV: "production" });
  assert.equal(config.port, DEFAULTS.PORT);
  assert.equal(config.dbHost, DEFAULTS.DB_HOST);
  assert.equal(config.rateLimitPerMin, 120);
  assert.equal(config.invokeTimeoutMs, 10_000);
  assert.equal(config.childMaxMb, 128);
  assert.equal(config.idleMs, 60_000);
  assert.equal(config.mcpUrl, "http://mcp:8200", "the trailing slash is dropped so a path can be appended");
  assert.equal(config.authPublicKey.asymmetricKeyType, "ec");
  assert.deepEqual(Object.keys(config).sort(), [
    "authPublicKey",
    "childMaxMb",
    "dbHost",
    "dbPort",
    "idleMs",
    "invokeTimeoutMs",
    "mcpUrl",
    "port",
    "rateLimitPerMin",
    "runtimeKey",
  ]);
  assert.equal(ALLOWED_ENV.length, 10);
});

test("a limit that is not a positive integer is refused by name", () => {
  for (const name of ["PORT", "DB_PORT", "RATE_LIMIT_PER_MIN", "INVOKE_TIMEOUT_MS", "CHILD_MAX_MB", "IDLE_MS"]) {
    assert.throws(() => loadConfig({ ...base, [name]: "0" }), new RegExp(`${name} must be a positive integer`), name);
    assert.throws(() => loadConfig({ ...base, [name]: "many" }), new RegExp(`${name} must be a positive integer`), name);
  }
  assert.equal(loadConfig({ ...base, PORT: "9000" }).port, 9000);
});
