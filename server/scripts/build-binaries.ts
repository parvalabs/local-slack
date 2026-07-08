#!/usr/bin/env bun
// Cross-compiles the standalone binary for several platforms via Bun's
// `--target=bun-<os>-<arch>` (see https://bun.com/docs/bundler/executables).
// Run `bun run build:web` first so server/public/index.html exists to embed.
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

const TARGETS: { target: string; name: string }[] = [
  { target: "bun-darwin-arm64", name: "local-slack-darwin-arm64" },
  { target: "bun-darwin-x64", name: "local-slack-darwin-x64" },
  { target: "bun-linux-x64", name: "local-slack-linux-x64" },
  { target: "bun-linux-arm64", name: "local-slack-linux-arm64" },
  { target: "bun-windows-x64", name: "local-slack-windows-x64.exe" },
];

const outDir = join(import.meta.dir, "../../dist-bin");
await mkdir(outDir, { recursive: true });

const only = process.argv[2]; // optional: build just one target, e.g. "bun-darwin-arm64"

for (const { target, name } of TARGETS) {
  if (only && target !== only) continue;
  const outfile = join(outDir, name);
  console.log(`\n→ ${target}`);
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      "--minify",
      `--target=${target}`,
      "src/cli.ts",
      `--outfile=${outfile}`,
    ],
    { cwd: join(import.meta.dir, ".."), stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`  ✗ ${target} failed (exit ${code})`);
    process.exit(code);
  }
}

console.log(`\nBinaries written to ${outDir}`);
