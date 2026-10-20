import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquare } from "lucide-react";
import { reanchor } from "./anchoring";
import { plainText, rangeAt } from "./dom";
import type { Annotation, Rect } from "../types";
import type { Surface } from "../renderers/markdown/Markdown";
interface Props {
  surfaces: Surface[];
  annotations: Annotation[];
  showNotes: boolean;
  flash: string | null;
  onReanchor?: (id: string, start: number, end: number) => Promise<void>;
  onEdit: (a: Annotation, x: number, y: number) => void;
}
export function AnnotationLayer(props: Props) {
  return props.surfaces.map((s) => (
    <SurfaceLayer key={`${s.page}-${s.baseOffset}`} {...props} surface={s} />
  ));
}
function SurfaceLayer({
  surface,
  annotations,
  showNotes,
  flash,
  onEdit,
  onReanchor,
}: Props & { surface: Surface }) {
  const [items, setItems] = useState<{ a: Annotation; rects: Rect[] }[]>([]);
  useLayoutEffect(() => {
    const calculate = () => {
      const root = surface.element,
        box = root.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const text = plainText(root);
      setItems(
        annotations
          .filter((a) => a.page === surface.page)
          .map((a) => {
            const local = {
              ...a,
              start_offset: a.start_offset - surface.baseOffset,
              end_offset: a.end_offset - surface.baseOffset,
            };
            const anchor = reanchor(text, local);
            if (anchor?.method === "quote" && onReanchor && !a.author_id) {
              void onReanchor(
                a.id,
                anchor.start + surface.baseOffset,
                anchor.end + surface.baseOffset,
              ).catch(console.error);
            }
            const range = anchor && rangeAt(root, anchor.start, anchor.end);
            const rects = range
              ? Array.from(range.getClientRects())
                  .filter((r) => r.width > 0 && r.height > 0)
                  .map((r) => ({
                    x: (r.x - box.x) / box.width,
                    y: (r.y - box.y) / box.height,
                    width: r.width / box.width,
                    height: r.height / box.height,
                  }))
              : [];
            return { a, rects };
          }),
      );
    };
    calculate();
    const observer = new ResizeObserver(calculate);
    observer.observe(surface.element);
    document.fonts.ready.then(calculate);
    return () => observer.disconnect();
  }, [surface, annotations, onReanchor]);
  return createPortal(
    <div className="annotation-overlay" data-annotation-overlay="true">
      {items.map(({ a, rects }) => (
        <div key={a.id} data-highlight-id={a.id}>
          {rects.map((r, i) => (
            <button
              key={i}
              className={`highlight-rect ${a.id === flash ? "flash" : ""}`}
              aria-label={`Highlight: ${a.quote}`}
              style={{
                left: `${r.x * 100}%`,
                top: `${r.y * 100}%`,
                width: `${r.width * 100}%`,
                height: `${r.height * 100}%`,
                background: `var(--${a.color})`,
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onEdit(a, e.clientX, e.clientY);
              }}
            />
          ))}
          {showNotes && a.note && rects[0] && (
            <button
              className="note-indicator"
              style={{ top: `${rects[0].y * 100}%` }}
              title={a.note}
              aria-label={`Note: ${a.note}`}
              onClick={(e) => {
                e.stopPropagation();
                onEdit(a, e.clientX, e.clientY);
              }}
            >
              <MessageSquare size={14} />
            </button>
          )}
        </div>
      ))}
    </div>,
    surface.element,
  );
}
