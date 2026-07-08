import { describe, test, expect, afterEach } from "bun:test";
import { loadConfig } from "../src/config/load.ts";

const tmpFiles: string[] = [];
async function writeTmp(name: string, content: string): Promise<string> {
  const path = `/tmp/local-slack-test-${Date.now()}-${name}`;
  await Bun.write(path, content);
  tmpFiles.push(path);
  return path;
}

afterEach(async () => {
  for (const f of tmpFiles.splice(0)) await Bun.file(f).delete().catch(() => {});
});

describe("loadConfig", () => {
  test("parses a valid YAML config with defaults filled in", async () => {
    const path = await writeTmp(
      "valid.yaml",
      `
workspace:
  name: My Workspace
app:
  mode: socket
users:
  - { id: U1, name: alice }
channels:
  - { id: C1, name: general, members: [U1] }
`,
    );
    const config = await loadConfig(path);
    expect(config.workspace.name).toBe("My Workspace");
    expect(config.workspace.teamId).toBe("T01TEST"); // default
    expect(config.app.botUserId).toBe("U0BOT"); // default
    expect(config.users).toHaveLength(1);
    expect(config.channels[0].members).toEqual(["U1"]);
  });

  test("parses a JSON config", async () => {
    const path = await writeTmp(
      "valid.json",
      JSON.stringify({ workspace: { name: "JSON WS" }, app: { mode: "socket" } }),
    );
    const config = await loadConfig(path);
    expect(config.workspace.name).toBe("JSON WS");
  });

  test("throws when the file does not exist", async () => {
    await expect(loadConfig("/tmp/does-not-exist-local-slack.yaml")).rejects.toThrow(
      /not found/i,
    );
  });

  test("throws when mode is events but requestUrl is missing", async () => {
    const path = await writeTmp("bad-events.yaml", `app:\n  mode: events\n`);
    await expect(loadConfig(path)).rejects.toThrow(/requestUrl/);
  });

  test("succeeds when mode is events and requestUrl is set", async () => {
    const path = await writeTmp(
      "good-events.yaml",
      `app:\n  mode: events\n  requestUrl: http://localhost:4000/slack/events\n`,
    );
    const config = await loadConfig(path);
    expect(config.app.mode).toBe("events");
    expect(config.app.requestUrl).toBe("http://localhost:4000/slack/events");
  });

  test("rejects malformed data (wrong types)", async () => {
    const path = await writeTmp("malformed.yaml", `users:\n  - { id: 123, name: alice }\n`);
    await expect(loadConfig(path)).rejects.toThrow(/Invalid config/);
  });
});
