import { useMemo, useState } from "react";
import type { AppInfo, Channel } from "../types.ts";
import { homeId } from "./Sidebar.tsx";

// Channels and DMs are tiny in-memory lists for a local dev workspace (a
// handful to a few dozen), so a plain substring filter is plenty - no need
// for an indexing library here (that tradeoff changes once message search
// arrives, where the dataset is bigger and relevance ranking matters).
type Result =
  | { kind: "channel"; id: string; name: string; isPrivate: boolean }
  | { kind: "app"; id: string; name: string };

export function SearchBar({
  channels,
  apps,
  onSelect,
}: {
  channels: Channel[];
  apps: AppInfo[];
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo((): Result[] => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const channelResults: Result[] = channels
      .filter((c) => !c.is_im && c.name.toLowerCase().includes(q))
      .slice(0, 6)
      .map((c) => ({ kind: "channel" as const, id: c.id, name: c.name, isPrivate: !!c.is_private }));
    const appResults: Result[] = apps
      .filter((a) => a.botName.toLowerCase().includes(q))
      .slice(0, 6)
      .map((a) => ({ kind: "app" as const, id: homeId(a.appId), name: a.botName }));
    return [...channelResults, ...appResults];
  }, [query, channels, apps]);

  const select = (r: Result) => {
    onSelect(r.id);
    setQuery("");
    setActiveIndex(0);
  };

  return (
    <div className="search-bar">
      <input
        className="search-input"
        placeholder="Search channels and apps"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={(e) => {
          if (!results.length) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((i) => (i + 1) % results.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((i) => (i - 1 + results.length) % results.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            select(results[activeIndex]);
          } else if (e.key === "Escape") {
            setQuery("");
          }
        }}
        onBlur={() => setQuery("")}
      />
      {results.length > 0 && (
        <div className="search-results">
          {results.map((r, i) => (
            <button
              key={`${r.kind}:${r.id}`}
              className={`search-result ${i === activeIndex ? "active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault(); // keep the input focused so onBlur doesn't fire before the click
                select(r);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <span className="search-result-icon">
                {r.kind === "channel" ? (r.isPrivate ? "🔒" : "#") : "🏠"}
              </span>
              {r.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
