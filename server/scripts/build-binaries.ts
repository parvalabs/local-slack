#!/usr/bin/env bun
// Cross-compiles the standalone binary for several platforms via Bun's
// `--target=bun-<os>-<arch>` (see https://bun.com/docs/bundler/executables),
// ad-hoc code-signs the macOS outputs, and packages everything as an archive
// *and* stages a raw copy into the matching npm/local-slack-<suffix>/bin/
// package (see npm/local-slack/bin.js, which execs whichever one npm's
// os/cpu-matched optionalDependencies resolution actually installed).
//
// Two reasons for the archive step, not just the raw binary:
//  - GitHub Releases (like most file-transfer paths) don't preserve the Unix
//    executable bit on raw binary uploads; tar/zip carry it themselves, so
//    it's restored correctly on extract.
//  - Ad-hoc signing (no certificate, no paid Apple Developer account) doesn't
//    get Gatekeeper's full trust, but it's what turns a flat "is damaged, move
//    to Trash" refusal into a bypassable "unidentified developer" warning
//    (right-click Open, or approve once in System Settings > Privacy &
//    Security). Full notarization needs a real Apple Developer account.
//
// Run `bun run build:web` first so server/public/index.html exists to embed.
import { join } from "node:path";
import { mkdir, rm, copyFile, chmod } from "node:fs/promises";

const TARGETS: { target: string; os: "darwin" | "linux" | "windows"; suffix: string }[] = [
  { target: "bun-darwin-arm64", os: "darwin", suffix: "darwin-arm64" },
  { target: "bun-darwin-x64", os: "darwin", suffix: "darwin-x64" },
  { target: "bun-linux-x64", os: "linux", suffix: "linux-x64" },
  { target: "bun-linux-arm64", os: "linux", suffix: "linux-arm64" },
  { target: "bun-windows-x64", os: "windows", suffix: "windows-x64" },
];

const root = join(import.meta.dir, "..");
const outDir = join(root, "../dist-bin");
const stageDir = join(outDir, ".stage");
const npmDir = join(root, "../npm");
await rm(stageDir, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code})`);
}

const only = process.argv[2]; // optional: build just one target, e.g. "bun-darwin-arm64"

for (const { target, os, suffix } of TARGETS) {
  if (only && target !== only) continue;
  console.log(`\n→ ${target}`);

  const binName = os === "windows" ? "local-slack.exe" : "local-slack";
  const binPath = join(stageDir, binName);
  await run(
    ["bun", "build", "--compile", "--minify", `--target=${target}`, "src/cli.ts", `--outfile=${binPath}`],
    root,
  );

  if (os === "darwin") {
    await run(["codesign", "--force", "--sign", "-", binPath], root);
  }

  const archiveName = `local-slack-${suffix}${os === "windows" ? ".zip" : ".tar.gz"}`;
  const archivePath = join(outDir, archiveName);
  if (os === "windows") {
    await run(["zip", "-j", archivePath, binPath], root);
  } else {
    await run(["chmod", "+x", binPath], root);
    await run(["tar", "-czf", archivePath, "-C", stageDir, binName], root);
  }

  const npmBinPath = join(npmDir, `local-slack-${suffix}`, "bin", binName);
  await copyFile(binPath, npmBinPath);
  if (os !== "windows") await chmod(npmBinPath, 0o755);

  await rm(binPath);
  console.log(`  packaged ${archiveName}, staged npm/local-slack-${suffix}/bin/${binName}`);
}

await rm(stageDir, { recursive: true, force: true });
console.log(`\nArchives written to ${outDir}`);
