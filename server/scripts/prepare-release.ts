#!/usr/bin/env bun
// Phase 1 of a release: bumps the version everywhere it's recorded, rebuilds
// every platform binary + npm package with it embedded, and prints a summary
// (checksums, what changed) to review before anything actually gets published.
// Phase 2 is publish-release.ts, run separately once you've looked this over -
// keeping them apart is the confirmation checkpoint, not a prompt buried in
// a script that publishes to three registries.
//
// Usage: bun run server/scripts/prepare-release.ts <version>   (e.g. 0.2.0)
import { join } from "node:path";

const PLATFORM_PACKAGES = [
  "local-slack-darwin-arm64",
  "local-slack-darwin-x64",
  "local-slack-linux-arm64",
  "local-slack-linux-x64",
  "local-slack-windows-x64",
];

const ARCHIVES = [
  "local-slack-darwin-arm64.tar.gz",
  "local-slack-darwin-x64.tar.gz",
  "local-slack-linux-arm64.tar.gz",
  "local-slack-linux-x64.tar.gz",
  "local-slack-windows-x64.zip",
];

const root = join(import.meta.dir, "../..");

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: bun run server/scripts/prepare-release.ts <version>  (e.g. 0.2.0)");
  process.exit(1);
}

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code})`);
}

async function setPackageVersion(pkgPath: string, newVersion: string, optionalDeps?: string[]) {
  const pkg = await Bun.file(pkgPath).json();
  pkg.version = newVersion;
  if (optionalDeps) {
    for (const dep of optionalDeps) {
      if (pkg.optionalDependencies?.[dep]) pkg.optionalDependencies[dep] = newVersion;
    }
  }
  await Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

const versionTsPath = join(root, "server/src/version.ts");
const versionTsSrc = await Bun.file(versionTsPath).text();
const current = versionTsSrc.match(/VERSION = "([^"]+)"/)?.[1];
if (current === version) {
  console.error(`Already at ${version} (server/src/version.ts). Pick a different version.`);
  process.exit(1);
}

console.log(`Bumping ${current} -> ${version}\n`);

// 1. The CLI's self-reported version - must land before the build step below,
//    since it's compiled directly into the binary (see server/src/cli.ts -v).
await Bun.write(versionTsPath, versionTsSrc.replace(/VERSION = "[^"]+"/, `VERSION = "${version}"`));

// 2. Workspace package.json files - not published, but kept honest.
for (const rel of ["package.json", "server/package.json", "web/package.json"]) {
  await setPackageVersion(join(root, rel), version);
}

// 3. The 6 npm packages (5 platform packages, then the wrapper that pins them
//    all as optionalDependencies).
for (const name of PLATFORM_PACKAGES) {
  await setPackageVersion(join(root, "npm", name, "package.json"), version);
}
await setPackageVersion(join(root, "npm/local-slack/package.json"), version, PLATFORM_PACKAGES);

// 4. Rebuild everything so the binaries actually embed the new version.
console.log("Building binaries...\n");
await run(["bun", "run", "build:binaries"], root);

// 5. Summarize what's ready, and how to verify it before publishing for real.
console.log(`\n${"=".repeat(64)}`);
console.log(`Prepared v${version}. Archive checksums:\n`);
for (const name of ARCHIVES) {
  const bytes = await Bun.file(join(root, "dist-bin", name)).bytes();
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  console.log(`  ${hash}  ${name}`);
}
console.log(`
Review \`git diff\` before publishing. Sanity-check a binary directly, e.g.:
  ./npm/local-slack-darwin-arm64/bin/local-slack -v   # should print ${version}

When ready:
  bun run server/scripts/publish-release.ts ${version}
`);
console.log("=".repeat(64));
