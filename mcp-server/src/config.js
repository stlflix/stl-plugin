/**
 * The server's environment, read by allowlist (I1). Two rules, both refusals:
 * nothing outside the list below is read at all, and the process refuses to
 * start if the environment so much as MENTIONS the platform — an `N8N_*`, a
 * `PLATFORM_*`, a `JWT_SECRET` in this container means the wiring is wrong, and
 * a BuildLoop that can reach the platform's database is the one thing this
 * design exists to prevent.
 */
import { loadKey } from "./crypto.js";

export const ALLOWED_ENV = [
  "PORT",
  "DB_HOST",
  "DB_PORT",
  "STATEMENT_TIMEOUT_MS",
  "ADMIN_DB_URL",
  "ADMIN_KEY",
  "RUNTIME_KEY",
  "CREDENTIALS_KEY",
  "FUNCTIONS_URL",
];

export const FORBIDDEN_ENV_PATTERN = /N8N|PLATFORM|PRODUCTOPS|JWT_SECRET/i;

export const REQUIRED_ENV = ["ADMIN_DB_URL", "ADMIN_KEY", "RUNTIME_KEY", "CREDENTIALS_KEY"];

export const DEFAULTS = {
  PORT: 8200,
  DB_HOST: "db",
  DB_PORT: 5432,
  STATEMENT_TIMEOUT_MS: 30_000,
  FUNCTIONS_URL: "http://functions:8300",
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
      `refusing to start: ${forbidden.join(", ")} must not exist in this container — the BuildLoop cluster never reaches the platform`,
    );
  }
  for (const name of REQUIRED_ENV) {
    if (!env[name]) throw new ConfigError(`${name} is required`);
  }
  return {
    port: integer("PORT", env.PORT, DEFAULTS.PORT),
    dbHost: env.DB_HOST ?? DEFAULTS.DB_HOST,
    dbPort: integer("DB_PORT", env.DB_PORT, DEFAULTS.DB_PORT),
    statementTimeoutMs: integer("STATEMENT_TIMEOUT_MS", env.STATEMENT_TIMEOUT_MS, DEFAULTS.STATEMENT_TIMEOUT_MS),
    adminDbUrl: env.ADMIN_DB_URL,
    adminKey: env.ADMIN_KEY,
    runtimeKey: env.RUNTIME_KEY,
    credentialsKey: loadKey(env.CREDENTIALS_KEY),
    functionsUrl: (env.FUNCTIONS_URL ?? DEFAULTS.FUNCTIONS_URL).replace(/\/+$/, ""),
  };
}
