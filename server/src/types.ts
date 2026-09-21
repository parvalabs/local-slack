// Runtime shapes for objects the mock stores and hands to the bot / UI.
// Kept intentionally loose (Block Kit blocks/views are `any`) — this is a test mock, not a validator.

export interface SlackMessage {
  type: "message";
  ts: string;
  channel: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  username?: string;
  text?: string;
  blocks?: any[];
  attachments?: any[];
  thread_ts?: string;
  subtype?: string;
  edited?: { user: string; ts: string };
  reactions?: { name: string; users: string[]; count: number }[];
  /** Slack file objects (see formatFile), snapshotted when shared. A deleted
   *  file becomes `{ id, mode: "tombstone" }`. */
  files?: any[];
  /** True when the files arrived with this message, as opposed to being
   *  re-shared from elsewhere. */
  upload?: boolean;
  display_as_bot?: boolean;
}

export type LogDirection = "to_bot" | "from_bot" | "internal";

export interface LogEntry {
  id: string;
  time: number;
  direction: LogDirection;
  kind: string; // e.g. "web_api", "events_api", "slash_commands", "interactive", "ack"
  summary: string;
  detail?: unknown;
}
