/**
 * Slack message permalinks, and the local equivalents this app answers to.
 *
 * Slack's form is `/archives/<channel>/p<ts-without-its-dot>`, e.g. ts
 * "1699999999.000123" → "p1699999999000123". A reply carries the thread it
 * belongs to in the query string: `?thread_ts=<root-ts>&cid=<channel>`.
 */

export interface ArchiveTarget {
  channelId: string;
  ts?: string;
  threadTs?: string;
}

/** "1699999999.000123" → "p1699999999000123" */
export function tsToPermalinkId(ts: string): string {
  return `p${ts.replace(".", "")}`;
}

/** "p1699999999000123" → "1699999999.000123" (the dot always sits 6 from the end,
 *  since Slack timestamps are `<seconds>.<6-digit counter>`). */
export function permalinkIdToTs(id: string): string | null {
  const digits = /^p(\d{7,})$/.exec(id)?.[1];
  if (!digits) return null;
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

export function archivePath(channelId: string, ts?: string, threadTs?: string): string {
  const base = `/archives/${channelId}${ts ? `/${tsToPermalinkId(ts)}` : ""}`;
  return threadTs ? `${base}?thread_ts=${threadTs}&cid=${channelId}` : base;
}

/** Reads an /archives/… path (plus its query string) into something the app can
 *  navigate to. Returns null for anything that isn't one. */
export function parseArchivePath(pathname: string, search = ""): ArchiveTarget | null {
  const m = /^\/archives\/([A-Za-z0-9]+)(?:\/(p\d+))?\/?$/.exec(pathname);
  if (!m) return null;
  const params = new URLSearchParams(search);
  // `cid` repeats the channel; the path is authoritative, so it's only a fallback.
  const channelId = m[1] || params.get("cid") || "";
  if (!channelId) return null;
  return {
    channelId,
    ts: m[2] ? (permalinkIdToTs(m[2]) ?? undefined) : undefined,
    threadTs: params.get("thread_ts") ?? undefined,
  };
}

/** Same, for a full URL — used to decide whether a rendered link should navigate
 *  in-app instead of loading a page. Only same-origin links qualify. */
export function parseArchiveUrl(href: string): ArchiveTarget | null {
  try {
    const url = new URL(href, location.origin);
    if (url.origin !== location.origin) return null;
    return parseArchivePath(url.pathname, url.search);
  } catch {
    return null;
  }
}

/** Rewrites any Slack origin to this server's, so permalinks pasted from (or
 *  generated as if from) real Slack resolve here. Only the origin changes — the
 *  /archives/… path is already compatible.
 *
 *  The subdomain is optional: real permalinks carry the workspace
 *  (`my-org.slack.com`), but bots often build links against a bare `slack.com`,
 *  and those should localize too. */
export function localizeSlackUrls(text: string): string {
  return text.replace(/https?:\/\/(?:[a-z0-9-]+\.)*slack\.com/gi, location.origin);
}
