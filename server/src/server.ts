import { join, normalize } from "node:path";
import { Hono, type Context } from "hono";
import type { ServerWebSocket } from "bun";
import type { Config } from "./config/schema.ts";
import { Store } from "./state/store.ts";
import { SocketManager, type SocketData } from "./socket/manager.ts";
import { BotGateway } from "./gateway/bot.ts";
import { UiGateway } from "./gateway/ui.ts";
import { Interactions } from "./interactions.ts";
import { webApiRouter } from "./web-api/router.ts";
import { controlRouter } from "./control/router.ts";
import { hooksRouter } from "./hooks/router.ts";

// A package-relative copy of the built UI (staged here by `bun run build:web` /
// `scripts/copy-ui.ts`), NOT the monorepo's web/dist — this is what makes the
// server package self-contained when published/installed standalone (bunx/npx),
// not just when run from inside this repo.
const UI_DIST = join(import.meta.dir, "../public");

// Embed the built single-file UI into the `bun build --compile` binary. The static
// string import is analyzed by Bun's bundler; the try/catch keeps `bun run` working
// before the UI has been built. `default` is a path resolvable at runtime (real file
// on disk in dev, embedded virtual path in the compiled binary).
let embeddedIndex: string | null = null;
try {
  const mod: any = await import("../public/index.html", { with: { type: "file" } });
  embeddedIndex = mod.default ?? null;
} catch {
  embeddedIndex = null;
}

function staticHandler(distDir: string) {
  return async (c: Context) => {
    const pathname = new URL(c.req.url).pathname;
    const rel = pathname === "/" ? "/index.html" : pathname;

    // 1. Serve from the built dist dir when present (dev build / npx in the repo).
    const resolved = normalize(join(distDir, rel));
    if (resolved.startsWith(distDir)) {
      const file = Bun.file(resolved);
      if (await file.exists()) return new Response(file);
    }
    // 2. Embedded single-file index (compiled binary) — also the SPA fallback.
    if (embeddedIndex) return new Response(Bun.file(embeddedIndex));
    // 3. Filesystem SPA fallback.
    const idx = Bun.file(join(distDir, "index.html"));
    if (await idx.exists()) return new Response(idx);

    return c.text(
      "local-slack UI is not built yet.\nRun `bun run build:web` to build it, or use `bun run dev` for the Vite dev server.",
      200,
    );
  };
}

export async function startServer(opts: { config: Config; port: number }) {
  const store = new Store(opts.config);
  const socket = new SocketManager(store);
  const gateway = new BotGateway(store, socket);
  const interactions = new Interactions(store);
  const ui = new UiGateway(store, gateway, socket, interactions);

  const app = new Hono();
  app.route("/api", webApiRouter({ store, gateway, socket, interactions }));
  app.route("/_control", controlRouter(store, gateway, interactions));
  app.route("/_hooks", hooksRouter(store, interactions));
  app.get("/*", staticHandler(UI_DIST));

  const server = Bun.serve<SocketData>({
    port: opts.port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/socket/")) {
        const connId = url.pathname.slice("/socket/".length);
        if (srv.upgrade(req, { data: { kind: "socket", connId } })) return;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/ui") {
        if (srv.upgrade(req, { data: { kind: "ui" } })) return;
        return new Response("upgrade failed", { status: 400 });
      }
      return app.fetch(req, srv);
    },
    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        if (ws.data.kind === "socket") {
          if (!socket.add(ws, ws.data.connId)) ws.close();
        } else {
          ui.add(ws);
        }
      },
      message(ws: ServerWebSocket<SocketData>, message) {
        const raw = typeof message === "string" ? message : message.toString();
        if (ws.data.kind === "socket") socket.onMessage(ws, raw);
        else void ui.onMessage(ws, raw);
      },
      close(ws: ServerWebSocket<SocketData>) {
        if (ws.data.kind === "socket") socket.remove(ws);
        else ui.remove(ws);
      },
    },
  });

  store.runtime = {
    httpBase: `http://localhost:${server.port}`,
    wsBase: `ws://localhost:${server.port}`,
  };

  return { server, store };
}
