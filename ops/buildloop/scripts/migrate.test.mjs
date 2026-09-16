import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `migrate-from-supabase.sh` is a bash script driving `docker compose` and
 * live Postgres clusters — nothing here is unit-testable by calling it. What
 * IS testable, and what the fix for the collaborator-lockout bug depends on,
 * is the script's own text: the flag that used to drop the SCRAM verifiers,
 * the safety net (`set -euo pipefail`), and the order that keeps a bad
 * comparison from ever reaching a `docker compose down`/port switch.
 */
const scriptPath = fileURLToPath(new URL("./migrate-from-supabase.sh", import.meta.url));
const script = readFileSync(scriptPath, "utf8");
const lines = script.split("\n");

function firstLineIndexContaining(needle) {
  const i = lines.findIndex((line) => line.includes(needle));
  assert.ok(i !== -1, `expected a line containing ${JSON.stringify(needle)}`);
  return i;
}

test("restores roles with pg_dumpall --roles-only, without --no-role-passwords", () => {
  assert.match(script, /pg_dumpall --roles-only\b/);
  assert.doesNotMatch(script, /--no-role-passwords/);
});

test("fails fast: set -euo pipefail", () => {
  assert.match(script, /^set -euo pipefail$/m);
});

test("compare-counts.mjs runs before any docker compose down or port switch", () => {
  const compareIdx = firstLineIndexContaining("compare-counts.mjs");
  const cutoverDownIdx = firstLineIndexContaining('docker compose down db && docker compose up -d');
  const oldStackDownIdx = firstLineIndexContaining('docker compose -f "$OLD_COMPOSE" down');

  assert.ok(compareIdx < cutoverDownIdx, "the row-count comparison must run before the new cluster takes the final port");
  assert.ok(compareIdx < oldStackDownIdx, "the row-count comparison must run before the old stack is torn down");
});

test("tells the operator that roles come back with their passwords", () => {
  assert.match(script, /roles restored with their passwords/);
});
