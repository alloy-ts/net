// Local mirror of azure-pipelines.yml: the same check / build / test steps,
// then a cross-build of every napi target this machine can produce.
//
//   npm run ci                       # build, check, test, cross
//   npm run ci -- cross              # only the cross-build stage
//   npm run ci -- cross --targets x86_64-unknown-linux-gnu,aarch64-apple-darwin
//   npm run ci -- cross --strict     # fail instead of skipping unbuildable targets
//   npm run ci -- smoke              # load every addon in artifacts/ this host can run
//
// Cross-built addons are collected flat in artifacts/ (the layout
// `napi artifacts --output-dir artifacts` expects) and every addon the host
// can run is smoke-tested by loading it.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTriple } from "@napi-rs/cli";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// build runs first: type-aware lint needs the generated dist/index.js typings.
const STAGES = ["build", "check", "test", "cross", "smoke"] as const;
const DEFAULT_STAGES: Stage[] = ["build", "check", "test", "cross"];
type Stage = (typeof STAGES)[number];

export type CrossTool = "native" | "zigbuild" | "xwin";

export type Plan = { triple: string; abi: string; tool: CrossTool };
export type Skip = { triple: string; abi: string; reason: string };

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  console.log(`\n[ci] $ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status ?? r.signal}`);
  }
}

function has(cmd: string, args: string[] = ["--version"]): boolean {
  return (
    spawnSync(cmd, args, { stdio: "ignore", shell: process.platform === "win32" }).status === 0
  );
}

function hostTriple(): string {
  const out = execFileSync("rustc", ["-vV"]).toString();
  const line = out.split(/\r?\n/).find((l) => l.startsWith("host:"));
  if (!line) throw new Error("rustc -vV did not report a host triple");
  return line.slice("host:".length).trim();
}

function installedRustTargets(): Set<string> {
  try {
    return new Set(
      execFileSync("rustup", ["target", "list", "--installed"])
        .toString()
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    // No rustup: only the host target is available.
    return new Set([hostTriple()]);
  }
}

export function readPackage(dir = root): { binaryName: string; targets: string[] } {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name: string;
    napi?: { binaryName?: string; targets?: string[] };
  };
  return {
    binaryName: pkg.napi?.binaryName ?? pkg.name.replace(/^@[^/]+\//, ""),
    targets: pkg.napi?.targets ?? [],
  };
}

// Xcode and MSVC link every architecture of their own OS, so a darwin or
// windows-msvc host builds the other arch without a cross toolchain.
function sameNativeToolchain(triple: string, host: string): boolean {
  return ["-apple-darwin", "-pc-windows-msvc"].some(
    (os) => triple.endsWith(os) && host.endsWith(os),
  );
}

// napi platform name of the running Node, e.g. linux-x64-gnu, darwin-arm64.
export function hostAbi(): string {
  const { platform, arch } = process;
  if (platform === "linux") {
    const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })
      ?.header;
    return `linux-${arch}-${header?.glibcVersionRuntime ? "gnu" : "musl"}`;
  }
  if (platform === "win32") return `win32-${arch}-msvc`;
  return `${platform}-${arch}`;
}

// Decide how (or whether) each target can be built on this machine.
// napi `--cross-compile` uses cargo-xwin for *-windows-msvc and
// cargo-zigbuild for everything else.
export function planTargets(
  targets: string[],
  host: string,
  installed: Set<string>,
  tools: { zigbuild: boolean; xwin: boolean },
): { plans: Plan[]; skipped: Skip[] } {
  const plans: Plan[] = [];
  const skipped: Skip[] = [];
  for (const triple of targets) {
    const abi = parseTriple(triple).platformArchABI;
    if (!installed.has(triple)) {
      skipped.push({ triple, abi, reason: `rustup target ${triple} is not installed` });
    } else if (triple === host || sameNativeToolchain(triple, host)) {
      plans.push({ triple, abi, tool: "native" });
    } else if (triple.endsWith("-windows-msvc")) {
      if (tools.xwin) plans.push({ triple, abi, tool: "xwin" });
      else skipped.push({ triple, abi, reason: "cargo-xwin is not installed" });
    } else if (tools.zigbuild) {
      plans.push({ triple, abi, tool: "zigbuild" });
    } else {
      skipped.push({ triple, abi, reason: "cargo-zigbuild (and zig) is not installed" });
    }
  }
  return { plans, skipped };
}

