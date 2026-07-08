import { parse as parseYaml } from "yaml";
import { ConfigSchema, type Config } from "./schema.ts";

export async function loadConfig(path: string): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${path}`);
  }
  const raw = await file.text();
  const ext = path.split(".").pop()?.toLowerCase();
  const data = ext === "json" ? JSON.parse(raw) : parseYaml(raw);

  const parsed = ConfigSchema.safeParse(data ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config (${path}):\n${issues}`);
  }

  const config = parsed.data;
  if (config.app.mode === "events" && !config.app.requestUrl) {
    throw new Error('app.mode is "events" but app.requestUrl is not set.');
  }
  return config;
}
