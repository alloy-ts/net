// Repository sanity check: verifies that the repository's git state agrees
// with repo.manifest.yml.
//
//   node --import @oxc-node/core/register scripts/repo-sanity.ts [--report]
//   npm run repo:sanity
//
// It runs from `npm run prepare` (scripts/setup.ts, after the manifest config
// is applied) and from the pre-commit, post-checkout, post-merge and
// post-rewrite git hooks. It exits 1 on any error, which blocks a commit;
// `--report` prints the same findings but always exits 0, for events that
// cannot be undone (setup, checkout, merge, rewrite).
//
//   1. repo.manifest.yml exists and has a name, owner, config and remotes.
//   2. Every manifest `config:` entry is set to the same value in .git/config.
//   3. Every remote URL in .git/config is one of the manifest's remotes
//      (credentials are ignored; only host and path are compared).
//   4. Only the root commit may touch repo.manifest.yml, and the root commit
//      must contain nothing else and be authored and committed by the repo
//      identity (repo@ or repository@chen.software).
//   5. A staged package.json or Cargo.toml must carry the manifest identity.
//
// Set `git config --local manifest.template true` in a clone of the init
// template itself: its manifest names the module that new repos start as, so
// remote and package identity mismatches are reported as warnings there.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifestConfig } from "./setup.ts";

export const MANIFEST_FILE = "repo.manifest.yml";
export const REPO_EMAILS = ["repo@chen.software", "repository@chen.software"];

export type Manifest = {
  name: string;
  owner: string;
  config: { key: string; value: string }[];
  remote: string[];
};

export type CheckInput = {
  manifestText: string | undefined;
  // `git config --local --list` as key -> values (keys as git prints them).
  gitConfig: Map<string, string[]>;
  // Staged paths (`git diff --cached --name-only`), including deletions.
  staged: string[];
  // False when there is no HEAD yet, i.e. this will be the root commit.
  hasHead: boolean;
  authorEmail: string;
  committerEmail: string;
  // Contents of package.json / Cargo.toml as staged, when they are staged.
  stagedPackageJson?: string;
  stagedCargoToml?: string;
};

export type CheckResult = { errors: string[]; warnings: string[] };

