import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { DESCRIBE_SQL, LIST_TABLES_SQL, POLICIES_SQL } from "../src/catalog.js";

test("the table listing carries a planner estimate, unknown when never analyzed", () => {
  assert.match(LIST_TABLES_SQL, /AS estimated_rows/);
  assert.match(LIST_TABLES_SQL, /reltuples < 0 THEN NULL/);
  assert.match(LIST_TABLES_SQL, /NOT IN \('pg_catalog', 'information_schema', 'pg_toast'\)/);
  assert.match(DESCRIBE_SQL, /to_regclass\(\$1\)/);
  assert.match(POLICIES_SQL, /pg_policies/);
});

test("tools.js consumes the catalog instead of defining its own copy", () => {
  const source = readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");
  assert.match(source, /from "\.\/catalog\.js"/);
  assert.doesNotMatch(source, /const LIST_TABLES_SQL|const DESCRIBE_SQL|const POLICIES_SQL/);
});
