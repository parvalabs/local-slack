#!/usr/bin/env bun
// Publishes the local-slack npm packages: the 5 prebuilt-binary platform
// packages first (so the wrapper's optionalDependencies resolve), then the
// thin `local-slack` wrapper itself (see npm/local-slack/bin.js).
//
// Binaries must already be staged into npm/local-slack-*/bin/ via
// `bun run build:binaries` - this script does NOT rebuild them, so a stale
// checksum/version pairing is a signal to go run that first, not silently
// republish whatever happens to be on disk. Bump server/src/version.ts
// *before* that build step (it's compiled into the binary), then pass the
// same version here - this script cross-checks the two match rather than
// silently overwriting version.ts after the fact, which would be too late
// for binaries already compiled with the old value.
//
// Usage: bun run server/scripts/publish-npm.ts <version>
import { join } from "node:path";

const PLATFORM_PACKAGES = [
  "local-slack-darwin-arm64",
  "local-slack-darwin-x64",
  "local-slack-linux-arm64",
  "local-slack-linux-x64",
  "local-slack-windows-x64",
];

const root = join(import.meta.dir, "../..");
const npmDir = join(root, "npm");

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error("Usage: bun run server/scripts/publish-npm.ts <version>");
  process.exit(1);
}

const versionTsPath = join(root, "server/src/version.ts");
const versionTsSrc = await Bun.file(versionTsPath).text();
const embedded = versionTsSrc.match(/VERSION = "([^"]+)"/)?.[1];
if (embedded !== version) {
  console.error(
    `server/src/version.ts says "${embedded}", but you're publishing "${version}".\n` +
      `Update version.ts and re-run \`bun run build:binaries\` first - otherwise the ` +
      `binaries being published would still self-report the old version via \`local-slack -v\`.`,
  );
  process.exit(1);
}

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code})`);
}

async function setVersion(pkgDir: string, newVersion: string, optionalDeps?: string[]) {
  const pkgPath = join(pkgDir, "package.json");
  const pkg = await Bun.file(pkgPath).json();
  pkg.version = newVersion;
  if (optionalDeps) {
    for (const dep of optionalDeps) {
      if (pkg.optionalDependencies?.[dep]) pkg.optionalDependencies[dep] = newVersion;
    }
  }
  await Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

// 1. Sync the version across all 6 package.json files (platform packages, plus
//    the wrapper's own version and its optionalDependencies pins).
for (const name of PLATFORM_PACKAGES) {
  await setVersion(join(npmDir, name), version);
}
await setVersion(join(npmDir, "local-slack"), version, PLATFORM_PACKAGES);

// 2. Publish platform packages first.
for (const name of PLATFORM_PACKAGES) {
  console.log(`\n→ publishing ${name}@${version}`);
  await run(["npm", "publish"], join(npmDir, name));
}

// 3. Publish the wrapper last, once its dependencies actually exist on the registry.
console.log(`\n→ publishing local-slack@${version}`);
await run(["npm", "publish"], join(npmDir, "local-slack"));

console.log(`\nPublished local-slack@${version} to npm.`);
