// @ts-expect-error - no published types; it's a plain { emoji: Record<string,string> } module
import emojiNameMap from "emoji-name-map";

/** Resolves a Slack emoji shortcode ("+1", "heart", ":tada:") to its unicode
 *  character, falling back to the shortcode itself for unrecognized/custom names. */
export function emojiChar(name: string): string {
  const key = name.replace(/^:|:$/g, "");
  return emojiNameMap.emoji[key] ?? `:${key}:`;
}

// Shared lookup so mrkdwn/reactions/the emoji picker can resolve config-declared
// custom emoji names to their image URL (see setCustomEmojis in client.ts).
export const customEmojis = new Map<string, string>();

export function setCustomEmojis(emojis: Record<string, string>) {
  customEmojis.clear();
  for (const [name, url] of Object.entries(emojis)) customEmojis.set(name, url);
}

/** HTML for a custom emoji's <img>, or null if `name` isn't a configured custom emoji —
 *  for mrkdwn's dangerouslySetInnerHTML string building, not JSX (see EmojiGlyph for that). */
export function customEmojiImgHtml(name: string): string | null {
  const key = name.replace(/^:|:$/g, "");
  const url = customEmojis.get(key);
  return url ? `<img class="emoji-img" src="${url}" alt=":${key}:" title=":${key}:" />` : null;
}
