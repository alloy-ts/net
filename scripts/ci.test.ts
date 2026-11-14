import { test } from "node:test";
import assert from "node:assert/strict";
import { planTargets } from "./ci.ts";

const ALL = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-musl",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
];

void test("planTargets builds the host natively and cross-compiles the rest", () => {
  const { plans, skipped } = planTargets(ALL, "x86_64-unknown-linux-gnu", new Set(ALL), {
    zigbuild: true,
    xwin: true,
  });
  assert.deepEqual(skipped, []);
  assert.deepEqual(
    plans.map((p) => [p.abi, p.tool]),
    [
      ["linux-x64-gnu", "native"],
      ["linux-arm64-musl", "zigbuild"],
      ["darwin-arm64", "zigbuild"],
      ["win32-x64-msvc", "xwin"],
    ],
  );
});

void test("planTargets skips targets without a rustup target or cross tool", () => {
  const { plans, skipped } = planTargets(
    ALL,
    "x86_64-unknown-linux-gnu",
    new Set(["x86_64-unknown-linux-gnu", "aarch64-apple-darwin", "x86_64-pc-windows-msvc"]),
    { zigbuild: false, xwin: false },
  );
  assert.deepEqual(
    plans.map((p) => p.triple),
    ["x86_64-unknown-linux-gnu"],
  );
  assert.deepEqual(
    skipped.map((s) => s.reason),
    [
      "rustup target aarch64-unknown-linux-musl is not installed",
      "cargo-zigbuild (and zig) is not installed",
      "cargo-xwin is not installed",
    ],
  );
});
