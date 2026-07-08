export interface User {
  id: string;
  name: string;
  real_name?: string;
  is_bot?: boolean;
  email?: string;
}

export interface Channel {
  id: string;
  name: string;
  is_channel?: boolean;
  is_private?: boolean;
  is_im?: boolean;
  members: string[];
}

export interface Reaction {
  name: string;
  users: string[];
  count: number;
}

export interface Message {
  ts: string;
  channel: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  blocks?: any[];
  thread_ts?: string;
  subtype?: string;
  ephemeral_to?: string;
  reactions?: Reaction[];
  edited?: { user: string; ts: string };
}

export interface AppInfo {
  appId: string;
  botUserId: string;
  botName: string;
  mode: "socket" | "events";
}

export interface Workspace {
  name: string;
  domain: string;
  teamId: string;
}

export interface LogEntry {
  id: string;
  time: number;
  direction: "to_bot" | "from_bot" | "internal";
  kind: string;
  summary: string;
  detail?: unknown;
}
