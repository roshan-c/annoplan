import { useLayoutEffect, useMemo, useRef } from "react";
import MarkdownIt from "markdown-it";
import type { Heading } from "../../types";
const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
export interface Surface {
  element: HTMLElement;
  page: number | null;
  baseOffset: number;
}
export interface RendererReady {
  surfaces: Surface[];
  text: string;
  headings: Heading[];
  pageCount: number;
}
export interface RendererProps {
  data: Uint8Array;
  zoom: number;
  onReady: (ready: RendererReady) => void;
}
export default function Markdown({
  data,
  plain,
  zoom,
  onReady,
}: RendererProps & { plain: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const source = useMemo(() => new TextDecoder().decode(data), [data]);
  const html = useMemo(() => md.render(source), [source]);
  useLayoutEffect(() => {
    const root = ref.current!;
    const headings = Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6")).map(
      (h, i) => {
        h.id = `heading-${i}`;
        return {
          id: h.id,
          text: h.textContent || "",
          level: Number(h.tagName[1]),
        };
      },
    );
    onReady({
      surfaces: [{ element: root, page: null, baseOffset: 0 }],
      text: root.textContent || "",
      headings,
      pageCount: 1,
    });
  }, [data, html, plain, zoom, onReady]);
  return (
    <div className="reading-width" style={{ width: 780 * zoom }}>
      <div
        ref={ref}
        className={`paper markdown ${plain ? "plain" : ""}`}
        style={{ fontSize: (plain ? 14 : 16) * zoom, padding: 56 * zoom }}
      >
        {plain ? (
          <pre>{source}</pre>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </div>
  );
}
