import { useEffect, useMemo, useState } from "react";
import { Blocks, type InputBridge } from "../blockkit/BlockKit.tsx";
import { sendViewClose, sendViewSubmit } from "../client.ts";

// Renders the top of the modal stack. Collects input state.values and submits it.
export function Modal({
  stack,
  errors,
  actingUser,
}: {
  stack: any[];
  errors: Record<string, string> | null;
  actingUser: string;
}) {
  const view = stack.at(-1);
  const [values, setValues] = useState<Record<string, Record<string, any>>>({});

  // Reset collected values whenever the shown view changes.
  useEffect(() => {
    setValues({});
  }, [view?.id, stack.length]);

  const bridge: InputBridge = useMemo(
    () => ({
      get: (blockId, actionId) => values[blockId]?.[actionId],
      set: (blockId, actionId, value) =>
        setValues((v) => ({ ...v, [blockId]: { ...v[blockId], [actionId]: value } })),
    }),
    [values],
  );

  if (!view) return null;

  return (
    <div className="modal-overlay" onClick={() => sendViewClose(actingUser)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{view.title?.text ?? "Modal"}</span>
          <button className="modal-x" onClick={() => sendViewClose(actingUser)}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <Blocks blocks={view.blocks} ctx={{ input: bridge }} />
          {errors &&
            Object.entries(errors).map(([blockId, msg]) => (
              <div key={blockId} className="modal-error">
                {blockId}: {msg}
              </div>
            ))}
        </div>

        <div className="modal-foot">
          {view.close && (
            <button className="modal-btn" onClick={() => sendViewClose(actingUser)}>
              {view.close.text ?? "Cancel"}
            </button>
          )}
          {view.submit && (
            <button
              className="modal-btn primary"
              onClick={() => sendViewSubmit(actingUser, values)}
            >
              {view.submit.text ?? "Submit"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
