import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, type Config } from "./schema.ts";

export async function loadConfig(path: string): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${path}`);
  }
  const raw = await file.text();
  const ext = path.split(".").pop()?.toLowerCase();
  const data = (ext === "json" ? JSON.parse(raw) : parseYaml(raw)) ?? {};

  // Back-compat: a single `app:` object normalizes to `apps: [app]`.
  if (data.app && !data.apps) {
    data.apps = [data.app];
    delete data.app;
  }

  const parsed = ConfigSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config (${path}):\n${issues}`);
  }

  const config = parsed.data;
  for (const app of config.apps) {
    if (app.mode === "events" && !app.requestUrl) {
      throw new Error(`app "${app.appId}" has mode "events" but no requestUrl is set.`);
    }
  }

  // Emoji image paths are relative to the config file, not the process cwd —
  // rewrite them to absolute paths now so the rest of the server never needs
  // to know where the config file lives. Fail fast on a typo'd/missing path
  // rather than 404ing later whenever something tries to render the emoji.
  const configDir = dirname(path);
  for (const [name, imgPath] of Object.entries(config.emojis)) {
    const abs = isAbsolute(imgPath) ? imgPath : resolve(configDir, imgPath);
    if (!(await Bun.file(abs).exists())) {
      throw new Error(`emoji "${name}" image not found: ${abs}`);
    }
    config.emojis[name] = abs;
  }

  return config;
}
