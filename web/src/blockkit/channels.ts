import type { Channel } from "../types.ts";

// Shared lookup so mrkdwn can resolve <#C123> / <#C123|name> channel refs to a
// display name, and route clicks on them back to the app (set once by App.tsx).
export const channelNames = new Map<string, string>();
let onChannelClick: ((id: string) => void) | null = null;

export function setChannelNames(channels: Channel[]) {
  channelNames.clear();
  for (const c of channels) channelNames.set(c.id, c.name);
}

export function setChannelClickHandler(fn: (id: string) => void) {
  onChannelClick = fn;
}

export function clickChannel(id: string) {
  onChannelClick?.(id);
}