function scalar(text: string, key: string): string {
  const m = text.match(new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m"));
  return (m?.[1] ?? "").replace(/^(["'])(.*)\1$/, "$2");
}

function list(text: string, key: string): string[] {
  const items: string[] = [];
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (new RegExp(`^${key}:\\s*$`).test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^\S/.test(line)) break;
    const item = inBlock ? line.match(/^\s*-\s*(.+?)\s*$/)?.[1] : undefined;
    if (item) items.push(item);
  }
  return items;
}

export function parseManifest(text: string): Manifest {
  return {
    name: scalar(text, "name"),
    owner: scalar(text, "owner"),
    config: parseManifestConfig(text),
    remote: list(text, "remote"),
  };
}

// Reduce a remote URL to "host/path" without credentials, scheme, `git+`,
// a trailing `.git` or slash, so equivalent URLs compare equal. scp-style
// `git@host:path` is accepted too.
export function normalizeRemote(url: string): string {
  let u = url.trim().replace(/^git\+/, "");
  const scp = u.match(/^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/);
  if (scp && !/^[a-z]+:\/\//i.test(u)) {
    u = `${scp[1]}/${scp[2]}`;
  } else {
    try {
      const parsed = new URL(u);
      u = `${parsed.host}${parsed.pathname}`;
    } catch {
      u = u.replace(/^[a-z]+:\/\//i, "").replace(/^[^@/]*@/, "");
    }
  }
  return u
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

// Git prints section and variable names in lower case; subsections keep case.
function configKey(key: string): string {
  const parts = key.split(".");
  if (parts.length < 2) return key.toLowerCase();
  const first = parts[0]!.toLowerCase();
  const last = parts[parts.length - 1]!.toLowerCase();
  return [first, ...parts.slice(1, -1), last].join(".");
}

const TRUE = new Set(["true", "yes", "on", "1"]);
const FALSE = new Set(["false", "no", "off", "0"]);

// Booleans compare by meaning (`true` == `yes`); anything else exactly.
function sameConfigValue(expected: string, actual: string): boolean {
  const e = expected.toLowerCase();
  const a = actual.toLowerCase();
  if (TRUE.has(e)) return TRUE.has(a);
  if (FALSE.has(e)) return FALSE.has(a) || a === "";
  return expected === actual;
}

function isTemplate(config: Map<string, string[]>): boolean {
  const v = config.get("manifest.template")?.at(-1);
  return v !== undefined && TRUE.has(v.toLowerCase());
}

export function checkManifest(input: CheckInput): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (input.manifestText === undefined) {
    errors.push(`${MANIFEST_FILE} not found in the repository root`);
    return { errors, warnings };
  }
  const manifest = parseManifest(input.manifestText);
  for (const field of ["name", "owner"] as const) {
    if (!manifest[field]) errors.push(`${MANIFEST_FILE}: missing \`${field}\``);
  }
  if (manifest.config.length === 0) errors.push(`${MANIFEST_FILE}: no \`config:\` entries`);
  if (manifest.remote.length === 0) errors.push(`${MANIFEST_FILE}: no \`remote:\` entries`);

  // Manifest config vs .git/config.
  for (const { key, value } of manifest.config) {
    const actual = input.gitConfig.get(configKey(key))?.at(-1);
    if (actual === undefined) {
      errors.push(`.git/config: ${key} is not set (manifest: ${value}); run \`npm run prepare\``);
    } else if (!sameConfigValue(value, actual)) {
      errors.push(
        `.git/config: ${key} is ${JSON.stringify(actual)} but the manifest says ${JSON.stringify(value)}; run \`npm run prepare\``,
      );
    }
  }

  const template = isTemplate(input.gitConfig);
  const identity = (msg: string) => (template ? warnings : errors).push(msg);

  // Remotes vs manifest.
  const allowed = new Set(manifest.remote.map(normalizeRemote));
  for (const [key, values] of input.gitConfig) {
    const m = key.match(/^remote\.(.+)\.(url|pushurl)$/);
    if (!m) continue;
    for (const url of values) {
      const norm = normalizeRemote(url);
      if (!allowed.has(norm)) {
        identity(
          `.git/config: remote "${m[1]}" ${m[2]} ${norm} is not a remote in ${MANIFEST_FILE}`,
        );
      }
    }
  }

  // Only the root commit may touch the manifest, and it must touch nothing else.
  const touchesManifest = input.staged.includes(MANIFEST_FILE);
  if (input.hasHead) {
    if (touchesManifest) {
      errors.push(
        `${MANIFEST_FILE} is staged, but only the root commit may change it; unstage it with \`git restore --staged ${MANIFEST_FILE}\``,
      );
    }
  } else if (input.staged.length > 0) {
    const others = input.staged.filter((p) => p !== MANIFEST_FILE);
    if (!touchesManifest) errors.push(`the root commit must add ${MANIFEST_FILE}`);
    if (others.length > 0) {
      errors.push(
        `the root commit must contain only ${MANIFEST_FILE}; also staged: ${others.join(", ")}`,
      );
    }
    for (const [role, email] of [
      ["author", input.authorEmail],
      ["committer", input.committerEmail],
    ] as const) {
      if (!REPO_EMAILS.includes(email.toLowerCase())) {
        errors.push(
          `the root commit ${role} must be ${REPO_EMAILS.join(" or ")}, not ${email || "(unset)"}`,
        );
      }
    }
  }

  // Package identity, checked when the file is part of this commit.
  if (input.stagedPackageJson !== undefined && manifest.name && manifest.owner) {
    let pkg: { name?: unknown; repository?: unknown } = {};
    try {
      pkg = JSON.parse(input.stagedPackageJson) as typeof pkg;
    } catch {
      errors.push("package.json: not valid JSON");
    }
    const want = `@${manifest.owner}/${manifest.name}`;
    if (pkg.name !== want) {
      identity(`package.json: name is ${JSON.stringify(pkg.name)} but the manifest says ${want}`);
    }
    const repo = pkg.repository;
    const repoUrl =
      typeof repo === "string"
        ? repo
        : repo && typeof repo === "object" && "url" in repo && typeof repo.url === "string"
          ? repo.url
          : undefined;
    if (repoUrl === undefined || !allowed.has(normalizeRemote(repoUrl))) {
      identity(
        `package.json: repository.url ${repoUrl === undefined ? "is missing" : normalizeRemote(repoUrl) + " is not a remote"} in ${MANIFEST_FILE}`,
      );
    }
  }
  if (input.stagedCargoToml !== undefined && manifest.name) {
    const crate = input.stagedCargoToml.match(/^\[package\][^[]*?^name\s*=\s*"([^"]*)"/m)?.[1];
    if (crate !== manifest.name && !crate?.endsWith(`-${manifest.name}`)) {
      identity(
        `Cargo.toml: package name is ${JSON.stringify(crate)} but should be ${manifest.name} or end in -${manifest.name}`,
      );
    }
  }

  return { errors, warnings };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

function emailOf(ident: string | undefined): string {
  return ident?.match(/<([^>]*)>/)?.[1] ?? "";
}

export function collectInput(cwd: string): CheckInput {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const manifestPath = join(root, MANIFEST_FILE);

  const gitConfig = new Map<string, string[]>();
  for (const entry of (tryGit(root, ["config", "--local", "--list", "-z"]) ?? "").split("\0")) {
    if (!entry) continue;
    const nl = entry.indexOf("\n");
    const key = nl === -1 ? entry : entry.slice(0, nl);
    const value = nl === -1 ? "" : entry.slice(nl + 1);
    gitConfig.set(key, [...(gitConfig.get(key) ?? []), value]);
  }

  const staged = git(root, ["diff", "--cached", "--name-only", "--no-renames", "-z"])
    .split("\0")
    .filter(Boolean);
  const stagedBlob = (path: string) =>
    staged.includes(path) ? tryGit(root, ["show", `:${path}`]) : undefined;

  return {
    manifestText: existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : undefined,
    gitConfig,
    staged,
    hasHead: tryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]) !== undefined,
    authorEmail: emailOf(tryGit(root, ["var", "GIT_AUTHOR_IDENT"])),
    committerEmail: emailOf(tryGit(root, ["var", "GIT_COMMITTER_IDENT"])),
    stagedPackageJson: stagedBlob("package.json"),
    stagedCargoToml: stagedBlob("Cargo.toml"),
  };
}

function main(): void {
  const report = process.argv.includes("--report");
  const { errors, warnings } = checkManifest(collectInput(process.cwd()));
  for (const w of warnings) console.warn(`[repo-sanity] warning: ${w}`);
  for (const e of errors) console.error(`[repo-sanity] error: ${e}`);
  if (errors.length > 0) {
    console.error(
      `[repo-sanity] ${errors.length} problem(s)${report ? "; fix them before committing" : "; blocked"}`,
    );
    if (!report) process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
