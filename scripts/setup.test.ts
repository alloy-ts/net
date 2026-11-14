import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "./setup.ts";

const MANIFEST = `name: engine
owner: alloy-ts
config:
  - commit.gpgsign: true
  - core.hooksPath: scripts/hooks/_
remote:
  - https://dev.azure.com/ChenSoftware/alloy-ts/_git/engine
`;

// Create a throwaway repo, let `prepare` shape it, then assert that setup()
// aborts in pre-flight and leaves .git/config byte-identical.
function assertAbortsWithoutWriting(prepare: (dir: string) => void, message: RegExp): void {
  const dir = mkdtempSync(join(tmpdir(), "setup-preflight-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    prepare(dir);
    const before = readFileSync(join(dir, ".git", "config"));
    assert.throws(() => setup(dir), message);
    assert.deepEqual(readFileSync(join(dir, ".git", "config")), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const g = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });

void test("setup aborts before writing when origin is not a manifest remote", () => {
  assertAbortsWithoutWriting((dir) => {
    writeFileSync(join(dir, "repo.manifest.yml"), MANIFEST);
    g(dir, "remote", "add", "origin", "https://dev.azure.com/ChenSoftware/init/_git/init");
  }, /pre-flight failed[\s\S]*remote "origin"[\s\S]*nothing was written/);
});

void test("setup aborts before writing when the manifest is invalid", () => {
  assertAbortsWithoutWriting((dir) => {
    writeFileSync(join(dir, "repo.manifest.yml"), MANIFEST.replace(/^remote:[\s\S]*$/m, ""));
  }, /no `remote:` entries/);
});

void test("setup aborts before writing when the manifest is missing", () => {
  assertAbortsWithoutWriting(() => {}, /manifest not found/);
});

void test("setup aborts before writing when repo.manifest.yml is staged after the root", () => {
  assertAbortsWithoutWriting((dir) => {
    writeFileSync(join(dir, "repo.manifest.yml"), MANIFEST);
    writeFileSync(join(dir, "a.txt"), "a");
    g(dir, "add", "a.txt");
    g(
      dir,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "a",
    );
    g(dir, "add", "repo.manifest.yml");
  }, /only the root commit may change it/);
});
