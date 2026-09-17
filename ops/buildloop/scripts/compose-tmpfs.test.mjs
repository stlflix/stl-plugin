import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `docker compose config` only parses the YAML — it never checks whether a
 * tmpfs mount is actually usable by the process running inside it. A tmpfs
 * created by Docker is owned by root, so a service whose Dockerfile drops to
 * a non-root USER needs its tmpfs mounts to name `uid=`/`gid=` explicitly, or
 * the process gets EACCES the moment it tries to write there. This is the
 * sensor that closes that gap.
 */
const dockerfilePath = fileURLToPath(
  new URL("../../../functions-runtime/Dockerfile", import.meta.url),
);
const composePath = fileURLToPath(new URL("../docker-compose.yml", import.meta.url));

function dockerfileUser(dockerfileText) {
  const match = dockerfileText.match(/^USER\s+(\S+)\s*$/m);
  return match ? match[1] : "root";
}

function functionsVarFnTmpfsLine(composeText) {
  const lines = composeText.split("\n");
  const functionsIdx = lines.findIndex((line) => /^\s{2}functions:\s*$/.test(line));
  assert.ok(functionsIdx !== -1, "expected a top-level `functions:` service");

  const nextServiceIdx = lines.findIndex(
    (line, i) => i > functionsIdx && /^\s{2}\S.*:\s*$/.test(line),
  );
  const serviceEnd = nextServiceIdx === -1 ? lines.length : nextServiceIdx;

  const tmpfsIdx = lines.findIndex(
    (line, i) => i > functionsIdx && i < serviceEnd && /^\s*tmpfs:\s*$/.test(line),
  );
  assert.ok(tmpfsIdx !== -1, "expected a `tmpfs:` block under the `functions:` service");

  const varFnLine = lines
    .slice(tmpfsIdx + 1, serviceEnd)
    .find((line) => line.includes("/var/fn"));
  assert.ok(varFnLine, "expected a `/var/fn` tmpfs mount under `functions:`");
  return varFnLine;
}

function namesOwner(tmpfsLine) {
  return /\buid=\d+\b/.test(tmpfsLine) && /\bgid=\d+\b/.test(tmpfsLine);
}

test("functions-runtime Dockerfile drops to a non-root USER", () => {
  const dockerfile = readFileSync(dockerfilePath, "utf8");
  assert.notEqual(dockerfileUser(dockerfile), "root");
});

test("/var/fn tmpfs names uid and gid matching the non-root USER, because a Docker tmpfs is born root-owned", () => {
  const dockerfile = readFileSync(dockerfilePath, "utf8");
  const compose = readFileSync(composePath, "utf8");
  assert.notEqual(
    dockerfileUser(dockerfile),
    "root",
    "this assertion only applies to a service whose Dockerfile is non-root",
  );

  const varFnLine = functionsVarFnTmpfsLine(compose);
  // Same predicate the negative test below drives, so the proof that it catches
  // a bad mount is a proof about the check this test actually runs.
  assert.equal(namesOwner(varFnLine), true, varFnLine);
  // `USER node` is a name; uid 1000 is what it resolves to in node:22-alpine,
  // and the compose can only name the number.
  assert.match(varFnLine, /\buid=1000\b/);
  assert.match(varFnLine, /\bgid=1000\b/);
});

test("/var/fn keeps mode=1700 — the fix must not have loosened it to 1777", () => {
  const compose = readFileSync(composePath, "utf8");
  const varFnLine = functionsVarFnTmpfsLine(compose);
  assert.match(varFnLine, /\bmode=1700\b/);
});

test("the owner check actually rejects a tmpfs mount with no uid/gid", () => {
  const badCompose = [
    "services:",
    "  functions:",
    "    image: stl-buildloop-functions:0.1.0",
    "    tmpfs:",
    "      - /var/fn:mode=1700,size=64m",
    "      - /tmp:mode=1777,size=16m",
    "  mcp:",
    "    image: stl-buildloop-mcp:0.4.0",
    "",
  ].join("\n");

  const varFnLine = functionsVarFnTmpfsLine(badCompose);
  assert.equal(namesOwner(varFnLine), false, "a mount with no uid=/gid= must be reported as unowned");
});
