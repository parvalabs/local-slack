// Very small Slack mrkdwn -> HTML renderer (bold/italic/strike/code, links, mentions).
import { userNames } from "./mentions.ts";
import { channelNames, clickChannel } from "./channels.ts";
import { emojiChar, customEmojiImgHtml } from "./emoji.ts";
import { clickArchive } from "./archive.ts";
import { localizeSlackUrls, parseArchiveUrl } from "../permalink.ts";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toHtml(input: string): string {
  // Point real-Slack permalinks at this server before anything is linkified, so
  // both the <url> forms and bare ones below pick up the rewritten origin.
  let h = localizeSlackUrls(esc(input));
  // <url|label> and <url>. Matched lazily up to the closing "&gt;" rather than
  // by excluding "&": esc() turned every "&" in the URL into "&amp;", so a query
  // string with more than one parameter (a thread permalink, say) would
  // otherwise never match and the raw <…|…> would render as literal text.
  h = h.replace(
    /&lt;(https?:[^\s|]*?)\|([^\n]*?)&gt;/g,
    '<a href="$1" target="_blank" rel="noreferrer">$2</a>',
  );
  h = h.replace(/&lt;(https?:[^\s|]*?)&gt;/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  // Bare URLs. Slack's client auto-links these, and a rewritten permalink is
  // useless if it isn't clickable. The leading (^|[\s(]) keeps it clear of the
  // anchors just built above, where URLs sit behind `href="` or `>`.
  h = h.replace(
    /(^|[\s(])(https?:\/\/[^\s<>"']+)/g,
    (_m, pre: string, url: string) => `${pre}<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`,
  );
  // <@U123> user mention (resolve to name)
  h = h.replace(
    /&lt;@([A-Z0-9]+)&gt;/g,
    (_m, id) => `<span class="mention">@${userNames.get(id) ?? id}</span>`,
  );
  // <#C123|name> and <#C123> channel mention — clickable, jumps to that channel (see clickChannel).
  h = h.replace(
    /&lt;#([A-Z0-9]+)\|([^&]+)&gt;/g,
    (_m, id, name) => `<span class="mention channel-mention" data-channel-id="${id}">#${name}</span>`,
  );
  h = h.replace(
    /&lt;#([A-Z0-9]+)&gt;/g,
    (_m, id) =>
      `<span class="mention channel-mention" data-channel-id="${id}">#${channelNames.get(id) ?? id}</span>`,
  );
  // :shortcode: emoji — custom (config-declared) first, else unicode, else left as literal
  // text by emojiChar's fallback
  h = h.replace(/:([a-zA-Z0-9_+-]+):/g, (_m, name) => customEmojiImgHtml(name) ?? emojiChar(name));
  // bold / italic / strike / code
  h = h.replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>");
  h = h.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");
  h = h.replace(/~([^~\n]+)~/g, "<del>$1</del>");
  h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  h = blockquotes(h);
  h = h.replace(/\n/g, "<br/>");
  return h;
}

/**
 * Slack's "> quoted line" and ">>> quote everything after this". Runs after the
 * inline passes, so links and mentions inside a quote still render, but before
 * newlines become <br/> while lines are still separable. The markers arrive as
 * "&gt;" because esc() has already run.
 */
function blockquotes(h: string): string {
  const quote = (body: string) => `<blockquote class="mrkdwn-quote">${body}</blockquote>`;

  const triple = /^&gt;&gt;&gt;[ \t]?/m.exec(h);
  if (triple) {
    const start = triple.index;
    return h.slice(0, start) + quote(h.slice(start + triple[0].length));
  }

  // Consecutive "&gt;" lines collapse into one quote, the way Slack renders them.
  const out: string[] = [];
  let run: string[] | null = null;
  const flush = () => {
    if (run) out.push(quote(run.join("\n")));
    run = null;
  };
  for (const line of h.split("\n")) {
    const quoted = /^&gt;[ \t]?(.*)$/.exec(line);
    if (quoted) (run ??= []).push(quoted[1]);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join("\n");
}

function onMrkdwnClick(e: React.MouseEvent<HTMLSpanElement>) {
  const channelRef = (e.target as HTMLElement).closest("[data-channel-id]");
  if (channelRef) {
    clickChannel(channelRef.getAttribute("data-channel-id")!);
    return;
  }
  // A permalink pointing back at this server jumps in place rather than
  // reloading the whole app in a new tab.
  const link = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
  if (!link) return;
  const target = parseArchiveUrl(link.href);
  if (target) {
    e.preventDefault();
    clickArchive(target);
  }
}

export function mrkdwn(textObj: any) {
  const raw = typeof textObj === "string" ? textObj : (textObj?.text ?? "");
  if (typeof textObj === "object" && textObj?.type === "plain_text") {
    return <span className="plain">{raw}</span>;
  }
  return (
    <span className="mrkdwn" onClick={onMrkdwnClick} dangerouslySetInnerHTML={{ __html: toHtml(raw) }} />
  );
}
