import { Hono, type Context } from "hono";
import type { Store } from "../state/store.ts";
import type { StoredFile } from "../state/files.ts";

/**
 * The non-API URLs that come with files:
 *
 *   POST /upload/v1/:token                    upload_url from files.getUploadURLExternal
 *   GET  /files-pri/:team-:file/:name         url_private            (bot token required)
 *   GET  /files-pri/:team-:file/download/:name url_private_download  (bot token required)
 *   GET  /files/:user/:file/:name             permalink — the browser view the UI uses
 */
export function filesRouter(store: Store) {
  const app = new Hono();

  // Accepts the bytes raw — how @slack/web-api and slack_sdk send them, whatever
  // Content-Type they label it with — or as a multipart form, which Slack also takes.
  app.post("/upload/v1/:token", async (c) => {
    const file = store.files.byUploadToken(c.req.param("token"));
    if (!file || file.deleted) return c.text("Not Found", 404);

    let data: Blob | ArrayBuffer;
    if ((c.req.header("content-type") ?? "").toLowerCase().includes("multipart/form-data")) {
      const form = await c.req.formData();
      const part: unknown =
        form.get("file") ?? [...form.values()].find((v: unknown) => v instanceof File);
      if (!(part instanceof File)) return c.text("no file in multipart body", 400);
      data = part;
    } else {
      data = await c.req.arrayBuffer();
    }
    await store.files.write(file, data);
    store.addLog("from_bot", "files", `upload ${file.id} ${file.name} (${file.size} bytes)`);
    return c.text(`OK - ${file.size}`);
  });

  const privateFile = (disposition: "inline" | "attachment") => (c: Context) => {
    const file = byTeamFileId(store, c.req.param("teamFile"));
    if (!file) return c.text("Not Found", 404);

    // As in Slack, these URLs are only readable with a token — and forgetting the
    // header is the classic file bug. Where Slack answers with its sign-in page,
    // this says what's missing.
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!store.config.apps.some((a) => a.botToken === token)) {
      store.addLog("internal", "files", `GET ${file.name} refused: no valid bot token`, {
        hint: "send `Authorization: Bearer <bot token>` when fetching url_private / url_private_download",
      });
      return c.text(
        `${file.name} requires "Authorization: Bearer <bot token>" (real Slack serves its sign-in page instead)\n`,
        403,
      );
    }
    store.addLog("from_bot", "files", `download ${file.id} ${file.name}`);
    return serve(file, disposition);
  };
  app.get("/files-pri/:teamFile/download/:name", privateFile("attachment"));
  app.get("/files-pri/:teamFile/:name", privateFile("inline"));

  // The web UI is the signed-in human's view, like Slack's own client, so no token.
  app.get("/files/:user/:file/:name", (c) => {
    const file = store.files.get(c.req.param("file"));
    if (!file?.path || file.deleted) return c.text("This file was deleted, or never existed.", 404);
    return serve(file, "inline");
  });

  return app;
}

/** `T01TEST-F123` → the file, if it exists, belongs to this workspace, and has bytes. */
function byTeamFileId(store: Store, teamFile: string | undefined): StoredFile | undefined {
  const m = /^([A-Z0-9]+)-(F[A-Z0-9]+)$/.exec(teamFile ?? "");
  if (!m || m[1] !== store.config.workspace.teamId) return undefined;
  const file = store.files.get(m[2]);
  return file?.path && !file.deleted ? file : undefined;
}

function serve(file: StoredFile, disposition: "inline" | "attachment"): Response {
  return new Response(Bun.file(file.path!), {
    headers: {
      "Content-Type": file.mimetype,
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    },
  });
}
