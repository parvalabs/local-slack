import type { AppInfo, Channel, LogEntry, Message, User, Workspace } from "./types.ts";
import { setUserNames } from "./blockkit/mentions.ts";
import { setChannelNames } from "./blockkit/channels.ts";
import { setCustomEmojis } from "./blockkit/emoji.ts";

export interface State {
  connected: boolean; // UI <-> server websocket
  workspace: Workspace | null;
  apps: AppInfo[];
  users: User[];
  channels: Channel[];
  emojis: Record<string, string>; // custom emoji name -> image URL
  messages: Record<string, Message[]>;
  lastReadTs: Record<string, string>; // channelId -> ts of the newest message seen, for unread bolding
  // Thread reads are tracked separately from channel reads (thread root ts -> newest
  // reply seen), matching Slack: opening a channel doesn't mark its threads read, so a
  // reply tucked inside a collapsed thread stays flagged until you actually open it.
  lastReadThreadTs: Record<string, string>;
  soundMuted: boolean;
  modalStack: any[];
  viewErrors: Record<string, string> | null;
  homeViews: Record<string, Record<string, any>>; // userId -> appId -> view
  log: LogEntry[];
}

const SOUND_MUTED_KEY = "local-slack:sound-muted";

function storedMuted(): boolean {
  try {
    return localStorage.getItem(SOUND_MUTED_KEY) === "1";
  } catch {
    return false; // private mode / storage disabled — default to audible
  }
}

const initial: State = {
  connected: false,
  workspace: null,
  apps: [],
  users: [],
  channels: [],
  emojis: {},
  messages: {},
  lastReadTs: {},
  lastReadThreadTs: {},
  soundMuted: storedMuted(),
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
  if (patch.channels) setChannelNames(patch.channels);
  if (patch.emojis) setCustomEmojis(patch.emojis);
  for (const l of listeners) l();
}

// Whose messages *not* to chime for — your own sends shouldn't make a noise.
// Set from App as the "Act as" selection changes.
let selfUserId = "";
export function setSelfUserId(id: string) {
  selfUserId = id;
}

export function toggleSound() {
  const soundMuted = !state.soundMuted;
  try {
    localStorage.setItem(SOUND_MUTED_KEY, soundMuted ? "1" : "0");
  } catch {
    /* storage disabled — the toggle still works for this session */
  }
  set({ soundMuted });
}

let audioCtx: AudioContext | null = null;

/** A short two-tone blip, synthesized rather than bundled as an audio file so the
 *  compiled single-file binary stays self-contained (the whole UI is one inlined
 *  index.html — see vite-plugin-singlefile). */
function playChime() {
  try {
    audioCtx ??= new AudioContext();
    // Browsers start the context suspended until a user gesture; once the human
    // has clicked anywhere this resumes and stays resumed.
    if (audioCtx.state === "suspended") void audioCtx.resume();

    const now = audioCtx.currentTime;
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.05, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
    gain.connect(audioCtx.destination);

    const osc = audioCtx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1175, now + 0.08);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.25);
  } catch {
    /* no AudioContext / autoplay blocked — sound is a nicety, never a hard failure */
  }
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
      const messages: Record<string, Message[]> = s.messages ?? {};
      // Everything that already existed before this session opened counts as
      // "seen" - only messages that arrive live should bold a channel or flag a
      // thread. Lists are chronological, so the last write per key wins.
      const lastReadTs: Record<string, string> = {};
      const lastReadThreadTs: Record<string, string> = {};
      for (const [channelId, list] of Object.entries(messages)) {
        const last = list.at(-1);
        if (last) lastReadTs[channelId] = last.ts;
        for (const m of list) if (m.thread_ts) lastReadThreadTs[m.thread_ts] = m.ts;
      }
      set({
        connected: true,
        workspace: s.workspace,
        apps: s.apps,
        users: s.users,
        channels: s.channels,
        emojis: s.emojis ?? {},
        messages,
        lastReadTs,
        lastReadThreadTs,
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
        if (!state.soundMuted && m.user !== selfUserId) playChime();
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
      set({
        apps: state.apps.map((a) => (a.appId === msg.appId ? { ...a, connected: msg.connected } : a)),
      });
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
      const byApp = { ...(state.homeViews[msg.user] ?? {}), [msg.appId]: msg.view };
      set({ homeViews: { ...state.homeViews, [msg.user]: byApp } });
      break;
    }
    case "log": {
      set({ log: [...state.log, msg.entry].slice(-500) });
      break;
    }
  }
}

/** Marks a channel as read up through its newest message - call whenever it
 *  becomes the open channel, or a new message arrives while it's already open. */
export function markChannelRead(channelId: string) {
  const last = state.messages[channelId]?.at(-1);
  if (!last || state.lastReadTs[channelId] === last.ts) return;
  set({ lastReadTs: { ...state.lastReadTs, [channelId]: last.ts } });
}

/** Marks a thread read up through its newest reply — call while its pane is open. */
export function markThreadRead(channelId: string, rootTs: string) {
  const newest = (state.messages[channelId] ?? []).filter((m) => m.thread_ts === rootTs).at(-1);
  if (!newest || state.lastReadThreadTs[rootTs] === newest.ts) return;
  set({ lastReadThreadTs: { ...state.lastReadThreadTs, [rootTs]: newest.ts } });
}

export function postMessage(channel: string, user: string, text: string, thread_ts?: string) {
  ws?.send(JSON.stringify({ t: "post_message", channel, user, text, thread_ts }));
}

export function sendBlockAction(
  channel: string,
  messageTs: string,
  user: string,
  action: any,
  appId?: string,
) {
  ws?.send(JSON.stringify({ t: "block_action", channel, messageTs, user, action, appId }));
}

export function sendViewSubmit(user: string, values: any) {
  ws?.send(JSON.stringify({ t: "view_submit", user, values }));
}

export function sendViewClose(user: string) {
  ws?.send(JSON.stringify({ t: "view_close", user }));
}

export function sendSlashCommand(
  appId: string,
  channel: string,
  user: string,
  command: string,
  text: string,
) {
  ws?.send(JSON.stringify({ t: "slash_command", appId, channel, user, command, text }));
}

export function openHome(appId: string, user: string) {
  ws?.send(JSON.stringify({ t: "open_home", appId, user }));
}

export function sendReaction(channel: string, ts: string, user: string, name: string, present: boolean) {
  ws?.send(JSON.stringify({ t: "reaction", channel, ts, user, name, present }));
}

export function editMessage(channel: string, ts: string, user: string, text: string) {
  ws?.send(JSON.stringify({ t: "edit_message", channel, ts, user, text }));
}

export function deleteMessage(channel: string, ts: string, user: string) {
  ws?.send(JSON.stringify({ t: "delete_message", channel, ts, user }));
}
