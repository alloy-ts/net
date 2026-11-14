import { test } from "node:test";
import assert from "node:assert/strict";
import { authConfig, availableTargets, hasToken, parseArgs, stagePackageJson } from "./publish.ts";

void test("stagePackageJson strips scripts and applies throwaway name, version and targets", () => {
  const pkg = {
    name: "repository",
    version: "0.0.0",
    scripts: { prepare: "node scripts/setup.ts", build: "node build.ts" },
    napi: { binaryName: "repository", targets: ["a", "b"] },
  };
  const out = stagePackageJson(pkg, { version: "0.0.1-ci.1", name: "@x/y", targets: ["a"] });
  assert.equal(out.scripts, undefined);
  assert.equal(out.name, "@x/y");
  assert.equal(out.version, "0.0.1-ci.1");
  assert.deepEqual(out.napi, { binaryName: "repository", packageName: "@x/y", targets: ["a"] });
  assert.ok(pkg.scripts, "the input is not modified");
});

void test("authConfig references NPM_TOKEN without embedding it", () => {
  assert.equal(
    authConfig("https://registry.npmjs.org"),
    "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n",
  );
  assert.match(authConfig("http://127.0.0.1:4873/"), /^\/\/127\.0\.0\.1:4873\/:_authToken=/m);
});

void test("hasToken ignores an unset Azure Pipelines macro", () => {
  assert.equal(hasToken(undefined), false);
  assert.equal(hasToken(""), false);
  assert.equal(hasToken("$(NPM_TOKEN)"), false);
  assert.equal(hasToken("npm_abc"), true);
});

void test("availableTargets matches addons by napi platform name", () => {
  const r = availableTargets(["x86_64-unknown-linux-gnu", "aarch64-apple-darwin"], "repository", [
    "repository.linux-x64-gnu.node",
  ]);
  assert.deepEqual(r, { present: ["x86_64-unknown-linux-gnu"], missing: ["aarch64-apple-darwin"] });
});

void test("parseArgs takes registry and tag from the environment unless flags override", () => {
  const env = { NPM_REGISTRY: "http://127.0.0.1:4873/", NPM_TAG: "next" };
  assert.deepEqual(parseArgs([], env), {
    artifacts: "artifacts",
    registry: "http://127.0.0.1:4873/",
    tag: "next",
    allowMissing: false,
    dryRun: false,
  });
  const o = parseArgs(["--tag", "ci", "--dry-run", "--allow-missing"], env);
  assert.equal(o.tag, "ci");
  assert.equal(o.dryRun, true);
  assert.equal(o.allowMissing, true);
});
