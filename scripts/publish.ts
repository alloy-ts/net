// Assemble and publish the npm packages with napi's standard multi-package
// flow: one root package plus one optional package per platform.
//
//   npm run publish:npm -- [--artifacts artifacts] [--registry URL] [--tag TAG]
//                          [--allow-missing] [--dry-run]
//
// Steps, all inside a throwaway staging dir (.publish/) so the checkout is
// never modified:
//   1. copy package.json (scripts stripped) and the files it lists
//   2. napi create-npm-dirs            -> npm/<platform>/package.json
//   3. napi artifacts -o <artifacts>   -> npm/<platform>/<binary>.<platform>.node
//   4. napi pre-publish -t npm         -> publishes every platform package and
//                                         writes optionalDependencies
//   5. npm publish                     -> the root package
//
// Environment (flags win): NPM_REGISTRY (default https://registry.npmjs.org/),
// NPM_TAG (default latest), NPM_TOKEN (optional). The token is never written
// to disk: a temporary userconfig refers to it as ${NPM_TOKEN} and npm expands
// it. Without NPM_TOKEN the caller's own ~/.npmrc is used (e.g. a local
// Verdaccio login).
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTriple } from "@napi-rs/cli";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

export type PublishOptions = {
  artifacts: string;
  registry: string;
  tag: string;
  allowMissing: boolean;
  dryRun: boolean;
};

type Pkg = {
  name: string;
  version: string;
  files?: string[];
  scripts?: Record<string, string>;
  napi?: { binaryName?: string; packageName?: string; targets?: string[] };
  [key: string]: unknown;
};

// The package.json that goes to the registry: no lifecycle scripts (a
// consumer must never run build.ts or setup.ts) and napi.targets trimmed to
// the built addons when --allow-missing is given.
export function stagePackageJson(pkg: Pkg, opts: { targets?: string[] }): Pkg {
  const out: Pkg = { ...pkg, napi: { ...pkg.napi } };
  delete out.scripts;
  if (opts.targets) out.napi = { ...out.napi, targets: opts.targets };
  return out;
}

// napi bakes the package name (platform packages are `<name>-<platform>`) and
// version into the generated loader. Name and version therefore come only
// from package.json at build time; refuse to publish a stale loader.
export function loaderMismatch(loader: string, name: string, version: string): string | undefined {
  if (!loader.includes(`require('${name}-`)) {
    return `dist/index.js does not load ${name}-<platform>; rebuild after changing the package name`;
  }
  if (!loader.includes(`expected ${version} but got`)) {
    return `dist/index.js was built for another version than ${version}; rebuild`;
  }
  return undefined;
}

// npm userconfig body for token auth. `${NPM_TOKEN}` stays literal: npm
// expands environment variables in .npmrc, so the secret never touches disk.
export function authConfig(registry: string): string {
  const url = new URL(registry);
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return `registry=${url.href}\n//${url.host}${path}:_authToken=\${NPM_TOKEN}\n`;
}

// Azure Pipelines passes an undefined variable through as the literal
// "$(NPM_TOKEN)"; treat that like no token at all.
export function hasToken(token: string | undefined): boolean {
  return !!token && !token.startsWith("$(");
}

// Which configured targets have a built addon in the artifacts dir.
export function availableTargets(
  targets: string[],
  binaryName: string,
  files: string[],
): { present: string[]; missing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];
  for (const t of targets) {
    const file = `${binaryName}.${parseTriple(t).platformArchABI}.node`;
    (files.includes(file) ? present : missing).push(t);
  }
  return { present, missing };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else out.push(e.name);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  console.log(`\n[publish] (${cwd}) $ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status ?? r.signal}`);
}

export function publish(opts: PublishOptions): void {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Pkg;
  const binaryName = pkg.napi?.binaryName ?? pkg.name.replace(/^@[^/]+\//, "");
  const targets = pkg.napi?.targets ?? [];
  const artifacts = isAbsolute(opts.artifacts) ? opts.artifacts : resolve(root, opts.artifacts);

  const { present, missing } = availableTargets(targets, binaryName, listFiles(artifacts));
  if (missing.length > 0) {
    const list = missing.join(", ");
    if (!opts.allowMissing) throw new Error(`no addon in ${artifacts} for: ${list}`);
    console.log(`[publish] --allow-missing: leaving out ${list}`);
  }
  if (present.length === 0) throw new Error(`no addons found in ${artifacts}`);

  // 1. staging copy
  const stage = join(root, ".publish");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const loader = join(root, "dist", "index.js");
  if (!existsSync(loader)) throw new Error("dist/index.js is missing; run `npm run build` first");
  const mismatch = loaderMismatch(readFileSync(loader, "utf8"), pkg.name, pkg.version);
  if (mismatch) throw new Error(mismatch);
  const staged = stagePackageJson(pkg, { targets: missing.length > 0 ? present : undefined });
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(staged, null, 2)}\n`);
  for (const f of [...(pkg.files ?? []), "Licence", "ReadMe.md"]) {
    const from = join(root, f);
    if (!existsSync(from)) {
      if (f.startsWith("dist/")) throw new Error(`${f} is missing; run \`npm run build\` first`);
      continue;
    }
    mkdirSync(dirname(join(stage, f)), { recursive: true });
    cpSync(from, join(stage, f), { recursive: true });
  }

  // npm reads its configuration from npm_config_* variables, which reach the
  // `npm publish` that napi pre-publish runs inside each platform package.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_registry: opts.registry,
    npm_config_tag: opts.tag,
    npm_config_access: "public",
    npm_config_dry_run: opts.dryRun ? "true" : "false",
  };
  let authDir: string | undefined;
  if (hasToken(process.env["NPM_TOKEN"])) {
    authDir = mkdtempSync(join(tmpdir(), "publish-npmrc-"));
    const userconfig = join(authDir, "npmrc");
    writeFileSync(userconfig, authConfig(opts.registry), { mode: 0o600 });
    env["npm_config_userconfig"] = userconfig;
  }

  const napi = join(root, "node_modules", "@napi-rs", "cli", "dist", "cli.js");
  try {
    // 2-4. napi's per-platform package flow
    run(process.execPath, [napi, "create-npm-dirs", "--npm-dir", "npm"], stage, env);
    run(
      process.execPath,
      [napi, "artifacts", "--output-dir", artifacts, "--npm-dir", "npm"],
      stage,
      env,
    );
    run(process.execPath, [napi, "pre-publish", "-t", "npm", "--npm-dir", "npm"], stage, env);
    // 5. root package, now carrying optionalDependencies
    run("npm", ["publish"], stage, env);
  } finally {
    if (authDir) rmSync(authDir, { recursive: true, force: true });
  }
  const final = JSON.parse(readFileSync(join(stage, "package.json"), "utf8")) as Pkg;
  console.log(
    `\n[publish] ${opts.dryRun ? "dry run of" : "published"} ${final.name}@${final.version} ` +
      `(tag ${opts.tag}) to ${opts.registry} with ${present.length} platform package(s)`,
  );
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): PublishOptions {
  const opts: PublishOptions = {
    artifacts: "artifacts",
    registry: env["NPM_REGISTRY"] || DEFAULT_REGISTRY,
    tag: env["NPM_TAG"] || "latest",
    allowMissing: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--artifacts") opts.artifacts = value();
    else if (a === "--registry") opts.registry = value();
    else if (a === "--tag") opts.tag = value();
    else if (a === "--allow-missing") opts.allowMissing = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    publish(parseArgs(process.argv.slice(2), process.env));
  } catch (err) {
    console.error(`[publish] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
