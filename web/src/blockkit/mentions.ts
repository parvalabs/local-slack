import type { User } from "../types.ts";

// Shared lookup so mrkdwn can resolve <@U123> mentions to display names.
export const userNames = new Map<string, string>();

export function setUserNames(users: User[]) {
  userNames.clear();
  for (const u of users) userNames.set(u.id, u.real_name || u.name);
}
