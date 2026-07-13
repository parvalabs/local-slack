#!/usr/bin/env bun
// Phase 2 of a release: publishes the 6 npm packages, tags and pushes the
// repo, creates a GitHub release with the platform archives attached, and
// updates the Homebrew tap. Run prepare-release.ts for the SAME version
// first - this cross-checks server/src/version.ts to make sure you did,
// rather than silently publishing whatever's on disk.
//
// Usage: bun run server/scripts/publish-release.ts <version>
import { join } from "node:path";
import { homedir } from "node:os";

const PLATFORM_PACKAGES = [
  "local-slack-darwin-arm64",
  "local-slack-darwin-x64",
  "local-slack-linux-arm64",
  "local-slack-linux-x64",
  "local-slack-windows-x64",
];

// Order matters: it's also the order sha256 hashes get spliced into the
// Homebrew formula below, which only covers the first 4 (no Windows cask).
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
  console.error("Usage: bun run server/scripts/publish-release.ts <version>");
  process.exit(1);
}

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code})`);
}

const versionTsSrc = await Bun.file(join(root, "server/src/version.ts")).text();
const embedded = versionTsSrc.match(/VERSION = "([^"]+)"/)?.[1];
if (embedded !== version) {
  console.error(
    `server/src/version.ts says "${embedded}", not "${version}".\n` +
      `Run \`bun run server/scripts/prepare-release.ts ${version}\` first.`,
  );
  process.exit(1);
}

for (const name of ARCHIVES) {
  if (!(await Bun.file(join(root, "dist-bin", name)).exists())) {
    console.error(`Missing dist-bin/${name} - run prepare-release.ts ${version} first.`);
    process.exit(1);
  }
}

const tag = `v${version}`;

// 1. Publish npm packages: platform packages first, so the wrapper's
//    optionalDependencies resolve once it's published right after.
for (const name of PLATFORM_PACKAGES) {
  console.log(`\n→ npm publish ${name}@${version}`);
  await run(["npm", "publish"], join(root, "npm", name));
}
console.log(`\n→ npm publish local-slack@${version}`);
await run(["npm", "publish"], join(root, "npm/local-slack"));

// 2. Tag and push the repo.
console.log(`\n→ git tag ${tag}`);
await run(["git", "tag", tag], root);
await run(["git", "push", "origin", tag], root);

// 3. Create the GitHub release with the platform archives attached.
console.log(`\n→ gh release create ${tag}`);
await run(
  [
    "gh",
    "release",
    "create",
    tag,
    ...ARCHIVES.map((name) => join(root, "dist-bin", name)),
    "--title",
    tag,
    "--generate-notes",
  ],
  root,
);

// 4. Update the Homebrew tap (a separate repo - cloned to a stable sibling
//    directory, not a session scratchpad, so it survives across sessions).
const tapDir = join(homedir(), "Projects/homebrew-tools");
if (await Bun.file(join(tapDir, ".git/HEAD")).exists()) {
  console.log(`\n→ updating existing homebrew-tools clone at ${tapDir}`);
  await run(["git", "pull"], tapDir);
} else {
  console.log(`\n→ cloning homebrew-tools into ${tapDir}`);
  await run(["gh", "repo", "clone", "parvalabs/homebrew-tools", tapDir], root);
}

const formulaPath = join(tapDir, "Formula/local-slack.rb");
let formula = await Bun.file(formulaPath).text();
formula = formula.replace(/version "[^"]+"/, `version "${version}"`);
formula = formula.replace(/download\/v[\d.]+\//g, `download/${tag}/`);

const macAndLinuxArchives = ARCHIVES.slice(0, 4); // the formula doesn't cover Windows
const hashes: string[] = [];
for (const name of macAndLinuxArchives) {
  const bytes = await Bun.file(join(root, "dist-bin", name)).bytes();
  hashes.push(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
}
let hashIndex = 0;
formula = formula.replace(/sha256 "[a-f0-9]{64}"/g, () => `sha256 "${hashes[hashIndex++]}"`);
if (hashIndex !== hashes.length) {
  throw new Error(
    `Expected ${hashes.length} sha256 entries in the formula, found ${hashIndex} - it may have drifted from what this script expects.`,
  );
}

await Bun.write(formulaPath, formula);
await run(["git", "add", "Formula/local-slack.rb"], tapDir);
await run(["git", "commit", "-m", `Update local-slack to ${version}`], tapDir);
await run(["git", "push"], tapDir);

console.log(`\n${"=".repeat(64)}`);
console.log(`Released local-slack ${version}:`);
console.log(`  npm:      https://www.npmjs.com/package/local-slack`);
console.log(`  GitHub:   https://github.com/parvalabs/local-slack/releases/tag/${tag}`);
console.log(`  Homebrew: brew update && brew upgrade local-slack`);
console.log("=".repeat(64));
