import { useState } from "react";
import type { LogEntry } from "../types.ts";

// A bottom drawer showing raw traffic to/from the bot: Web API calls, socket
// envelopes, HTTP deliveries and acks — the point of a testing tool.
export function Inspector({ log, onClose }: { log: LogEntry[]; onClose: () => void }) {
  return (
    <div className="inspector">
      <div className="inspector-head">
        <span className="inspector-title">Inspector · bot traffic ({log.length})</span>
        <button className="inspector-x" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="inspector-body">
        {log.length === 0 && <div className="inspector-empty">No traffic yet.</div>}
        {log
          .slice()
          .reverse()
          .map((e) => (
            <LogRow key={e.id} entry={e} />
          ))}
      </div>
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false);
  const time = new Date(entry.time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const arrow = entry.direction === "to_bot" ? "→ bot" : entry.direction === "from_bot" ? "bot →" : "•";
  const hasDetail = entry.detail !== undefined && entry.detail !== null;

  return (
    <div className={`log-row ${entry.direction}`}>
      <button className="log-summary" onClick={() => hasDetail && setOpen((o) => !o)}>
        <span className="log-time">{time}</span>
        <span className={`log-dir ${entry.direction}`}>{arrow}</span>
        <span className="log-kind">{entry.kind}</span>
        <span className="log-text">{entry.summary}</span>
        {hasDetail && <span className="log-caret">{open ? "▾" : "▸"}</span>}
      </button>
      {open && hasDetail && <pre className="log-detail">{formatDetail(entry.detail)}</pre>}
    </div>
  );
}

function formatDetail(detail: unknown): string {
  if (typeof detail === "string") {
    try {
      return JSON.stringify(JSON.parse(detail), null, 2);
    } catch {
      return detail;
    }
  }
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}
