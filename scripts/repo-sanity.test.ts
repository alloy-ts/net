import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkManifest, collectInput, normalizeRemote, type CheckInput } from "./repo-sanity.ts";

const MANIFEST = `name: engine
version: 0.0.0
type: module
owner: alloy-ts
description: test
config:
  - user.signingKey: ssh-ed25519 AAAA:key
  - commit.gpgsign: true
  - core.hooksPath: scripts/hooks/_
remote:
  - https://repo.chen.software/alloy-ts/engine
  - https://dev.azure.com/ChenSoftware/alloy-ts/_git/engine
`;

function config(extra: Record<string, string> = {}): Map<string, string[]> {
  const entries: Record<string, string> = {
    "user.signingkey": "ssh-ed25519 AAAA:key",
    "commit.gpgsign": "true",
    "core.hookspath": "scripts/hooks/_",
    "remote.origin.url": "https://user:secret@dev.azure.com/ChenSoftware/alloy-ts/_git/engine",
    ...extra,
  };
  return new Map(Object.entries(entries).map(([k, v]) => [k, [v]]));
}

function input(over: Partial<CheckInput> = {}): CheckInput {
  return {
    manifestText: MANIFEST,
    gitConfig: config(),
    staged: ["src/lib.rs"],
    hasHead: true,
    authorEmail: "yumin@chen.software",
    committerEmail: "yumin@chen.software",
    ...over,
  };
}

void test("a consistent repository passes", () => {
  assert.deepEqual(checkManifest(input()), { errors: [], warnings: [] });
});

void test("normalizeRemote drops credentials, scheme, git+ and .git", () => {
  const want = "dev.azure.com/chensoftware/alloy-ts/_git/engine";
  assert.equal(
    normalizeRemote("https://u:tok@dev.azure.com/ChenSoftware/alloy-ts/_git/engine"),
    want,
  );
  assert.equal(
    normalizeRemote("git+https://dev.azure.com/ChenSoftware/alloy-ts/_git/engine.git/"),
    want,
  );
  assert.equal(normalizeRemote("git@github.com:alloy-ts/engine.git"), "github.com/alloy-ts/engine");
});

void test("a missing manifest is an error", () => {
  assert.match(checkManifest(input({ manifestText: undefined })).errors.join(), /not found/);
});

void test("config that differs from the manifest is an error", () => {
  const { errors } = checkManifest(
    input({ gitConfig: config({ "commit.gpgsign": "false", "core.hookspath": ".husky" }) }),
  );
  assert.equal(errors.length, 2);
  const missing = config();
  missing.delete("user.signingkey");
  assert.match(
    checkManifest(input({ gitConfig: missing })).errors.join(),
    /user.signingKey is not set/,
  );
});

void test("boolean config values compare by meaning", () => {
  assert.deepEqual(
    checkManifest(input({ gitConfig: config({ "commit.gpgsign": "yes" }) })).errors,
    [],
  );
});

void test("a remote outside the manifest is an error and never shows credentials", () => {
  const { errors } = checkManifest(
    input({
      gitConfig: config({
        "remote.origin.url": "https://x:secret@dev.azure.com/ChenSoftware/init/_git/init",
      }),
    }),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /remote "origin" url dev.azure.com\/chensoftware\/init\/_git\/init/);
  assert.doesNotMatch(errors[0]!, /secret/);
});

void test("template clones downgrade identity mismatches to warnings", () => {
  const result = checkManifest(
    input({
      gitConfig: config({
        "remote.origin.url": "https://dev.azure.com/ChenSoftware/init/_git/init",
        "manifest.template": "true",
      }),
    }),
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
});

void test("staging the manifest after the root commit is an error", () => {
  const { errors } = checkManifest(input({ staged: ["repo.manifest.yml", "src/lib.rs"] }));
  assert.match(errors.join(), /only the root commit may change it/);
});

void test("the root commit must hold only the manifest, from the repo identity", () => {
  const ok = {
    hasHead: false,
    authorEmail: "repo@chen.software",
    committerEmail: "Repository@chen.software",
  };
  assert.deepEqual(checkManifest(input({ ...ok, staged: ["repo.manifest.yml"] })).errors, []);
  const { errors } = checkManifest(
    input({
      ...ok,
      staged: ["repo.manifest.yml", "package.json"],
      authorEmail: "yumin@chen.software",
    }),
  );
  assert.equal(errors.length, 2);
  assert.match(errors.join(), /also staged: package.json/);
  assert.match(errors.join(), /author must be/);
});

void test("with no HEAD and nothing staged there is no root commit to check", () => {
  assert.deepEqual(checkManifest(input({ hasHead: false, staged: [] })).errors, []);
});

void test("staged package.json and Cargo.toml must carry the manifest identity", () => {
  const good = checkManifest(
    input({
      staged: ["package.json", "Cargo.toml"],
      stagedPackageJson: JSON.stringify({
        name: "@alloy-ts/engine",
        repository: { type: "git", url: "git+https://repo.chen.software/alloy-ts/engine.git" },
      }),
      stagedCargoToml: '[package]\nname = "alloy-engine"\n',
    }),
  );
  assert.deepEqual(good.errors, []);
  const bad = checkManifest(
    input({
      staged: ["package.json", "Cargo.toml"],
      stagedPackageJson: JSON.stringify({
        name: "repository",
        repository: "https://repo.chen.software/yumin-chen/repository",
      }),
      stagedCargoToml: '[package]\nname = "repository"\n',
    }),
  );
  assert.equal(bad.errors.length, 3);
});

void test("collectInput reads a real repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-sanity-"));
  try {
    const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    g("init", "-q");
    writeFileSync(join(dir, "repo.manifest.yml"), MANIFEST);
    g("config", "user.signingKey", "ssh-ed25519 AAAA:key");
    g("config", "commit.gpgsign", "true");
    g("config", "core.hooksPath", "scripts/hooks/_");
    g("remote", "add", "origin", "https://dev.azure.com/ChenSoftware/alloy-ts/_git/engine");
    g("add", "repo.manifest.yml");
    const collected = collectInput(dir);
    assert.equal(collected.hasHead, false);
    assert.deepEqual(collected.staged, ["repo.manifest.yml"]);
    const result = checkManifest({
      ...collected,
      authorEmail: "repo@chen.software",
      committerEmail: "repo@chen.software",
    });
    assert.deepEqual(result.errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
