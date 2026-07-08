#!/usr/bin/env bun
// Stages the built single-file web UI into server/public/, so the server package is
// self-contained (works when published/installed standalone via bunx/npx, not just
// when run from inside this monorepo). Run after `web`'s build; see root package.json.
import { join } from "node:path";

const src = join(import.meta.dir, "../../web/dist/index.html");
const dest = join(import.meta.dir, "../public/index.html");

const file = Bun.file(src);
if (!(await file.exists())) {
  console.error(`\n  ✗ ${src} does not exist — run \`bun run build\` in web/ first.\n`);
  process.exit(1);
}

await Bun.write(dest, file);
console.log(`  staged UI: ${src} -> ${dest}`);
