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
    expect(config.apps).toHaveLength(1);
    expect(config.apps[0].botUserId).toBe("U0BOT"); // default
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
    expect(config.apps[0].mode).toBe("events");
    expect(config.apps[0].requestUrl).toBe("http://localhost:4000/slack/events");
  });

  test("rejects malformed data (wrong types)", async () => {
    const path = await writeTmp("malformed.yaml", `users:\n  - { id: 123, name: alice }\n`);
    await expect(loadConfig(path)).rejects.toThrow(/Invalid config/);
  });

  test("accepts multiple apps declared under `apps:`, each with independent settings", async () => {
    const path = await writeTmp(
      "multi-app.yaml",
      `
apps:
  - { appId: A1, botUserId: U1BOT, botToken: xoxb-one, mode: socket }
  - { appId: A2, botUserId: U2BOT, botToken: xoxb-two, mode: events, requestUrl: http://localhost:4001/events }
`,
    );
    const config = await loadConfig(path);
    expect(config.apps).toHaveLength(2);
    expect(config.apps.map((a) => a.appId)).toEqual(["A1", "A2"]);
    expect(config.apps[1].requestUrl).toBe("http://localhost:4001/events");
  });

  test("rejects duplicate appId across apps", async () => {
    const path = await writeTmp(
      "dup-appid.yaml",
      `apps:\n  - { appId: A1, botUserId: U1BOT, botToken: t1 }\n  - { appId: A1, botUserId: U2BOT, botToken: t2 }\n`,
    );
    await expect(loadConfig(path)).rejects.toThrow(/appId must be unique/);
  });

  test("rejects duplicate botToken across apps", async () => {
    const path = await writeTmp(
      "dup-token.yaml",
      `apps:\n  - { appId: A1, botUserId: U1BOT, botToken: same-token }\n  - { appId: A2, botUserId: U2BOT, botToken: same-token }\n`,
    );
    await expect(loadConfig(path)).rejects.toThrow(/botToken must be unique/);
  });

  test("a legacy singular `app:` key is normalized to a one-element `apps` array", async () => {
    const path = await writeTmp("legacy-app.yaml", `app:\n  appId: LEGACY\n  mode: socket\n`);
    const config = await loadConfig(path);
    expect(config.apps).toHaveLength(1);
    expect(config.apps[0].appId).toBe("LEGACY");
  });

  test("resolves emoji image paths relative to the config file's directory", async () => {
    const imgPath = await writeTmp("smile.png", "fake-image-bytes");
    const imgName = imgPath.split("/").pop();
    const path = await writeTmp("with-emoji.yaml", `emojis:\n  custom_smile: ${imgName}\n`);
    const config = await loadConfig(path);
    expect(config.emojis.custom_smile).toBe(imgPath);
  });

  test("throws when a declared emoji image file does not exist", async () => {
    const path = await writeTmp("missing-emoji.yaml", `emojis:\n  custom_smile: does-not-exist.png\n`);
    await expect(loadConfig(path)).rejects.toThrow(/emoji "custom_smile" image not found/);
  });
});