// Load every addon in `dir` that this Node can run and call into it; addons
// for other platforms are listed as skipped.
export function smoke(dir: string, binaryName: string): number {
  const require = createRequire(import.meta.url);
  const abi = hostAbi();
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".node")) : [];
  let loaded = 0;
  for (const f of files) {
    if (f !== `${binaryName}.${abi}.node`) {
      console.log(`[ci] smoke skip: ${f} (host is ${abi})`);
      continue;
    }
    const binding = require(join(dir, f)) as { add?: (a: number, b: number) => number };
    if (typeof binding.add !== "function" || binding.add(1, 2) !== 3) {
      throw new Error(`smoke test failed for ${f}`);
    }
    console.log(`[ci] smoke ok: ${f} add(1, 2) === 3`);
    loaded++;
  }
  return loaded;
}

function cross(opts: { targets?: string[]; strict: boolean; outDir: string }): void {
  const pkg = readPackage();
  const host = hostTriple();
  const wanted = opts.targets ?? pkg.targets;
  const { plans, skipped } = planTargets(wanted, host, installedRustTargets(), {
    zigbuild: has("cargo-zigbuild") && has("zig", ["version"]),
    xwin: has("cargo-xwin"),
  });
  if (skipped.length > 0) {
    for (const s of skipped) console.log(`[ci] skip ${s.triple}: ${s.reason}`);
    if (opts.strict) throw new Error(`${skipped.length} target(s) cannot be built here`);
  }
  mkdirSync(opts.outDir, { recursive: true });
  const built: string[] = [];
  for (const p of plans) {
    const args = [
      "--import",
      "@oxc-node/core/register",
      "build.ts",
      "--release",
      "--target",
      p.triple,
    ];
    if (p.tool !== "native") args.push("--cross-compile");
    sh(process.execPath, args);
    const name = `${pkg.binaryName}.${p.abi}.node`;
    const from = join(root, "dist", name);
    if (!existsSync(from)) throw new Error(`napi build did not produce ${from}`);
    const to = join(opts.outDir, name);
    copyFileSync(from, to);
    built.push(`${p.triple} (${p.tool})`);
  }
  smoke(opts.outDir, pkg.binaryName);
  console.log(`\n[ci] built ${built.length}/${wanted.length} target(s) into ${opts.outDir}`);
  for (const b of built) console.log(`[ci]   ✔ ${b}`);
  for (const s of skipped) console.log(`[ci]   ✖ ${s.triple}: ${s.reason}`);
}

function parseArgs(argv: string[]): {
  stages: Stage[];
  targets?: string[];
  strict: boolean;
  outDir: string;
} {
  const stages: Stage[] = [];
  let targets: string[] | undefined;
  let strict = false;
  let outDir = join(root, "artifacts");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--targets") targets = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--strict") strict = true;
    else if (a === "--out") outDir = join(root, argv[++i] ?? "artifacts");
    else if ((STAGES as readonly string[]).includes(a)) stages.push(a as Stage);
    else throw new Error(`unknown argument: ${a} (stages: ${STAGES.join(", ")})`);
  }
  return { stages: stages.length > 0 ? stages : DEFAULT_STAGES, targets, strict, outDir };
}

export function main(argv: string[]): void {
  const opts = parseArgs(argv);
  for (const stage of opts.stages) {
    console.log(`\n[ci] ===== ${stage} =====`);
    if (stage === "check") sh("npm", ["run", "check"]);
    else if (stage === "build") sh("npm", ["run", "build"]);
    else if (stage === "test") sh("npm", ["test"]);
    else if (stage === "cross") cross(opts);
    else if (smoke(opts.outDir, readPackage().binaryName) === 0) {
      throw new Error(`no addon in ${opts.outDir} can be loaded on ${hostAbi()}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`[ci] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
