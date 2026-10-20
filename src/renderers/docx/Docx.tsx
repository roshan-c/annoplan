import { useEffect, useRef } from "react";
import { renderAsync } from "docx-preview";
import { plainText } from "../../annotation/dom";
import type { RendererProps } from "../markdown/Markdown";
export default function Docx({
  data,
  zoom,
  onReady,
  onError,
}: RendererProps & { onError: (error: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    const host = ref.current!,
      staging = document.createElement("div");
    void renderAsync(data.slice().buffer, staging, undefined, {
      className: "docx",
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      breakPages: true,
      useBase64URL: true,
      renderComments: false,
      renderAltChunks: false,
    })
      .then(
        (document: {
          stylesPart?: {
            styles?: {
              cssName?: string;
              id?: string;
              name?: string;
              paragraphProps?: { outlineLevel?: number };
            }[];
          };
        }) => {
          if (cancelled) return;
          // Keep renderer-provided layout while excluding active content and remote assets.
          staging
            .querySelectorAll("script,iframe,object,embed")
            .forEach((n) => n.remove());
          staging.querySelectorAll("*").forEach((el) =>
            Array.from(el.attributes).forEach((a) => {
              if (
                a.name.startsWith("on") ||
                (a.name === "src" && !/^(data:|blob:)/i.test(a.value))
              )
                el.removeAttribute(a.name);
            }),
          );
          host.replaceChildren(...Array.from(staging.childNodes));
          const headingStyles = new Map<string, number>();
          for (const style of document.stylesPart?.styles || []) {
            const namedLevel = /^heading\s*([1-9])$/i.exec(
              style.id || style.name || "",
            );
            const level =
              style.paragraphProps?.outlineLevel ??
              (namedLevel ? Number(namedLevel[1]) - 1 : undefined);
            if (style.cssName && typeof level === "number" && level < 9)
              headingStyles.set(style.cssName, level + 1);
          }
          const candidates = Array.from(
            host.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,p"),
          );
          const headings = candidates.flatMap((h) => {
            const level = /^H[1-6]$/.test(h.tagName)
              ? Number(h.tagName[1])
              : Array.from(h.classList)
                  .map((c) => headingStyles.get(c))
                  .find((n) => n !== undefined);
            if (level === undefined) return [];
            const i = candidates.indexOf(h);
            h.id = `docx-heading-${i}`;
            h.setAttribute("role", "heading");
            h.setAttribute("aria-level", String(level));
            return [{ id: h.id, text: h.textContent || "", level }];
          });
          onReady({
            surfaces: [{ element: host, page: null, baseOffset: 0 }],
            text: plainText(host),
            headings,
            pageCount: host.querySelectorAll("section.docx").length || 1,
          });
        },
      )
      .catch((e) => {
        if (!cancelled) onError(`Cannot render DOCX: ${String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [data, onReady, onError]);
  return (
    <div className="docx-zoom" style={{ zoom }}>
      <div ref={ref} className="docx-host" />
    </div>
  );
}
