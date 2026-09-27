#!/usr/bin/env bun
// Phase 2 of a release: publishes the 6 npm packages, tags and pushes the
// repo, creates a GitHub release with the platform archives attached, and
// updates the Homebrew tap. Run prepare-release.ts for the SAME version
// first - this cross-checks server/src/version.ts to make sure you did,
// rather than silently publishing whatever's on disk.
//
// Runs the same way by hand or from .github/workflows/release.yml, which
// differs only in what the environment provides:
//   DRY_RUN=1            print every command instead of running it
//   HOMEBREW_TAP_DIR     where to clone/find the tap (default: ~/Projects/homebrew-tools)
//   HOMEBREW_TAP_TOKEN   push to the tap over HTTPS instead of the local gh/ssh auth
//   NPM_PROVENANCE=1     publish with --provenance (needs CI OIDC; see the workflow)
//   CI                   commit to the tap as github-actions[bot], which has no git identity
// The tag is created only when it doesn't already exist, so a CI run triggered
// *by* that tag skips the step rather than failing on it.
//
// Usage: bun run server/scripts/publish-release.ts <version> [--dry-run]
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

const dryRun = process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");
if (dryRun) console.log("DRY RUN - printing what would happen, changing nothing.\n");

// The tap token travels in a clone URL, so it would otherwise show up in the
// dry-run listing and in any failure message. CI masks known secrets in logs,
// but that's the log's safety net, not this script's.
const SECRETS = [process.env.HOMEBREW_TAP_TOKEN].filter((v): v is string => !!v);
const redact = (text: string) => SECRETS.reduce((out, secret) => out.replaceAll(secret, "***"), text);

async function run(cmd: string[], cwd: string) {
  if (dryRun) {
    console.log(redact(`  [dry-run] ${cmd.join(" ")}${cwd === root ? "" : `   (in ${cwd})`}`));
    return;
  }
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(redact(`${cmd.join(" ")} failed (exit ${code})`));
}

async function capture(cmd: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

/** For reads whose answer decides what happens next — always run, even in a
 *  dry run, since skipping them would report a different plan than the real one. */
async function succeeds(cmd: string[], cwd: string): Promise<boolean> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

async function write(path: string, contents: string) {
  if (dryRun) {
    console.log(`  [dry-run] write ${path}`);
    return;
  }
  await Bun.write(path, contents);
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
// --provenance attaches a signed attestation linking the package to the
// workflow run that built it. It needs the OIDC token only CI has, so it's
// opt-in rather than something that would break local publishing.
const npmPublish = ["npm", "publish", ...(process.env.NPM_PROVENANCE === "1" ? ["--provenance"] : [])];

// Every step below skips work that's already done, so this is safe to re-run:
// after a half-finished release (one registry accepted, the next failed), and
// when a local publish and the tag-triggered workflow both run.
async function publishPackage(name: string) {
  if ((await capture(["npm", "view", `${name}@${version}`, "version"], root)) === version) {
    console.log(`\n→ ${name}@${version} is already on npm, skipping`);
    return;
  }
  console.log(`\n→ npm publish ${name}@${version}`);
  await run(npmPublish, join(root, "npm", name === "local-slack" ? "local-slack" : name));
}
for (const name of PLATFORM_PACKAGES) await publishPackage(name);
await publishPackage("local-slack");

// 2. Tag and push the repo — unless the tag is already there, which is the
//    normal case in CI, where pushing it is what started this run.
if (await succeeds(["git", "rev-parse", "-q", "--verify", `refs/tags/${tag}`], root)) {
  console.log(`\n→ ${tag} already exists, leaving it alone`);
} else {
  console.log(`\n→ git tag ${tag}`);
  await run(["git", "tag", tag], root);
  await run(["git", "push", "origin", tag], root);
}

// 3. Create the GitHub release with the platform archives attached.
//    On a re-run the release is already there, but its assets came from the
//    previous run's build. Those bytes aren't reproducible (archives carry
//    timestamps), so they'd no longer match the sha256s step 4 computes from
//    the local archives — and a Homebrew formula whose checksums don't match
//    what it downloads fails every `brew install`. Re-uploading keeps the
//    assets and the formula describing the same bytes.
const archivePaths = ARCHIVES.map((name) => join(root, "dist-bin", name));
if (await succeeds(["gh", "release", "view", tag], root)) {
  console.log(`\n→ GitHub release ${tag} exists, re-uploading its archives to match this build`);
  await run(["gh", "release", "upload", tag, ...archivePaths, "--clobber"], root);
} else {
  console.log(`\n→ gh release create ${tag}`);
  await run(["gh", "release", "create", tag, ...archivePaths, "--title", tag, "--generate-notes"], root);
}

// 4. Update the Homebrew tap (a separate repo - cloned to a stable sibling
//    directory, not a session scratchpad, so it survives across sessions).
const tapDir = process.env.HOMEBREW_TAP_DIR || join(homedir(), "Projects/homebrew-tools");
const tapToken = process.env.HOMEBREW_TAP_TOKEN;
if (await Bun.file(join(tapDir, ".git/HEAD")).exists()) {
  console.log(`\n→ updating existing homebrew-tools clone at ${tapDir}`);
  await run(["git", "pull"], tapDir);
} else {
  console.log(`\n→ cloning homebrew-tools into ${tapDir}`);
  // A token clones over HTTPS (CI has no gh login or ssh key); otherwise use
  // whatever credentials gh already holds locally.
  await run(
    tapToken
      ? ["git", "clone", `https://x-access-token:${tapToken}@github.com/parvalabs/homebrew-tools.git`, tapDir]
      : ["gh", "repo", "clone", "parvalabs/homebrew-tools", tapDir],
    root,
  );
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

const alreadyTapped = (await Bun.file(formulaPath).text()) === formula;
if (alreadyTapped) {
  console.log(`\n→ the tap's formula is already at ${version}, skipping`);
}
await write(formulaPath, formula);
// CI's checkout has no committer identity of its own.
const asBot = process.env.CI
  ? ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com"]
  : [];
if (!alreadyTapped) {
  await run(["git", "add", "Formula/local-slack.rb"], tapDir);
  await run(["git", ...asBot, "commit", "-m", `Update local-slack to ${version}`], tapDir);
  await run(["git", "push"], tapDir);
}

console.log(`\n${"=".repeat(64)}`);
console.log(`Released local-slack ${version}:`);
console.log(`  npm:      https://www.npmjs.com/package/local-slack`);
console.log(`  GitHub:   https://github.com/parvalabs/local-slack/releases/tag/${tag}`);
console.log(`  Homebrew: brew update && brew upgrade local-slack`);
console.log("=".repeat(64));
