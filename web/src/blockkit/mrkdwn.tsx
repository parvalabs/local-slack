// Very small Slack mrkdwn -> HTML renderer (bold/italic/strike/code, links, mentions).
import { userNames } from "./mentions.ts";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toHtml(input: string): string {
  let h = esc(input);
  // <url|label> and <url>
  h = h.replace(/&lt;(https?:[^|&]+)\|([^&]+)&gt;/g, '<a href="$1" target="_blank" rel="noreferrer">$2</a>');
  h = h.replace(/&lt;(https?:[^&]+)&gt;/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  // <@U123> user mention (resolve to name), <#C123|name> channel mention
  h = h.replace(
    /&lt;@([A-Z0-9]+)&gt;/g,
    (_m, id) => `<span class="mention">@${userNames.get(id) ?? id}</span>`,
  );
  h = h.replace(/&lt;#([A-Z0-9]+)\|([^&]+)&gt;/g, '<span class="mention">#$2</span>');
  // bold / italic / strike / code
  h = h.replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>");
  h = h.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");
  h = h.replace(/~([^~\n]+)~/g, "<del>$1</del>");
  h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  h = h.replace(/\n/g, "<br/>");
  return h;
}

export function mrkdwn(textObj: any) {
  const raw = typeof textObj === "string" ? textObj : (textObj?.text ?? "");
  if (typeof textObj === "object" && textObj?.type === "plain_text") {
    return <span className="plain">{raw}</span>;
  }
  return <span className="mrkdwn" dangerouslySetInnerHTML={{ __html: toHtml(raw) }} />;
}
