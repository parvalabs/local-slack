import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { webApiRouter } from "../src/web-api/router.ts";
import { filesRouter } from "../src/files/router.ts";
import { controlRouter } from "../src/control/router.ts";
import { Interactions } from "../src/interactions.ts";
import { SocketManager } from "../src/socket/manager.ts";
import { Store } from "../src/state/store.ts";
import { userPostMessage, userShareFiles } from "../src/actions.ts";
import { makeConfig, makeStore, makeGatewayStub } from "./helpers.ts";
import { json } from "./ws-helpers.ts";

const BOT = { Authorization: "Bearer xoxb-test-token" };
const stores: Store[] = [];

afterEach(() => {
  for (const s of stores.splice(0)) s.files.dispose();
});

/** The server's routes that files touch, mounted as in server.ts. */
function makeApp(storeOverrides: Partial<any> = {}) {
  const store = makeStore(storeOverrides);
  stores.push(store);
  const { gateway, calls } = makeGatewayStub();
  const interactions = new Interactions(store);
  const app = new Hono();
  app.route("/api", webApiRouter({ store, gateway, socket: new SocketManager(store), interactions }));
  app.route("/_control", controlRouter(store, gateway, interactions));
  app.route("/", filesRouter(store));
  return { app, store, calls };
}

/** Calls a Web API method the way @slack/web-api does: urlencoded, with complex
 *  values (like `files`) JSON-stringified. */
