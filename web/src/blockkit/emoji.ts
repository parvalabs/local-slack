// @ts-expect-error - no published types; it's a plain { emoji: Record<string,string> } module
import emojiNameMap from "emoji-name-map";

/** Resolves a Slack emoji shortcode ("+1", "heart", ":tada:") to its unicode
 *  character, falling back to the shortcode itself for unrecognized/custom names. */
export function emojiChar(name: string): string {
  const key = name.replace(/^:|:$/g, "");
  return emojiNameMap.emoji[key] ?? `:${key}:`;
}
