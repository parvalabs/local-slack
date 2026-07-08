import type { Store } from "../state/store.ts";
import type { SocketManager } from "../socket/manager.ts";
import { signedHeaders } from "../signing.ts";

/**
 * Delivers events / slash commands / interactive payloads to the bot under test,
 * abstracting over Socket Mode (WebSocket envelopes) vs Events API (signed HTTP POST).
 * Returns the bot's response payload where one is expected (slash / interactive).
 */
export class BotGateway {
  constructor(
    private store: Store,
    private socket: SocketManager,
  ) {}

  private get app() {
    return this.store.config.app;
  }

  /** Wrap a raw event in the Events API `event_callback` envelope. */
  private wrapEvent(event: any) {
    const teamId = this.store.config.workspace.teamId;
    return {
      token: "verification-token",
      team_id: teamId,
      api_app_id: this.app.appId,
      event,
      type: "event_callback",
      event_id: this.store.newId("Ev"),
      event_time: Math.floor(Date.now() / 1000),
      authorizations: [
        {
          enterprise_id: null,
          team_id: teamId,
          user_id: this.app.botUserId,
          is_bot: true,
          is_enterprise_install: false,
        },
      ],
      is_ext_shared_channel: false,
    };
  }

  async deliverEvent(event: any): Promise<void> {
    const body = this.wrapEvent(event);
    if (this.app.mode === "socket") {
      await this.socket.send("events_api", body);
    } else {
      await this.httpPost(JSON.stringify(body), "application/json", "events_api");
    }
  }

  async deliverSlashCommand(cmd: Record<string, string>): Promise<unknown> {
    if (this.app.mode === "socket") {
      return this.socket.send("slash_commands", cmd);
    }
    const form = new URLSearchParams(cmd).toString();
    return this.httpPost(form, "application/x-www-form-urlencoded", "slash_commands");
  }

  async deliverInteractive(payload: any): Promise<unknown> {
    if (this.app.mode === "socket") {
      return this.socket.send("interactive", payload);
    }
    const form = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    return this.httpPost(form, "application/x-www-form-urlencoded", "interactive");
  }

  private async httpPost(body: string, contentType: string, kind: string): Promise<unknown> {
    const url = this.app.requestUrl;
    if (!url) {
      this.store.addLog("internal", kind, "events mode but no requestUrl configured");
      return undefined;
    }
    const headers = signedHeaders(this.app.signingSecret, body, contentType);
    this.store.addLog("to_bot", kind, `POST ${url}`, body);
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
