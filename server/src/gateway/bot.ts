import type { Store } from "../state/store.ts";
import type { AppConfig } from "../config/schema.ts";
import type { SocketManager } from "../socket/manager.ts";
import { signedHeaders } from "../signing.ts";

/**
 * Delivers events / slash commands / interactive payloads to the app(s) under test,
 * abstracting over Socket Mode (WebSocket envelopes) vs Events API (signed HTTP POST).
 * One instance serves every configured app — each call takes the target appId and
 * resolves that app's own mode/requestUrl/signingSecret. Returns the bot's response
 * payload where one is expected (slash / interactive).
 */
export class BotGateway {
  constructor(
    private store: Store,
    private socket: SocketManager,
  ) {}

  private appConfig(appId: string): AppConfig {
    const app = this.store.appById(appId);
    if (!app) throw new Error(`Unknown app: ${appId}`);
    return app;
  }

  /** Wrap a raw event in the Events API `event_callback` envelope. */
  private wrapEvent(app: AppConfig, event: any) {
    const teamId = this.store.config.workspace.teamId;
    return {
      token: "verification-token",
      team_id: teamId,
      api_app_id: app.appId,
      event,
      type: "event_callback",
      event_id: this.store.newId("Ev"),
      event_time: Math.floor(Date.now() / 1000),
      authorizations: [
        {
          enterprise_id: null,
          team_id: teamId,
          user_id: app.botUserId,
          is_bot: true,
          is_enterprise_install: false,
        },
      ],
      is_ext_shared_channel: false,
    };
  }

  async deliverEvent(appId: string, event: any): Promise<void> {
    const app = this.appConfig(appId);
    const body = this.wrapEvent(app, event);
    if (app.mode === "socket") {
      await this.socket.send(appId, "events_api", body);
    } else {
      await this.httpPost(app, JSON.stringify(body), "application/json", "events_api");
    }
  }

  async deliverSlashCommand(appId: string, cmd: Record<string, string>): Promise<unknown> {
    const app = this.appConfig(appId);
    if (app.mode === "socket") {
      return this.socket.send(appId, "slash_commands", cmd);
    }
    const form = new URLSearchParams(cmd).toString();
    return this.httpPost(app, form, "application/x-www-form-urlencoded", "slash_commands");
  }

  async deliverInteractive(appId: string, payload: any): Promise<unknown> {
    const app = this.appConfig(appId);
    if (app.mode === "socket") {
      return this.socket.send(appId, "interactive", payload);
    }
    const form = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    return this.httpPost(app, form, "application/x-www-form-urlencoded", "interactive");
  }

  private async httpPost(
    app: AppConfig,
    body: string,
    contentType: string,
    kind: string,
  ): Promise<unknown> {
    const url = app.requestUrl;
    if (!url) {
      this.store.addLog("internal", kind, `events mode but no requestUrl configured for ${app.appId}`);
      return undefined;
    }
    const headers = signedHeaders(app.signingSecret, body, contentType);
    this.store.addLog("to_bot", kind, `POST ${url} [${app.appId}]`, body);
    try {
      const res = await fetch(url, { method: "POST", headers, body });
      const text = await res.text();
      this.store.addLog("from_bot", kind, `HTTP ${res.status}`, text);
      try {
        return text ? JSON.parse(text) : undefined;
      } catch {
        return text;
      }
    } catch (err) {
      this.store.addLog("internal", kind, `POST failed: ${(err as Error).message}`);
      return undefined;
    }
  }
}
