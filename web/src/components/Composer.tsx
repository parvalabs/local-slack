import { useMemo, useRef, useState } from "react";
import type { User } from "../types.ts";
import { avatarColor, initials, userLabel } from "../util.ts";

interface MentionQuery {
  start: number; // index of the '@' in the text
  query: string;
}

/** A confirmed mention: the [start, end) range in `text` currently displaying
 *  "@Real Name", and the user id it should serialize to on send. Offsets are
 *  kept in sync as the surrounding text is edited (see `applyEdit`); editing
 *  inside the range itself drops it back to plain, uncoupled text. */
interface MentionSpan {
  start: number;
  end: number;
  id: string;
}

/** If the cursor sits right after an "@word" (word started at a line start or
 *  after whitespace), returns where that mention starts and what's typed so far. */
function findMentionQuery(text: string, cursor: number): MentionQuery | null {
  let i = cursor;
  while (i > 0 && /[a-zA-Z0-9_'.-]/.test(text[i - 1])) i--;
  if (i > 0 && text[i - 1] === "@") {
    const before = text[i - 2];
    if (i - 1 === 0 || /\s/.test(before ?? "")) {
      return { start: i - 1, query: text.slice(i, cursor) };
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
 *  to plain text — editing into the middle of a mention un-mentions it). */
function applyEdit(spans: MentionSpan[], oldText: string, newText: string): MentionSpan[] {
  const { removedStart, removedEnd, insertedLength } = diffEdit(oldText, newText);
  const delta = insertedLength - (removedEnd - removedStart);
  const next: MentionSpan[] = [];
  for (const s of spans) {
    if (s.end <= removedStart) next.push(s);
    else if (s.start >= removedEnd) next.push({ ...s, start: s.start + delta, end: s.end + delta });
    // else: the edit overlapped this span — drop it.
  }
  return next;
}

/** Builds the raw Slack-format text (<@USER_ID> instead of the friendly name)
 *  to actually send, from the display text and its confirmed mention spans. */
function serialize(text: string, spans: MentionSpan[]): string {
  let out = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + `<@${s.id}>` + out.slice(s.end);
  }
  return out;
}

/**
 * Splits text into plain/mention chunks for the highlight overlay (see the
 * comment on `.composer-input-wrap` in styles.css for why this is a separate
 * div layered under a text-transparent textarea, not styling the textarea
 * itself — plain <textarea>s can't render styled substrings).
 */
function renderHighlighted(text: string, spans: MentionSpan[]): React.ReactNode[] {
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
}: {
  placeholder: string;
  onSend: (text: string) => void;
  users?: User[];
}) {
  const [text, setText] = useState("");
  const [spans, setSpans] = useState<MentionSpan[]>([]);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return users
      .filter((u) => u.name.toLowerCase().includes(q) || (u.real_name ?? "").toLowerCase().includes(q))
      .slice(0, 8);
  }, [mention, users]);

  const send = () => {
    const trimmed = serialize(text, spans).trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
    setSpans([]);
    setMention(null);
  };

  const selectMention = (user: User) => {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.start + 1 + mention.query.length);
    const display = `@${user.real_name || user.name}`;
    const insertion = `${display} `;
    const newText = before + insertion + after;

    setSpans((prev) => [
      ...applyEdit(prev, text, before + after), // shift/drop existing spans past the removed query
      { start: before.length, end: before.length + display.length, id: user.id },
    ]);
    setText(newText);
    setMention(null);
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
    setMention(findMentionQuery(value, e.target.selectionStart ?? value.length));
    setActiveIndex(0);
  };

  return (
    <div className="composer">
      {mention && matches.length > 0 && (
        <div className="mention-list">
          {matches.map((u, i) => (
            <button
              key={u.id}
              className={`mention-option ${i === activeIndex ? "active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault(); // keep textarea focus so selectMention's own focus() wins
                selectMention(u);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <span className="mention-option-avatar" style={{ background: avatarColor(u.id) }}>
                {initials(userLabel(users, u.id))}
              </span>
              <span className="mention-option-name">{u.real_name || u.name}</span>
              <span className="mention-option-handle">@{u.name}</span>
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
            if (mention && matches.length > 0) {
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
                selectMention(matches[activeIndex]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMention(null);
                return;
              }
            }
            // Backspace right after a mention deletes the whole thing in one keystroke,
            // matching Slack's own composer, instead of nibbling the display name apart.
            if (e.key === "Backspace" && !mention) {
              const el = textareaRef.current;
              const at = el?.selectionStart ?? -1;
              if (at >= 0 && at === el?.selectionEnd) {
                const span = spans.find((s) => s.end === at);
                if (span) {
                  e.preventDefault();
                  const newText = text.slice(0, span.start) + text.slice(span.end);
                  setText(newText);
                  setSpans((prev) =>
                    prev
                      .filter((s) => s !== span)
                      .map((s) =>
                        s.start > span.start
                          ? { start: s.start - (span.end - span.start), end: s.end - (span.end - span.start), id: s.id }
                          : s,
                      ),
                  );
                  requestAnimationFrame(() => textareaRef.current?.setSelectionRange(span.start, span.start));
                  return;
                }
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          onBlur={() => setMention(null)}
        />
      </div>
      <button className="composer-send" onClick={send} disabled={!text.trim()}>
        Send
      </button>
    </div>
  );
}
