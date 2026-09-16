import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InvalidObjectName,
  OBJECT_NAME_PATTERN,
  POLICY_COMMANDS,
  RLS_MODES,
  assertObjectName,
  createPolicySql,
  dropPolicySql,
  qualifiedName,
  quoteIdent,
  setRlsSql,
} from "../src/policy-sql.js";

test("quoteIdent doubles an embedded quote, so an identifier is exactly what was named", () => {
  assert.equal(quoteIdent("notes"), '"notes"');
  assert.equal(quoteIdent("My Table"), '"My Table"');
  assert.equal(quoteIdent('say "hi"'), '"say ""hi"""');
  for (const bad of ["", 42, null, undefined]) {
    assert.throws(() => quoteIdent(bad), InvalidObjectName, String(bad));
  }
});

test("assertObjectName accepts the pattern the tools promise and refuses everything else", () => {
  assert.equal(OBJECT_NAME_PATTERN.source, "^[a-z_][a-z0-9_]{0,62}$");
  for (const good of ["notes", "_private", "a", "x9_y", "a".repeat(63)]) {
    assert.equal(assertObjectName("table", good), good);
  }
  for (const bad of ["Notes", "9notes", "my table", "notes;drop", "", "a".repeat(64), null, 7]) {
    assert.throws(() => assertObjectName("table", bad), InvalidObjectName, String(bad));
  }
  assert.equal(qualifiedName({ table: "notes" }), '"public"."notes"', "public is the default schema");
  assert.equal(qualifiedName({ schema: "app", table: "notes" }), '"app"."notes"');
});

test("setRlsSql writes the four states row level security can be in", () => {
  assert.deepEqual(Object.keys(RLS_MODES), ["enable", "disable", "force", "noforce"]);
  assert.equal(setRlsSql({ table: "notes", mode: "enable" }), 'ALTER TABLE "public"."notes" ENABLE ROW LEVEL SECURITY');
  assert.equal(setRlsSql({ table: "notes", mode: "disable" }), 'ALTER TABLE "public"."notes" DISABLE ROW LEVEL SECURITY');
  assert.equal(setRlsSql({ schema: "app", table: "notes", mode: "force" }), 'ALTER TABLE "app"."notes" FORCE ROW LEVEL SECURITY');
  assert.equal(setRlsSql({ table: "notes", mode: "noforce" }), 'ALTER TABLE "public"."notes" NO FORCE ROW LEVEL SECURITY');
});

test("setRlsSql refuses an unknown mode and a name outside the pattern", () => {
  assert.throws(() => setRlsSql({ table: "notes", mode: "on" }), /mode must be one of/);
  assert.throws(() => setRlsSql({ table: "notes; drop", mode: "enable" }), InvalidObjectName);
  assert.throws(() => setRlsSql({ schema: "Public", table: "notes", mode: "enable" }), InvalidObjectName);
});

test("createPolicySql writes the whole statement, in this order", () => {
  assert.equal(
    createPolicySql({
      schema: "public",
      table: "notes",
      name: "owner_only",
      command: "select",
      roles: ["alice_authenticated", "alice_anon"],
      using: " user_id = auth.uid() ",
    }),
    'CREATE POLICY "owner_only" ON "public"."notes" AS PERMISSIVE FOR SELECT TO "alice_authenticated", "alice_anon" USING (user_id = auth.uid())',
  );
  assert.equal(
    createPolicySql({ table: "notes", name: "writes", command: "INSERT", roles: ["alice_authenticated"], withCheck: "user_id = auth.uid()", permissive: false }),
    'CREATE POLICY "writes" ON "public"."notes" AS RESTRICTIVE FOR INSERT TO "alice_authenticated" WITH CHECK (user_id = auth.uid())',
  );
});

test("createPolicySql defaults to ALL, omits the clauses it was not given, and refuses the rest", () => {
  assert.deepEqual(POLICY_COMMANDS, ["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"]);
  assert.equal(
    createPolicySql({ table: "notes", name: "everyone", roles: ["alice_anon"] }),
    'CREATE POLICY "everyone" ON "public"."notes" AS PERMISSIVE FOR ALL TO "alice_anon"',
  );
  assert.throws(() => createPolicySql({ table: "notes", name: "p", roles: ["a"], command: "TRUNCATE" }), /command must be one of/);
  assert.throws(() => createPolicySql({ table: "notes", name: "p", roles: [] }), /roles must be a non-empty array/);
  assert.throws(() => createPolicySql({ table: "notes", name: "p", roles: "alice_anon" }), /roles must be a non-empty array/);
  assert.throws(() => createPolicySql({ table: "notes", name: "P", roles: ["a"] }), InvalidObjectName);
  assert.throws(() => createPolicySql({ table: "notes", name: "p", roles: ["Alice; drop"] }), InvalidObjectName);
  assert.throws(() => createPolicySql({ table: "notes", name: "p", roles: ["a"], using: "  " }), /using must be a non-empty SQL expression/);
});

test("dropPolicySql names the policy and the table it belongs to", () => {
  assert.equal(dropPolicySql({ table: "notes", name: "owner_only" }), 'DROP POLICY "owner_only" ON "public"."notes"');
  assert.equal(dropPolicySql({ schema: "app", table: "notes", name: "owner_only" }), 'DROP POLICY "owner_only" ON "app"."notes"');
  assert.throws(() => dropPolicySql({ table: "notes", name: "owner only" }), InvalidObjectName);
});
