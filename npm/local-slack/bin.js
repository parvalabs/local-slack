#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const { dirname, join } = require("node:path");

const PLATFORM_PACKAGES = {
  "darwin-arm64": "local-slack-darwin-arm64",
  "darwin-x64": "local-slack-darwin-x64",
  "linux-arm64": "local-slack-linux-arm64",
  "linux-x64": "local-slack-linux-x64",
  "win32-x64": "local-slack-windows-x64",
};

const key = `${process.platform}-${process.arch}`;
const pkgName = PLATFORM_PACKAGES[key];

if (!pkgName) {
  console.error(
    `local-slack: no prebuilt binary for ${key}.\n` +
      `Supported platforms: ${Object.keys(PLATFORM_PACKAGES).join(", ")}`,
  );
  process.exit(1);
}

let binPath;
try {
  const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
  const binName = process.platform === "win32" ? "local-slack.exe" : "local-slack";
  binPath = join(dirname(pkgJsonPath), "bin", binName);
} catch {
  console.error(
    `local-slack: couldn't find the ${pkgName} package.\n` +
      `This usually means its optional dependency failed to install - try reinstalling.`,
  );
  process.exit(1);
}

const result = spawnSync(binPath, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(`local-slack: failed to run ${binPath}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
