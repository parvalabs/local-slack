import type { AppInfo, Channel, LogEntry, Message, User, Workspace } from "./types.ts";
import { setUserNames } from "./blockkit/mentions.ts";

export interface State {
  connected: boolean; // UI <-> server websocket
  socketConnected: boolean; // bot's Socket Mode connection
  workspace: Workspace | null;
  app: AppInfo | null;
  users: User[];
  channels: Channel[];
  messages: Record<string, Message[]>;
  modalStack: any[];
  viewErrors: Record<string, string> | null;
  homeViews: Record<string, any>;
  log: LogEntry[];
}

const initial: State = {
  connected: false,
  socketConnected: false,
  workspace: null,
  app: null,
  users: [],
  channels: [],
  messages: {},
  modalStack: [],
  viewErrors: null,
  homeViews: {},
  log: [],
};

let state: State = initial;
const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  if (patch.users) setUserNames(patch.users);
  for (const l of listeners) l();
}

let ws: WebSocket | null = null;

export function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ui`);

  ws.onopen = () => set({ connected: true });
  ws.onclose = () => {
    set({ connected: false });
    setTimeout(connect, 1000);
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

function handle(msg: any) {
  switch (msg.t) {
    case "init": {
      const s = msg.state;
      set({
        connected: true,
        socketConnected: s.socketConnected,
        workspace: s.workspace,
        app: s.app,
        users: s.users,
        channels: s.channels,
        messages: s.messages ?? {},
        modalStack: s.modalStack ?? [],
        homeViews: s.homeViews ?? {},
        log: s.log ?? [],
      });
      break;
    }
    case "message": {
      const m: Message = msg.message;
      const list = state.messages[m.channel] ?? [];
      if (!list.some((x) => x.ts === m.ts)) {
        set({ messages: { ...state.messages, [m.channel]: [...list, m] } });
      }
      break;
    }
    case "message_update": {
      const m: Message = msg.message;
      const list = (state.messages[m.channel] ?? []).map((x) => (x.ts === m.ts ? m : x));
      set({ messages: { ...state.messages, [m.channel]: list } });
      break;
    }
    case "message_delete": {
      const list = (state.messages[msg.channel] ?? []).filter((x) => x.ts !== msg.ts);
      set({ messages: { ...state.messages, [msg.channel]: list } });
      break;
    }
    case "channel": {
      if (!state.channels.some((c) => c.id === msg.channel.id)) {
        set({ channels: [...state.channels, msg.channel] });
      }
      break;
    }
    case "socket_status": {
      set({ socketConnected: msg.connected });
      break;
    }
    case "view": {
      // A new/updated modal stack replaces the old one; clear any stale errors.
      set({ modalStack: msg.stack ?? [], viewErrors: null });
      break;
    }
    case "view_errors": {
      set({ viewErrors: msg.errors ?? {} });
      break;
    }
    case "home": {
      set({ homeViews: { ...state.homeViews, [msg.user]: msg.view } });
      break;
    }
    case "log": {
      set({ log: [...state.log, msg.entry].slice(-500) });
      break;
    }
  }
}

export function postMessage(channel: string, user: string, text: string, thread_ts?: string) {
  ws?.send(JSON.stringify({ t: "post_message", channel, user, text, thread_ts }));
}

export function sendBlockAction(channel: string, messageTs: string, user: string, action: any) {
  ws?.send(JSON.stringify({ t: "block_action", channel, messageTs, user, action }));
}

export function sendViewSubmit(user: string, values: any) {
  ws?.send(JSON.stringify({ t: "view_submit", user, values }));
}

export function sendViewClose(user: string) {
  ws?.send(JSON.stringify({ t: "view_close", user }));
}

export function sendSlashCommand(channel: string, user: string, command: string, text: string) {
  ws?.send(JSON.stringify({ t: "slash_command", channel, user, command, text }));
}

export function openHome(user: string) {
  ws?.send(JSON.stringify({ t: "open_home", user }));
}