async function api(app: Hono, method: string, args: Record<string, unknown>) {
  const body = new URLSearchParams(
    Object.entries(args).map(([k, v]): [string, string] => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  );
  const res = await app.request(`/api/${method}`, {
    method: "POST",
    headers: { ...BOT, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return json(res);
}

/** The whole files.uploadV2 sequence: reserve, POST the raw bytes, complete. */
async function uploadV2(
  app: Hono,
  opts: { filename: string; content: string; complete?: Record<string, unknown>; title?: string },
) {
  const reserved = await api(app, "files.getUploadURLExternal", {
    filename: opts.filename,
    length: String(opts.content.length),
  });
  const posted = await app.request(reserved.upload_url, {
    method: "POST",
    // The SDK posts the bytes raw; axios labels a Buffer body as form-urlencoded.
    headers: { ...BOT, "Content-Type": "application/x-www-form-urlencoded" },
    body: opts.content,
  });
  expect(posted.status).toBe(200);
  const completed = await api(app, "files.completeUploadExternal", {
    files: [{ id: reserved.file_id, title: opts.title ?? opts.filename }],
    ...opts.complete,
  });
  return { fileId: reserved.file_id as string, uploadUrl: reserved.upload_url as string, completed };
}

describe("bot uploads (files.uploadV2 flow)", () => {
  test("getUploadURLExternal reserves an id and an upload_url on this server", async () => {
    const { app } = makeApp();
    const res = await api(app, "files.getUploadURLExternal", { filename: "a.txt", length: "3" });
    expect(res.ok).toBe(true);
    expect(res.file_id).toMatch(/^F/);
    expect(res.upload_url).toStartWith("http://localhost:3000/upload/v1/");
  });

  test("getUploadURLExternal requires a filename and a length", async () => {
    const { app } = makeApp();
    expect(await api(app, "files.getUploadURLExternal", { length: "3" })).toMatchObject({
      ok: false,
      error: "invalid_arguments",
    });
    expect(await api(app, "files.getUploadURLExternal", { filename: "a.txt" })).toMatchObject({
      ok: false,
      error: "invalid_arguments",
    });
  });

  test("completing with a channel posts a file_share message from the bot", async () => {
    const { app, store } = makeApp();
    const { fileId, completed } = await uploadV2(app, {
      filename: "report.csv",
      content: "a,b\n1,2\n",
      complete: { channel_id: "C01GEN", initial_comment: "here you go" },
    });

    expect(completed.ok).toBe(true);
    expect(completed.files[0]).toMatchObject({
      id: fileId,
      name: "report.csv",
      title: "report.csv",
      mimetype: "text/csv",
      filetype: "csv",
      pretty_type: "CSV",
      size: 8,
      user: "U0BOT",
      channels: ["C01GEN"],
      url_private: `http://localhost:3000/files-pri/T01TEST-${fileId}/report.csv`,
      url_private_download: `http://localhost:3000/files-pri/T01TEST-${fileId}/download/report.csv`,
    });

    const [msg] = store.channelMessages("C01GEN");
    expect(msg).toMatchObject({
      subtype: "file_share",
      user: "U0BOT",
      bot_id: "B0BOT",
      text: "here you go",
      upload: true,
      files: [{ id: fileId, name: "report.csv" }],
    });
    expect(completed.files[0].shares.public.C01GEN[0].ts).toBe(msg.ts);
  });

  test("completing without a channel keeps the file private: no message, no share", async () => {
    const { app, store } = makeApp();
    const { completed } = await uploadV2(app, { filename: "a.txt", content: "abc" });
    expect(completed.files[0].channels).toEqual([]);
    expect(completed.files[0].is_public).toBe(false);
    expect(store.channelMessages("C01GEN")).toEqual([]);
  });

  test("thread_ts shares the file as a reply in that thread", async () => {
    const { app, store } = makeApp();
    const root = await api(app, "chat.postMessage", { channel: "C01GEN", text: "root" });
    await uploadV2(app, {
      filename: "a.txt",
      content: "abc",
      complete: { channel_id: "C01GEN", thread_ts: root.ts },
    });
    const reply = store.channelMessages("C01GEN").at(-1)!;
    expect(reply.thread_ts).toBe(root.ts);
    expect(reply.files).toHaveLength(1);
  });

  test("several files completed together share as one message", async () => {
    const { app, store } = makeApp();
    const ids: string[] = [];
    for (const name of ["one.txt", "two.txt"]) {
      const r = await api(app, "files.getUploadURLExternal", { filename: name, length: "1" });
      await app.request(r.upload_url, { method: "POST", body: "x" });
      ids.push(r.file_id);
    }
    const completed = await api(app, "files.completeUploadExternal", {
      files: ids.map((id) => ({ id })),
      channel_id: "C01GEN",
    });
    expect(completed.files.map((f: any) => f.id)).toEqual(ids);
    expect(store.channelMessages("C01GEN")).toHaveLength(1);
    expect(store.channelMessages("C01GEN")[0].files!.map((f) => f.id)).toEqual(ids);
  });

  test("the upload_url also accepts a multipart body", async () => {
    const { app } = makeApp();
    const r = await api(app, "files.getUploadURLExternal", { filename: "a.txt", length: "5" });
    const form = new FormData();
    form.append("file", new File(["hello"], "a.txt"));
    const res = await app.request(r.upload_url, { method: "POST", body: form });
    expect(await res.text()).toBe("OK - 5");
  });

  test("completing before the bytes were uploaded fails, and says why in the log", async () => {
    const { app, store } = makeApp();
    const r = await api(app, "files.getUploadURLExternal", { filename: "a.txt", length: "3" });
    const res = await api(app, "files.completeUploadExternal", { files: [{ id: r.file_id }], channel_id: "C01GEN" });
    expect(res).toMatchObject({ ok: false, error: "file_not_found" });
    expect(store.log.some((e) => e.summary.includes("completed before its bytes were uploaded"))).toBe(true);
    expect(store.channelMessages("C01GEN")).toEqual([]);
  });

  test("an unknown channel fails without posting anything", async () => {
    const { app, store } = makeApp();
    const { completed } = await uploadV2(app, {
      filename: "a.txt",
      content: "abc",
      complete: { channel_id: "CNOPE" },
    });
    expect(completed).toMatchObject({ ok: false, error: "channel_not_found" });
    expect(store.channelMessages("C01GEN")).toEqual([]);
  });

  test("alt_text (what @slack/web-api sends) is accepted as alt_txt", async () => {
    const { app } = makeApp();
    const r = await api(app, "files.getUploadURLExternal", { filename: "a.png", length: "1", alt_text: "a cat" });
    await app.request(r.upload_url, { method: "POST", body: "x" });
    const info = await api(app, "files.info", { file: r.file_id });
    expect(info.file.alt_txt).toBe("a cat");
  });

  test("files.upload is refused as retired", async () => {
    const { app } = makeApp();
    expect(await api(app, "files.upload", { channels: "C01GEN", content: "hi" })).toEqual({
      ok: false,
      error: "method_deprecated",
    });
  });
});

describe("downloading url_private", () => {
  test("requires a bot token", async () => {
    const { app, store } = makeApp();
    const { completed } = await uploadV2(app, { filename: "a.txt", content: "secret" });
    const res = await app.request(completed.files[0].url_private);
    expect(res.status).toBe(403);
    expect(store.log.some((e) => e.summary.includes("refused: no valid bot token"))).toBe(true);

    const wrong = await app.request(completed.files[0].url_private, { headers: { Authorization: "Bearer nope" } });
    expect(wrong.status).toBe(403);
  });

  test("serves the bytes inline with a bot token, as an attachment from the download URL", async () => {
    const { app } = makeApp();
    const { completed } = await uploadV2(app, { filename: "a.txt", content: "secret" });

    const inline = await app.request(completed.files[0].url_private, { headers: BOT });
    expect(inline.status).toBe(200);
    expect(await inline.text()).toBe("secret");
    expect(inline.headers.get("content-type")).toStartWith("text/plain");
    expect(inline.headers.get("content-disposition")).toStartWith("inline");

    const download = await app.request(completed.files[0].url_private_download, { headers: BOT });
    expect(await download.text()).toBe("secret");
    expect(download.headers.get("content-disposition")).toStartWith("attachment");
  });

  test("the permalink is the browser view: no token needed", async () => {
    const { app } = makeApp();
    const { completed } = await uploadV2(app, { filename: "a.txt", content: "abc" });
    const res = await app.request(completed.files[0].permalink);
    expect(await res.text()).toBe("abc");
  });
});

describe("files.info / files.list / files.delete", () => {
  test("files.info returns the file, and file_not_found for an unknown id", async () => {
    const { app } = makeApp();
    const { fileId } = await uploadV2(app, { filename: "a.txt", content: "abc" });
    expect((await api(app, "files.info", { file: fileId })).file.id).toBe(fileId);
    expect(await api(app, "files.info", { file: "FNOPE" })).toMatchObject({ ok: false, error: "file_not_found" });
  });

  test("files.list filters by channel and type, newest first", async () => {
    const { app } = makeApp();
    await uploadV2(app, { filename: "a.png", content: "x", complete: { channel_id: "C01GEN" } });
    await uploadV2(app, { filename: "b.txt", content: "x", complete: { channel_id: "C02RND" } });

    const all = await api(app, "files.list", {});
    expect(all.files.map((f: any) => f.name).sort()).toEqual(["a.png", "b.txt"]);
    expect(all.paging).toMatchObject({ total: 2, page: 1, pages: 1 });

    expect((await api(app, "files.list", { channel: "C02RND" })).files.map((f: any) => f.name)).toEqual(["b.txt"]);
    expect((await api(app, "files.list", { types: "images" })).files.map((f: any) => f.name)).toEqual(["a.png"]);
  });

  test("files.delete tombstones the file in its messages and removes the bytes", async () => {
    const { app, store } = makeApp();
    const { fileId, completed } = await uploadV2(app, {
      filename: "a.txt",
      content: "abc",
      complete: { channel_id: "C01GEN" },
    });
    const path = store.files.get(fileId)!.path!;
    expect(existsSync(path)).toBe(true);

    expect(await api(app, "files.delete", { file: fileId })).toEqual({ ok: true });
    expect(store.channelMessages("C01GEN")[0].files).toEqual([{ id: fileId, mode: "tombstone" }]);
    expect(existsSync(path)).toBe(false);
    expect(await api(app, "files.info", { file: fileId })).toMatchObject({ ok: false, error: "file_deleted" });
    expect((await app.request(completed.files[0].url_private, { headers: BOT })).status).toBe(404);
  });

  test("a bot can't delete a file a human uploaded", async () => {
    const { app, store } = makeApp();
    const { gateway } = makeGatewayStub();
    const shared = await userShareFiles(store, gateway, {
      channel: "C01GEN",
      user: "U01ALICE",
      files: [new File(["abc"], "mine.txt")],
    });
    const fileId = shared.ok ? shared.message.files![0].id : "";
    expect(await api(app, "files.delete", { file: fileId })).toMatchObject({ ok: false, error: "cant_delete_file" });
  });
});

describe("human uploads", () => {
  test("deliver a file_share message event with the files, then file_shared", async () => {
    const store = makeStore();
    stores.push(store);
    const { gateway, calls } = makeGatewayStub();
    const res = await userShareFiles(store, gateway, {
      channel: "C01GEN",
      user: "U01ALICE",
      text: "look",
      files: [new File(["abc"], "notes.txt")],
    });
    expect(res.ok).toBe(true);
    const fileId = res.ok ? res.message.files![0].id : "";

    expect(calls.map((c) => (c.payload as any).type)).toEqual(["message", "file_shared"]);
    expect(calls[0].payload).toMatchObject({
      type: "message",
      subtype: "file_share",
      channel: "C01GEN",
      user: "U01ALICE",
      text: "look",
      upload: true,
      files: [{ id: fileId, name: "notes.txt", size: 3 }],
    });
    expect(calls[1].payload).toMatchObject({
      type: "file_shared",
      channel_id: "C01GEN",
      file_id: fileId,
      user_id: "U01ALICE",
      file: { id: fileId },
    });
  });

  test("a comment that mentions the app also delivers app_mention, carrying the files", async () => {
    const store = makeStore();
    stores.push(store);
    const { gateway, calls } = makeGatewayStub();
    const res = await userShareFiles(store, gateway, {
      channel: "C01GEN",
      user: "U01ALICE",
      text: "<@U0BOT> summarize this",
      files: [new File(["abc"], "a.txt")],
    });
    expect(calls.map((c) => (c.payload as any).type)).toEqual(["message", "app_mention", "file_shared"]);

    const fileId = res.ok ? res.message.files![0].id : "";
    const mention = calls[1].payload as any;
    expect(mention).toMatchObject({
      type: "app_mention",
      user: "U01ALICE",
      text: "<@U0BOT> summarize this",
      upload: true,
      files: [{ id: fileId, name: "a.txt", size: 3 }],
    });
    // Same file objects as the message event, so either handler can download it.
    expect(mention.files).toEqual((calls[0].payload as any).files);
    expect(mention.files[0].url_private_download).toContain(fileId);
  });

  test("a plain mention, with no upload, carries no files", async () => {
    const store = makeStore();
    stores.push(store);
    const { gateway, calls } = makeGatewayStub();
    await userPostMessage(store, gateway, { channel: "C01GEN", user: "U01ALICE", text: "<@U0BOT> hi" });
    const mention = calls.find((c) => (c.payload as any).type === "app_mention")!.payload as any;
    expect(mention).not.toHaveProperty("files");
    expect(mention).not.toHaveProperty("upload");
  });

  test("the control API takes a multipart upload, into a thread", async () => {
    const { app, store, calls } = makeApp();
    const form = new FormData();
    form.append("channel", "C01GEN");
    form.append("user", "U01ALICE");
    form.append("thread_ts", "1700000000.000001");
    form.append("file", new File(["one"], "one.txt"));
    form.append("file", new File(["two"], "two.txt"));
    const res = await json(await app.request("/_control/upload", { method: "POST", body: form }));

    expect(res.ok).toBe(true);
    expect(res.message.thread_ts).toBe("1700000000.000001");
    expect(res.message.files.map((f: any) => f.name)).toEqual(["one.txt", "two.txt"]);
    expect(store.channelMessages("C01GEN")).toHaveLength(1);
    expect(calls.filter((c) => (c.payload as any).type === "file_shared")).toHaveLength(2);
  });

  test("the control API rejects an upload with no file, or to an unknown channel", async () => {
    const { app } = makeApp();
    const noFile = new FormData();
    noFile.append("channel", "C01GEN");
    noFile.append("user", "U01ALICE");
    expect((await app.request("/_control/upload", { method: "POST", body: noFile })).status).toBe(400);

    const badChannel = new FormData();
    badChannel.append("channel", "CNOPE");
    badChannel.append("user", "U01ALICE");
    badChannel.append("file", new File(["x"], "x.txt"));
    const res = await app.request("/_control/upload", { method: "POST", body: badChannel });
    expect(await json(res)).toMatchObject({ ok: false, error: "channel_not_found" });
  });
});

describe("storage", () => {
  test("reset forgets files and removes their bytes", async () => {
    const { app, store } = makeApp();
    const { fileId } = await uploadV2(app, { filename: "a.txt", content: "abc" });
    const path = store.files.get(fileId)!.path!;

    store.reset();
    expect(existsSync(path)).toBe(false);
    expect(store.files.get(fileId)).toBeUndefined();
  });

  test("the default temp dir is removed on dispose, but a chosen --files-dir is kept", async () => {
    const temp = makeStore();
    const { file } = temp.files.create({ name: "a.txt", user: "U01ALICE" });
    await temp.files.write(file, new TextEncoder().encode("abc"));
    const tempDir = temp.files.dir;
    temp.files.dispose();
    expect(existsSync(tempDir)).toBe(false);

    const chosenDir = mkdtempSync(join(tmpdir(), "local-slack-test-"));
    try {
      const chosen = new Store(makeConfig(), { filesDir: chosenDir });
      const { file: kept } = chosen.files.create({ name: "a.txt", user: "U01ALICE" });
      await chosen.files.write(kept, new TextEncoder().encode("abc"));
      chosen.files.dispose();
      expect(existsSync(kept.path!)).toBe(true);
    } finally {
      rmSync(chosenDir, { recursive: true, force: true });
    }
  });

  test("a store that never stores a file never creates a dir", () => {
    const store = makeStore();
    store.files.dispose();
    expect((store.files as any).resolvedDir).toBeUndefined();
  });
});
