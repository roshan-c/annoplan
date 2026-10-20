import { useState } from "react";
import { Trash2, X, StickyNote } from "lucide-react";
import { colors, type Annotation, type Color } from "../types";
export interface Popover {
  x: number;
  y: number;
  annotation: Annotation;
  fresh: boolean;
  withNote?: boolean;
}
export function AnnotationPopover({
  value,
  readOnly = false,
  onSave,
  onDelete,
  onClose,
}: {
  value: Popover;
  readOnly?: boolean;
  onSave: (a: Annotation) => Promise<void>;
  onDelete: (a: Annotation) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value.annotation);
  const [note, setNote] = useState(value.withNote || !!draft.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(a: Annotation) {
    setBusy(true);
    try {
      await onSave(a);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const selectColor = (color: Color) => {
    const a = { ...draft, color };
    setDraft(a);
    if (!note) void save(a);
  };
  return (
    <div
      className="popover"
      role="dialog"
      aria-label="Annotation"
      style={{
        left: Math.max(12, Math.min(value.x - 140, window.innerWidth - 304)),
        top: Math.max(
          60,
          Math.min(value.y + 12, window.innerHeight - (note ? 265 : 125)),
        ),
      }}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <div className="popover-row">
        <span
          className="caption"
          title={value.annotation.agent_client || undefined}
        >
          {value.annotation.source === "mcp"
            ? value.annotation.author_name || "Agent"
            : readOnly
              ? value.annotation.author_name || "Contributor"
              : value.fresh
                ? "Highlight selection"
                : "Edit highlight"}
        </span>
        <button aria-label="Close annotation" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {!readOnly && (
        <div className="swatches">
          {colors.map((c) => (
            <button
              disabled={busy}
              key={c}
              aria-label={`${c} highlight`}
              aria-pressed={draft.color === c}
              className={`swatch ${draft.color === c ? "chosen" : ""}`}
              style={{ background: `var(--${c})` }}
              onClick={() => selectColor(c)}
            />
          ))}
          <span className="spacer" />
          {!value.fresh && (
            <button
              disabled={busy}
              aria-label="Delete highlight"
              onClick={async () => {
                setBusy(true);
                try {
                  await onDelete(draft);
                  onClose();
                } catch (e) {
                  setError(String(e));
                  setBusy(false);
                }
              }}
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      )}
      {readOnly ? (
        <p className="readonly-note">{draft.note || "No note"}</p>
      ) : note ? (
        <>
          <textarea
            autoFocus
            aria-label="Annotation note"
            placeholder="Add a note…"
            value={draft.note || ""}
            onChange={(e) =>
              setDraft({ ...draft, note: e.target.value || null })
            }
          />
          <button
            disabled={busy}
            className="primary save-note"
            onClick={() => void save(draft)}
          >
            Save Note
          </button>
        </>
      ) : (
        <button className="add-note" onClick={() => setNote(true)}>
          <StickyNote size={15} />
          Add Note
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
