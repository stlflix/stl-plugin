import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bearerFrom, hashToken, loadTokenMap, slugForToken } from "../src/auth.js";
import { readCollaboratorEnv } from "../src/db.js";

const dir = mkdtempSync(path.join(tmpdir(), "stl-mcp-"));

test("bearerFrom accepts only a well-formed Bearer header", () => {
  assert.equal(bearerFrom("Bearer abc123"), "abc123");
  assert.equal(bearerFrom("bearer abc123"), "abc123");
  assert.equal(bearerFrom("Basic abc123"), null);
  assert.equal(bearerFrom("Bearer"), null);
  assert.equal(bearerFrom(undefined), null);
});

test("loadTokenMap rejects a file that is not a sha256 map", () => {
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ "not-a-hash": "lucas" }));
  assert.throws(() => loadTokenMap(bad), /not a sha256/);

  const badSlug = path.join(dir, "bad-slug.json");
  writeFileSync(badSlug, JSON.stringify({ [hashToken("x")]: "Lucas Melo" }));
  assert.throws(() => loadTokenMap(badSlug), /invalid slug/);

  const empty = path.join(dir, "empty.json");
  writeFileSync(empty, "{}");
  assert.throws(() => loadTokenMap(empty), /is empty/);
});

test("slugForToken maps a known token and refuses everything else", () => {
  const file = path.join(dir, "tokens.json");
  writeFileSync(file, JSON.stringify({ [hashToken("secret-lucas")]: "lucas" }));
  const map = loadTokenMap(file);

  assert.equal(slugForToken(map, "secret-lucas"), "lucas");
  assert.equal(slugForToken(map, "secret-alice"), null);
  assert.equal(slugForToken(map, ""), null);
  assert.equal(slugForToken(map, undefined), null);
});

test("readCollaboratorEnv parses the generated file and demands the required keys", () => {
  const collaborators = path.join(dir, "collaborators");
  mkdirSync(collaborators, { recursive: true });
  writeFileSync(
    path.join(collaborators, "lucas.env"),
    "# comment\nSUPABASE_DB_URL=postgres://lucas:pw@127.0.0.1:5433/db_lucas\nSUPABASE_DB_USER=lucas\nSUPABASE_DB_PASSWORD=pw\nSUPABASE_DB_NAME=db_lucas\n",
  );
  const env = readCollaboratorEnv(collaborators, "lucas");
  assert.equal(env.SUPABASE_DB_USER, "lucas");
  assert.equal(env.SUPABASE_DB_NAME, "db_lucas");

  writeFileSync(path.join(collaborators, "broken.env"), "SUPABASE_DB_USER=x\n");
  assert.throws(() => readCollaboratorEnv(collaborators, "broken"), /missing SUPABASE_DB_PASSWORD/);
});
