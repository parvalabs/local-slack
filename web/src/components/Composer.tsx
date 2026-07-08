import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Channel, User } from "../types.ts";
import { avatarColor, initials, userLabel } from "../util.ts";

type TriggerKind = "user" | "channel";

interface TriggerQuery {
  start: number; // index of the '@' or '#' in the text
  kind: TriggerKind;
  query: string;
}

/** A confirmed reference: the [start, end) range in `text` currently displaying
 *  "@Real Name" or "#channel-name", and what it should serialize to on send.
 *  Offsets are kept in sync as the surrounding text is edited (see
 *  `applyEdit`); editing inside the range itself drops it back to plain,
 *  uncoupled text. */
interface RefSpan {
  start: number;
  end: number;
  kind: TriggerKind;
  id: string;
  channelName?: string; // only for kind "channel" — <#id|name> needs the name too
}

type Candidate = { kind: "user"; id: string; display: string; label: string } | { kind: "channel"; id: string; display: string; label: string };

/** If the cursor sits right after an "@word" or "#word" (word started at a
 *  line start or after whitespace), returns where that reference starts,
 *  which kind it is, and what's typed so far. */
function findTriggerQuery(text: string, cursor: number): TriggerQuery | null {
  let i = cursor;
  while (i > 0 && /[a-zA-Z0-9_'.-]/.test(text[i - 1])) i--;
  const trigger = text[i - 1];
  if (i > 0 && (trigger === "@" || trigger === "#")) {
    const before = text[i - 2];
    if (i - 1 === 0 || /\s/.test(before ?? "")) {
      return { start: i - 1, kind: trigger === "@" ? "user" : "channel", query: text.slice(i, cursor) };
    }
  }
  return null;
}

/** Diffs two strings assuming a single contiguous edit (true for normal typing,
 *  pasting, and deleting at a cursor/selection) — the region of `oldText` that
 *  was replaced, and what replaced it. */
function diffEdit(oldText: string, newText: string) {
  let start = 0;
  const maxStart = Math.min(oldText.length, newText.length);
  while (start < maxStart && oldText[start] === newText[start]) start++;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { removedStart: start, removedEnd: oldEnd, insertedLength: newEnd - start };
}

/** Shifts spans after an edit; any span the edit touched is dropped (it reverts
 *  to plain text — editing into the middle of a reference un-links it). */
function applyEdit(spans: RefSpan[], oldText: string, newText: string): RefSpan[] {
  const { removedStart, removedEnd, insertedLength } = diffEdit(oldText, newText);
  const delta = insertedLength - (removedEnd - removedStart);
  const next: RefSpan[] = [];
  for (const s of spans) {
    if (s.end <= removedStart) next.push(s);
    else if (s.start >= removedEnd) next.push({ ...s, start: s.start + delta, end: s.end + delta });
    // else: the edit overlapped this span — drop it.
  }
  return next;
}

/** Builds the raw Slack-format text (<@USER_ID> / <#CHANNEL_ID|name> instead of
 *  the friendly display) to actually send, from the display text and spans. */
function serialize(text: string, spans: RefSpan[]): string {
  let out = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    const raw = s.kind === "user" ? `<@${s.id}>` : `<#${s.id}|${s.channelName}>`;
    out = out.slice(0, s.start) + raw + out.slice(s.end);
  }
  return out;
}

/**
 * Splits text into plain/reference chunks for the highlight overlay (see the
 * comment on `.composer-input-wrap` in styles.css for why this is a separate
 * div layered under a text-transparent textarea, not styling the textarea
 * itself — plain <textarea>s can't render styled substrings).
 */
function renderHighlighted(text: string, spans: RefSpan[]): React.ReactNode[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  sorted.forEach((s, i) => {
    if (s.start > cursor) parts.push(text.slice(cursor, s.start));
    parts.push(
      <span key={i} className="composer-mention">
        {text.slice(s.start, s.end)}
      </span>,
    );
    cursor = s.end;
  });
  if (cursor < text.length || parts.length === 0) parts.push(text.slice(cursor));
  return parts;
}

export function Composer({
  placeholder,
  onSend,
  users = [],
  channels = [],
}: {
  placeholder: string;
  onSend: (text: string) => void;
  users?: User[];
  channels?: Channel[];
}) {
  const [text, setText] = useState("");
  const [spans, setSpans] = useState<RefSpan[]>([]);
  const [trigger, setTrigger] = useState<TriggerQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  // Grows the textarea to fit its content (capped by the CSS max-height, past
  // which it scrolls normally) — the height reset to "auto" first is what lets
  // it shrink back down when text is deleted, not just grow.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const matches = useMemo((): Candidate[] => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    if (trigger.kind === "user") {
      return users
        .filter((u) => u.name.toLowerCase().includes(q) || (u.real_name ?? "").toLowerCase().includes(q))
        .slice(0, 8)
        .map((u) => ({ kind: "user" as const, id: u.id, display: `@${u.real_name || u.name}`, label: u.real_name || u.name }));
    }
    return channels
      .filter((c) => !c.is_im && c.name.toLowerCase().includes(q))
      .slice(0, 8)
      .map((c) => ({ kind: "channel" as const, id: c.id, display: `#${c.name}`, label: c.name }));
  }, [trigger, users, channels]);

  const send = () => {
    const trimmed = serialize(text, spans).trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
    setSpans([]);
    setTrigger(null);
  };

  const selectCandidate = (c: Candidate) => {
    if (!trigger) return;
    const before = text.slice(0, trigger.start);
    const after = text.slice(trigger.start + 1 + trigger.query.length);
    const insertion = `${c.display} `;
    const newText = before + insertion + after;

    setSpans((prev) => [
      ...applyEdit(prev, text, before + after), // shift/drop existing spans past the removed query
      {
        start: before.length,
        end: before.length + c.display.length,
        kind: c.kind,
        id: c.id,
        channelName: c.kind === "channel" ? c.label : undefined,
      },
    ]);
    setText(newText);
    setTrigger(null);
    requestAnimationFrame(() => {
      const pos = before.length + insertion.length;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(pos, pos);
    });
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setSpans((prev) => applyEdit(prev, text, value));
    setText(value);
    setTrigger(findTriggerQuery(value, e.target.selectionStart ?? value.length));
    setActiveIndex(0);
  };

  return (
    <div className="composer">
      {trigger && matches.length > 0 && (
        <div className="mention-list">
          {matches.map((c, i) => (
            <button
              key={`${c.kind}:${c.id}`}
              className={`mention-option ${i === activeIndex ? "active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault(); // keep textarea focus so selectCandidate's own focus() wins
                selectCandidate(c);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              {c.kind === "user" ? (
                <>
                  <span className="mention-option-avatar" style={{ background: avatarColor(c.id) }}>
                    {initials(userLabel(users, c.id))}
                  </span>
                  <span className="mention-option-name">{c.label}</span>
                  <span className="mention-option-handle">{c.display}</span>
                </>
              ) : (
                <>
                  <span className="mention-option-avatar mention-option-channel">#</span>
                  <span className="mention-option-name">{c.label}</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
      <div className="composer-input-wrap">
        <div className="composer-highlight" ref={highlightRef} aria-hidden="true">
          {renderHighlighted(text, spans)}
        </div>
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={text}
          placeholder={placeholder}
          rows={1}
          onChange={onChange}
          onScroll={(e) => {
            if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onKeyDown={(e) => {
            if (trigger && matches.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) => (i + 1) % matches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                selectCandidate(matches[activeIndex]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setTrigger(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          onBlur={() => setTrigger(null)}
        />
      </div>
      <button className="composer-send" onClick={send} disabled={!text.trim()}>
        Send
      </button>
    </div>
  );
}
