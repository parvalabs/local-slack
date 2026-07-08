// Block Kit renderer. Supports two contexts:
//   - message: interactive elements (buttons/selects/overflow) fire `onAction`
//   - modal:   input elements are controlled and collect values via `input`
import { mrkdwn } from "./mrkdwn.tsx";

export interface InputBridge {
  get: (blockId: string, actionId: string) => any;
  set: (blockId: string, actionId: string, value: any) => void;
}

export interface BKContext {
  onAction?: (action: any) => void;
  input?: InputBridge;
}

export function Blocks({ blocks, ctx = {} }: { blocks?: any[]; ctx?: BKContext }) {
  if (!blocks?.length) return null;
  return (
    <div className="blocks">
      {blocks.map((b, i) => (
        <Block key={b.block_id ?? i} block={b} blockId={b.block_id ?? `b${i}`} ctx={ctx} />
      ))}
    </div>
  );
}

function Block({ block, blockId, ctx }: { block: any; blockId: string; ctx: BKContext }) {
  switch (block.type) {
    case "section":
      return (
        <div className="bk-section">
          {block.text && <div className="bk-text">{mrkdwn(block.text)}</div>}
          {block.fields && (
            <div className="bk-fields">
              {block.fields.map((f: any, i: number) => (
                <div key={i} className="bk-field">
                  {mrkdwn(f)}
                </div>
              ))}
            </div>
          )}
          {block.accessory && <El el={block.accessory} blockId={blockId} ctx={ctx} />}
        </div>
      );
    case "header":
      return <div className="bk-header">{block.text?.text}</div>;
    case "divider":
      return <hr className="bk-divider" />;
    case "context":
      return (
        <div className="bk-context">
          {block.elements?.map((el: any, i: number) =>
            el.type === "image" ? (
              <img key={i} className="bk-context-img" src={el.image_url} alt={el.alt_text ?? ""} />
            ) : (
              <span key={i} className="bk-context-text">
                {mrkdwn(el)}
              </span>
            ),
          )}
        </div>
      );
    case "image":
      return (
        <figure className="bk-image">
          <img src={block.image_url} alt={block.alt_text ?? ""} />
          {block.title && <figcaption>{block.title.text}</figcaption>}
        </figure>
      );
    case "actions":
      return (
        <div className="bk-actions">
          {block.elements?.map((el: any, i: number) => (
            <El key={el.action_id ?? i} el={el} blockId={blockId} ctx={ctx} />
          ))}
        </div>
      );
    case "input":
      return (
        <div className="bk-input">
          {block.label && <label className="bk-label">{block.label.text}</label>}
          <El el={block.element} blockId={blockId} ctx={ctx} input />
          {block.hint && <div className="bk-hint">{block.hint.text}</div>}
        </div>
      );
    default:
      return <div className="bk-unknown">[{block.type}]</div>;
  }
}

function El({
  el,
  blockId,
  ctx,
  input,
}: {
  el: any;
  blockId: string;
  ctx: BKContext;
  input?: boolean;
}) {
  if (!el) return null;
  const actionId = el.action_id ?? "action";
  const fire = (action: any) => ctx.onAction?.({ block_id: blockId, action_id: actionId, ...action });

  // ---- input context: controlled, collect into state.values ----
  if (input && ctx.input) {
    const bridge = ctx.input;
    switch (el.type) {
      case "plain_text_input": {
        const cur = bridge.get(blockId, actionId)?.value ?? el.initial_value ?? "";
        return (
          <input
            className="bk-plain-input"
            placeholder={el.placeholder?.text}
            value={cur}
            onChange={(e) =>
              bridge.set(blockId, actionId, { type: "plain_text_input", value: e.target.value })
            }
          />
        );
      }
      case "static_select": {
        const cur = bridge.get(blockId, actionId)?.selected_option?.value ?? "";
        return (
          <select
            className="bk-select"
            value={cur}
            onChange={(e) => {
              const opt = el.options?.find((o: any) => o.value === e.target.value);
              bridge.set(blockId, actionId, { type: "static_select", selected_option: opt });
            }}
          >
            <option value="">{el.placeholder?.text ?? "Select"}</option>
            {el.options?.map((o: any) => (
              <option key={o.value} value={o.value}>
                {o.text?.text}
              </option>
            ))}
          </select>
        );
      }
      case "checkboxes":
      case "radio_buttons": {
        const multi = el.type === "checkboxes";
        const cur: any[] = bridge.get(blockId, actionId)?.selected_options ?? [];
        const curOne = bridge.get(blockId, actionId)?.selected_option?.value;
        return (
          <div className="bk-options">
            {el.options?.map((o: any, i: number) => (
              <label key={i}>
                <input
                  type={multi ? "checkbox" : "radio"}
                  name={`${blockId}.${actionId}`}
                  checked={multi ? cur.some((c) => c.value === o.value) : curOne === o.value}
                  onChange={() => {
                    if (multi) {
                      const has = cur.some((c) => c.value === o.value);
                      const next = has ? cur.filter((c) => c.value !== o.value) : [...cur, o];
                      bridge.set(blockId, actionId, { type: "checkboxes", selected_options: next });
                    } else {
                      bridge.set(blockId, actionId, {
                        type: "radio_buttons",
                        selected_option: o,
                      });
                    }
                  }}
                />{" "}
                {o.text?.text}
              </label>
            ))}
          </div>
        );
      }
      case "datepicker": {
        const cur = bridge.get(blockId, actionId)?.selected_date ?? el.initial_date ?? "";
        return (
          <input
            className="bk-plain-input"
            type="date"
            value={cur}
            onChange={(e) =>
              bridge.set(blockId, actionId, { type: "datepicker", selected_date: e.target.value })
            }
          />
        );
      }
    }
  }

  // ---- message context: interactive, fire block_actions ----
  switch (el.type) {
    case "button":
      return (
        <button
          className={`bk-button ${el.style ? "bk-" + el.style : ""}`}
          onClick={() => fire({ type: "button", value: el.value, text: el.text })}
        >
          {el.text?.text}
        </button>
      );
    case "static_select":
    case "users_select":
    case "channels_select":
    case "conversations_select":
      return (
        <select
          className="bk-select"
          defaultValue=""
          onChange={(e) => {
            const opt = el.options?.find((o: any) => o.value === e.target.value) ?? {
              value: e.target.value,
            };
            fire({ type: el.type, selected_option: opt });
          }}
        >
          <option value="">{el.placeholder?.text ?? "Select"}</option>
          {el.options?.map((o: any) => (
            <option key={o.value} value={o.value}>
              {o.text?.text}
            </option>
          ))}
        </select>
      );
    case "overflow":
      return (
        <select
          className="bk-select bk-overflow"
          defaultValue=""
          onChange={(e) => {
            const opt = el.options?.find((o: any) => o.value === e.target.value);
            fire({ type: "overflow", selected_option: opt });
          }}
        >
          <option value="">⋯</option>
          {el.options?.map((o: any) => (
            <option key={o.value} value={o.value}>
              {o.text?.text}
            </option>
          ))}
        </select>
      );
    case "datepicker":
      return (
        <input
          className="bk-plain-input"
          type="date"
          onChange={(e) => fire({ type: "datepicker", selected_date: e.target.value })}
        />
      );
    case "image":
      return <img className="bk-accessory-img" src={el.image_url} alt={el.alt_text ?? ""} />;
    default:
      return <span className="bk-unknown">[{el.type}]</span>;
  }
}
