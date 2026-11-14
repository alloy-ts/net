import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkManifest, collectInput, type CheckOptions } from "./repo-sanity.ts";

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));

type ConfigEntry = { key: string; value: string };

const MANIFEST_CANDIDATES = ["repo.manifest.yml", "repository.manifest.yml"];

function readManifest(root: string): { name: string; text: string } {
  for (const name of MANIFEST_CANDIDATES) {
    const path = join(root, name);
    if (existsSync(path)) {
      return { name, text: readFileSync(path, "utf8") };
    }
  }
  throw new Error(
    `manifest not found: looked for ${MANIFEST_CANDIDATES.join(", ")} in the repository root`,
  );
}

// Parse the top-level `config:` mapping from the repo manifest.
// Each entry is a list item of the form `  - key: value`; the value may itself
// contain colons (e.g. an ssh public key), so we split only on the first colon.
function parseManifestConfig(text: string): ConfigEntry[] {
  const lines = text.split(/\r?\n/);
  const entries: ConfigEntry[] = [];
  let inConfig = false;

  for (const line of lines) {
    // Enter the `config:` block.
    if (/^config:\s*$/.test(line)) {
      inConfig = true;
      continue;
    }
    // A new top-level key (no leading whitespace) ends the `config` block.
    if (inConfig && /^\S/.test(line)) {
      inConfig = false;
    }
    if (!inConfig) continue;

    const item = line.match(/^\s*-\s*(.+)$/)?.[1]?.trim();
    if (!item) continue;

    const colon = item.indexOf(":");
    if (colon === -1) continue;

    const key = item.slice(0, colon).trim();
    const value = item.slice(colon + 1).trim();
    if (key) entries.push({ key, value });
  }

  return entries;
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "inherit" });
}

function vp(root: string, args: string[]): void {
  // Prefer the locally-installed CLI; fall back to npx when it is not on PATH
  // (e.g. when setup.ts is run directly rather than via an npm script).
  const localBin = join(root, "node_modules", ".bin", "vp");
  try {
    execFileSync(localBin, args, { cwd: root, stdio: "inherit" });
  } catch {
    execFileSync("npx", ["--no-install", "vp", ...args], {
      cwd: root,
      stdio: "inherit",
    });
  }
}

// Run scripts/repo-sanity.ts checks; print warnings and throw on errors, with
// every finding, its fix and any notes in the message.
function sanity(root: string, stage: string, options: CheckOptions = {}): void {
  const { errors, warnings, hints, fixes } = checkManifest(collectInput(root), options);
  for (const w of warnings) console.warn(`[setup] ${stage} warning: ${w}`);
  if (errors.length === 0) {
    for (const h of hints) console.warn(`[setup] ${stage} note: ${h}`);
    return;
  }
  throw new Error(
    [
      `${stage} failed:`,
      ...errors.map((e) => `  - ${e}`),
      ...hints.map((h) => `  note: ${h}`),
      ...(fixes.length > 0
        ? ["  `npm run repo:sanity -- --fix` can repoint the listed remotes."]
        : []),
      ...(stage === "pre-flight" ? ["nothing was written to .git/config"] : []),
    ].join("\n"),
  );
}

export function setup(root: string): void {
  const manifest = readManifest(root);
  const entries = parseManifestConfig(manifest.text);
  if (entries.length === 0) {
    throw new Error(`${manifest.name}: no \`config:\` entries found`);
  }

  // Pre-flight: refuse to touch .git/config unless the manifest is valid and
  // the repository already agrees with it on everything setup does not write
  // (remotes, protected files, package identity). The config values are
  // skipped here because applying them is what setup is for.
  console.log("[setup] pre-flight repo sanity check");
  sanity(root, "pre-flight", { skipConfigValues: true });

  const hooksPathEntry = entries.find((e) => e.key === "core.hooksPath");
  const hooksDir = hooksPathEntry ? dirname(hooksPathEntry.value) : join("scripts", "hooks");

  // (Re)install the Vite+ hook dispatcher. Clear any pre-set hooksPath first so
  // vp always (re)generates the dispatcher instead of short-circuiting because
  // the path is "already set".
  try {
    git(root, ["config", "--local", "--unset", "core.hooksPath"]);
  } catch {
    // Not set yet — that's fine.
  }
  console.log(`[setup] vp config --hooks-dir ${hooksDir}`);
  vp(root, ["config", "--hooks-dir", hooksDir, "--hooks"]);

  // Apply every manifest `config:` entry as a local git config value.
  for (const { key, value } of entries) {
    console.log(`[setup] git config --local ${key} ${value}`);
    git(root, ["config", "--local", key, value]);
  }

  // Verify the applied config against the manifest.
  sanity(root, "verify");

  console.log("[setup] repository setup complete");
}

export { parseManifestConfig };

// Run only when executed directly (the prepare hook), not when imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    setup(defaultRoot);
  } catch (err) {
    console.error(`[setup] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
