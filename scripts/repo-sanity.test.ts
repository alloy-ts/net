import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyFixes,
  crateNameMatches,
  packageNameMatches,
  suggestCrateName,
  suggestPackageName,
  checkManifest,
  collectInput,
  normalizeRemote,
  type CheckInput,
} from "./repo-sanity.ts";

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
  assert.deepEqual(checkManifest(input()), { errors: [], warnings: [], hints: [], fixes: [] });
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

void test("skipConfigValues ignores config that setup has not applied yet", () => {
  const empty = new Map([
    ["remote.origin.url", ["https://dev.azure.com/ChenSoftware/alloy-ts/_git/engine"]],
  ]);
  assert.equal(checkManifest(input({ gitConfig: empty })).errors.length, 3);
  assert.deepEqual(
    checkManifest(input({ gitConfig: empty }), { skipConfigValues: true }).errors,
    [],
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
  assert.match(
    errors[0]!,
    /remote "origin" url: expected [^,]+, actual dev.azure.com\/chensoftware\/init\/_git\/init/,
  );
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

void test("package.json and Cargo.toml must carry the manifest identity", () => {
  const good = checkManifest(
    input({
      staged: ["package.json", "Cargo.toml"],
      packageJson: JSON.stringify({
        name: "@alloy-ts/engine",
        repository: { type: "git", url: "git+https://repo.chen.software/alloy-ts/engine.git" },
      }),
      cargoToml: '[package]\nname = "alloy-engine"\n',
    }),
  );
  assert.deepEqual(good.errors, []);
  const bad = checkManifest(
    input({
      staged: ["package.json", "Cargo.toml"],
      packageJson: JSON.stringify({
        name: "repository",
        repository: "https://repo.chen.software/yumin-chen/repository",
      }),
      cargoToml: '[package]\nname = "repository"\n',
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

const TEMPLATE_PACKAGE = JSON.stringify({
  name: "repository",
  repository: { type: "git", url: "git+https://repo.chen.software/yumin-chen/repository.git" },
});

void test("every name conflict reports location, expected, actual and a fix", () => {
  const result = checkManifest(
    input({
      gitConfig: config({
        "remote.origin.url": "https://u:secret@dev.azure.com/ChenSoftware/alloy-ts/_git/init",
      }),
      packageJson: TEMPLATE_PACKAGE,
      cargoToml: '[package]\nname = "repository"\n',
    }),
  );
  const [remote, name, repo, crate] = result.errors;
  assert.equal(result.errors.length, 4);
  assert.match(
    remote!,
    /^remote "origin" url: expected dev.azure.com\/chensoftware\/alloy-ts\/_git\/engine, actual dev.azure.com\/chensoftware\/alloy-ts\/_git\/init/,
  );
  assert.match(
    remote!,
    /fix: git remote set-url origin https:\/\/dev.azure.com\/ChenSoftware\/alloy-ts\/_git\/engine/,
  );
  assert.match(
    name!,
    /^package.json name: expected "engine" or "@<scope>\/engine", actual "repository"[\s\S]*fix: set "name": "engine" in package.json \(example: there is no existing scope to keep[\s\S]*commit --amend/,
  );
  assert.match(
    repo!,
    /^package.json repository.url: expected repo.chen.software\/alloy-ts\/engine, actual repo.chen.software\/yumin-chen\/repository/,
  );
  assert.match(
    crate!,
    /^Cargo.toml \[package\] name: expected "engine" or "<prefix>-engine", actual "repository"[\s\S]*fix: set name = "engine" under \[package\] in Cargo.toml \(example: there is no existing prefix to keep/,
  );
  assert.match(result.hints.join(), /only change in the root commit[\s\S]*refs\/roots\/main/);
  assert.doesNotMatch(result.errors.join(), /secret/);
  assert.deepEqual(result.fixes, [
    {
      remote: "origin",
      push: false,
      url: "https://dev.azure.com/ChenSoftware/alloy-ts/_git/engine",
    },
  ]);
});

void test("a remote on a host outside the manifest has no automatic fix", () => {
  const result = checkManifest(
    input({ gitConfig: config({ "remote.mirror.url": "https://example.com/x/y" }) }),
  );
  assert.match(
    result.errors.join(),
    /remote "mirror" url: example.com\/x\/y is not on any host[\s\S]*git remote remove mirror/,
  );
  assert.deepEqual(result.fixes, []);
});

void test("a package.json conflict is reported even when it is not staged", () => {
  const { errors } = checkManifest(input({ staged: [], packageJson: TEMPLATE_PACKAGE }));
  assert.equal(errors.length, 2);
});

void test("applyFixes repoints origin and keeps embedded credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-sanity-fix-"));
  try {
    const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    g("init", "-q");
    g("remote", "add", "origin", "https://u:tok@dev.azure.com/ChenSoftware/alloy-ts/_git/init");
    applyFixes(dir, [
      {
        remote: "origin",
        push: false,
        url: "https://dev.azure.com/ChenSoftware/alloy-ts/_git/engine",
      },
    ]);
    assert.equal(
      g("config", "--local", "--get", "remote.origin.url").trim(),
      "https://u:tok@dev.azure.com/ChenSoftware/alloy-ts/_git/engine",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const pkg = (
  name: string,
  url = "git+https://dev.azure.com/ChenSoftware/alloy-ts/_git/engine.git",
) => JSON.stringify({ name, repository: { type: "git", url } });

void test("names accept any scope or prefix, and owner plays no part", () => {
  assert.ok(packageNameMatches("engine", "engine"));
  assert.ok(packageNameMatches("@alloy-ts/engine", "engine"));
  assert.ok(packageNameMatches("@someone-else/engine", "engine"));
  assert.ok(!packageNameMatches("@alloy-ts/core", "engine"));
  assert.ok(!packageNameMatches("@a/b/engine", "engine"));
  assert.ok(crateNameMatches("engine", "engine"));
  assert.ok(crateNameMatches("alloy-engine", "engine"));
  assert.ok(crateNameMatches("other-engine", "engine"));
  assert.ok(!crateNameMatches("alloy-core", "engine"));
  // A user owner that differs from every path and scope still passes.
  const manifest = MANIFEST.replace("owner: alloy-ts", "owner: yumin-chen");
  const result = checkManifest(
    input({
      manifestText: manifest,
      packageJson: pkg("@alloy-ts/engine"),
      cargoToml: '[package]\nname = "alloy-engine"\n',
    }),
  );
  assert.deepEqual([result.errors, result.warnings, result.hints], [[], [], []]);
});

void test("fix hints keep the existing scope or prefix and swap in the name", () => {
  assert.deepEqual(suggestPackageName("@alloy-ts/core", "engine"), {
    value: "@alloy-ts/engine",
    example: false,
  });
  assert.deepEqual(suggestPackageName("core", "engine"), { value: "engine", example: true });
  assert.deepEqual(suggestPackageName(undefined, "engine"), { value: "engine", example: true });
  assert.deepEqual(suggestCrateName("alloy-core", "engine"), {
    value: "alloy-engine",
    example: false,
  });
  assert.deepEqual(suggestCrateName(undefined, "engine"), { value: "engine", example: true });
  const { errors } = checkManifest(
    input({ packageJson: pkg("@alloy-ts/core"), cargoToml: '[package]\nname = "alloy-core"\n' }),
  );
  assert.equal(errors.length, 2);
  assert.match(
    errors[0]!,
    /fix: set "name": "@alloy-ts\/engine" in package.json \(keeps the existing scope\)/,
  );
  assert.match(
    errors[1]!,
    /fix: set name = "alloy-engine" under \[package\] in Cargo.toml \(keeps the existing prefix\)/,
  );
});

void test("repository.url and remotes compare with the listed manifest URLs exactly", () => {
  // Azure's org/project/_git path is matched as listed.
  assert.deepEqual(checkManifest(input({ packageJson: pkg("engine") })).errors, []);
  const { errors } = checkManifest(
    input({
      packageJson: pkg("engine", "git+https://dev.azure.com/ChenSoftware/other/_git/engine.git"),
    }),
  );
  assert.match(
    errors.join(),
    /repository.url: expected dev.azure.com\/chensoftware\/alloy-ts\/_git\/engine, actual dev.azure.com\/chensoftware\/other\/_git\/engine[\s\S]*"git\+https:\/\/dev.azure.com\/ChenSoftware\/alloy-ts\/_git\/engine.git"/,
  );
  const azureOrg = checkManifest(
    input({
      gitConfig: config({
        "remote.origin.url": "https://dev.azure.com/OtherOrg/alloy-ts/_git/engine",
      }),
    }),
  );
  assert.equal(azureOrg.errors.length, 1);
});
