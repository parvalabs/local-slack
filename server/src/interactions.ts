import type { Store } from "./state/store.ts";
import type { UserConfig } from "./config/schema.ts";

interface TriggerCtx {
  user: string;
  channel?: string;
  messageTs?: string;
  createdAt: number;
}

interface ResponseCtx {
  channel: string;
  user: string;
  messageTs?: string; // container message (for replace_original / delete_original)
}

const TRIGGER_TTL_MS = 30 * 60 * 1000; // lenient (real Slack is 3s) — this is a test mock

let seq = 0;
function rand(): string {
  seq += 1;
  return `${Date.now().toString().slice(-9)}${seq}`;
}

/**
 * Build a Slack `state.values` object for a view submission. Like real Slack, every
 * input block appears (with a null/empty value when the user didn't fill it), so bots
 * that read `state.values[block][action]` don't crash on untouched fields.
 */
function buildStateValues(view: any, provided: Record<string, Record<string, any>>): any {
  const out: Record<string, Record<string, any>> = {};
  for (const block of view.blocks ?? []) {
    if (block.type !== "input" || !block.element) continue;
    const blockId = block.block_id;
    const el = block.element;
    const actionId = el.action_id;
    const got = provided[blockId]?.[actionId];
    out[blockId] = { [actionId]: got ?? emptyValue(el.type) };
  }
  return out;
}

function emptyValue(type: string): any {
  switch (type) {
    case "plain_text_input":
      return { type, value: null };
    case "checkboxes":
      return { type, selected_options: [] };
    case "datepicker":
      return { type, selected_date: null };
    case "timepicker":
      return { type, selected_time: null };
    default:
      return { type, selected_option: null };
  }
}

/**
 * Issues trigger_ids and response_urls, validates them, and builds the interaction
 * payloads (block_actions / view_submission / view_closed) the bot expects.
 */
export class Interactions {
  private triggers = new Map<string, TriggerCtx>();
  private responses = new Map<string, ResponseCtx>();

  constructor(private store: Store) {}

  // ---- trigger_id ---------------------------------------------------------
  newTriggerId(ctx: Omit<TriggerCtx, "createdAt">): string {
    const id = `${rand()}.${rand()}.${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    this.triggers.set(id, { ...ctx, createdAt: Date.now() });
    return id;
  }

  consumeTrigger(id?: string): TriggerCtx | undefined {
    if (!id) return undefined;
    const ctx = this.triggers.get(id);
    if (!ctx) return undefined;
    if (Date.now() - ctx.createdAt > TRIGGER_TTL_MS) {
      this.triggers.delete(id);
      return undefined;
    }
    return ctx; // not deleted: allow open-then-push within the window
  }

  // ---- response_url -------------------------------------------------------
  newResponseUrl(ctx: ResponseCtx): string {
    const id = crypto.randomUUID();
    this.responses.set(id, ctx);
    return `${this.store.runtime.httpBase}/_hooks/response/${id}`;
  }

  getResponseCtx(id: string): ResponseCtx | undefined {
    return this.responses.get(id);
  }

  // ---- view instantiation -------------------------------------------------
  instantiateView(view: any, extra: Record<string, unknown> = {}): any {
    const id = this.store.newId("V");
    return {
      ...view,
      id,
      team_id: this.store.config.workspace.teamId,
      app_id: this.store.config.app.appId,
      bot_id: "B" + this.store.botUserId.slice(1),
      root_view_id: id,
      previous_view_id: null,
      hash: `${Date.now()}.${rand()}`,
      state: view.state ?? { values: {} },
      ...extra,
    };
  }

  // ---- payload builders ---------------------------------------------------
  private userObj(userId: string) {
    const u: UserConfig | undefined = this.store.allUsers().find((x) => x.id === userId);
    return {
      id: userId,
      username: u?.name ?? userId,
      name: u?.name ?? userId,
      team_id: this.store.config.workspace.teamId,
    };
  }

  private base() {
    return {
      api_app_id: this.store.config.app.appId,
      token: "verification-token",
      team: {
        id: this.store.config.workspace.teamId,
        domain: this.store.config.workspace.domain,
      },
      is_enterprise_install: false,
    };
  }

  buildBlockActions(opts: {
    user: string;
    channel: string;
    message: any;
    action: any;
  }) {
    const { user, channel, message, action } = opts;
    const trigger_id = this.newTriggerId({ user, channel, messageTs: message?.ts });
    const response_url = this.newResponseUrl({ channel, user, messageTs: message?.ts });
    const chan = this.store.channels.get(channel);
    return {
      type: "block_actions",
      ...this.base(),
      user: this.userObj(user),
      container: {
        type: "message",
        message_ts: message?.ts,
        channel_id: channel,
        is_ephemeral: false,
      },
      trigger_id,
      channel: { id: channel, name: chan?.name ?? channel },
      message,
      state: { values: {} },
      response_url,
      actions: [
        {
          type: action.type ?? "button",
          action_id: action.action_id,
          block_id: action.block_id,
          value: action.value,
          text: action.text,
          selected_option: action.selected_option,
          selected_options: action.selected_options,
          selected_date: action.selected_date,
          action_ts: `${Date.now() / 1000}`,
        },
      ],
    };
  }

  buildViewSubmission(opts: { user: string; view: any; values: any }) {
    const values = buildStateValues(opts.view, opts.values ?? {});
    const view = { ...opts.view, state: { values } };
    return {
      type: "view_submission",
      ...this.base(),
      user: this.userObj(opts.user),
      trigger_id: this.newTriggerId({ user: opts.user }),
      view,
      response_urls: [],
    };
  }

  buildSlashCommand(opts: { user: string; channel: string; command: string; text: string }) {
    const u = this.store.allUsers().find((x) => x.id === opts.user);
    const chan = this.store.channels.get(opts.channel);
    return {
      token: "verification-token",
      team_id: this.store.config.workspace.teamId,
      team_domain: this.store.config.workspace.domain,
      channel_id: opts.channel,
      channel_name: chan?.name ?? opts.channel,
      user_id: opts.user,
      user_name: u?.name ?? opts.user,
      command: opts.command,
      text: opts.text ?? "",
      api_app_id: this.store.config.app.appId,
      is_enterprise_install: "false",
      response_url: this.newResponseUrl({ channel: opts.channel, user: opts.user }),
      trigger_id: this.newTriggerId({ user: opts.user, channel: opts.channel }),
    };
  }

  buildViewClosed(opts: { user: string; view: any }) {
    return {
      type: "view_closed",
      ...this.base(),
      user: this.userObj(opts.user),
      view: opts.view,
      is_cleared: false,
    };
  }
}
