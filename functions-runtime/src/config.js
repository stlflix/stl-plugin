/**
 * The runtime's environment, read by allowlist — the same two refusals the MCP
 * server makes (I1), tightened by one: this process runs the collaborators'
 * code, so it must never hold a key that opens anything but `/admin/runtime/*`.
 * An `ADMIN_KEY`, a `CREDENTIALS_KEY` or anything `*PRIVATE*` in this container
 * means the wiring is wrong, and the process refuses to start naming it.
 */
import { createPublicKey } from "node:crypto";

export const ALLOWED_ENV = [
  "PORT",
  "MCP_URL",
  "RUNTIME_KEY",
  "DB_HOST",
  "DB_PORT",
  "AUTH_PUBLIC_KEY",
  "RATE_LIMIT_PER_MIN",
  "INVOKE_TIMEOUT_MS",
  "CHILD_MAX_MB",
  "IDLE_MS",
];

/**
 * `PRIVATE` is what keeps `BUILDLOOP_AUTH_PRIVATE_KEY` out: the signing key
 * lives on the platform and nowhere else (I6), so a runtime that held it could
 * mint the identity it is supposed to only verify.
 */
export const FORBIDDEN_ENV_PATTERN = /ADMIN_KEY|CREDENTIALS_KEY|N8N|PLATFORM|PRIVATE/i;

export const REQUIRED_ENV = ["MCP_URL", "RUNTIME_KEY", "AUTH_PUBLIC_KEY"];

export const DEFAULTS = {
  PORT: 8300,
  DB_HOST: "db",
  DB_PORT: 5432,
  RATE_LIMIT_PER_MIN: 120,
  INVOKE_TIMEOUT_MS: 10_000,
  CHILD_MAX_MB: 128,
  IDLE_MS: 60_000,
};

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function integer(name, value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ConfigError(`${name} must be a positive integer`);
  return parsed;
}

export function loadConfig(env = process.env) {
  const forbidden = Object.keys(env)
    .filter((name) => FORBIDDEN_ENV_PATTERN.test(name))
    .sort();
  if (forbidden.length > 0) {
    throw new ConfigError(
      `refusing to start: ${forbidden.join(", ")} must not exist in this container — the runtime executes collaborator code and holds no key but its own`,
    );
  }
  for (const name of REQUIRED_ENV) {
    if (!env[name]) throw new ConfigError(`${name} is required`);
  }

  // Parsed at boot: a public key that does not parse is a runtime that would
  // answer 401 to every signed request and a JWKS of nothing.
  let authPublicKey;
  try {
    // A PEM is several lines and a .env value is one: `gen-env.py` escapes the
    // newlines. Compose usually un-escapes them on the way in — usually, so the
    // value is normalised here too and both shapes load.
    authPublicKey = createPublicKey(env.AUTH_PUBLIC_KEY.replace(/\\n/g, "\n"));
  } catch (err) {
    throw new ConfigError(`AUTH_PUBLIC_KEY is not a public key in PEM form: ${err.message}`);
  }

  return {
    port: integer("PORT", env.PORT, DEFAULTS.PORT),
    mcpUrl: env.MCP_URL.replace(/\/+$/, ""),
    runtimeKey: env.RUNTIME_KEY,
    dbHost: env.DB_HOST ?? DEFAULTS.DB_HOST,
    dbPort: integer("DB_PORT", env.DB_PORT, DEFAULTS.DB_PORT),
    authPublicKey,
    rateLimitPerMin: integer("RATE_LIMIT_PER_MIN", env.RATE_LIMIT_PER_MIN, DEFAULTS.RATE_LIMIT_PER_MIN),
    invokeTimeoutMs: integer("INVOKE_TIMEOUT_MS", env.INVOKE_TIMEOUT_MS, DEFAULTS.INVOKE_TIMEOUT_MS),
    childMaxMb: integer("CHILD_MAX_MB", env.CHILD_MAX_MB, DEFAULTS.CHILD_MAX_MB),
    idleMs: integer("IDLE_MS", env.IDLE_MS, DEFAULTS.IDLE_MS),
  };
}
