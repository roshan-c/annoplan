import type { TextContent } from "pdfjs-dist/types/src/display/api";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import type { RendererProps, Surface } from "../markdown/Markdown";
GlobalWorkerOptions.workerSrc = worker;
interface PageInfo {
  number: number;
  width: number;
  height: number;
  offset: number;
  text: TextContent;
}
interface Loaded {
  pdf: PDFDocumentProxy;
  pages: PageInfo[];
  text: string;
}
export default function Pdf({
  data,
  zoom,
  onReady,
  onLoad,
  onCurrent,
  onError,
}: RendererProps & {
  onLoad: (pdf: PDFDocumentProxy | null) => void;
  onCurrent: (page: number) => void;
  onError: (error: string) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null),
    [surfaces, setSurfaces] = useState<Map<number, Surface>>(new Map());
  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setSurfaces(new Map());
    const task = getDocument({
      data: data.slice(),
      cMapUrl: "/pdf/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdf/standard_fonts/",
      wasmUrl: "/pdf/wasm/",
    });
    void (async () => {
      try {
        const pdf = await task.promise;
        const pages: PageInfo[] = [];
        let all = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          if (cancelled) return;
          const page = await pdf.getPage(i),
            viewport = page.getViewport({ scale: 96 / 72 }),
            text = await page.getTextContent();
          pages.push({
            number: i,
            width: viewport.width,
            height: viewport.height,
            offset: all.length,
            text,
          });
          all += text.items
            .map((item) => ("str" in item ? item.str : ""))
            .join("");
        }
        if (!cancelled) {
          setLoaded({ pdf, pages, text: all });
          onLoad(pdf);
        }
      } catch (e) {
        if (!cancelled) onError(`Cannot render PDF: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
      onLoad(null);
      void task.destroy();
    };
  }, [data, onLoad, onError]);
  const register = useCallback(
    (page: number, surface: Surface | null) =>
      setSurfaces((old) => {
        const map = new Map(old);
        if (surface) map.set(page, surface);
        else map.delete(page);
        return map;
      }),
    [],
  );
  useEffect(() => {
    if (loaded)
      onReady({
        surfaces: [...surfaces.values()],
        text: loaded.text,
        headings: [],
        pageCount: loaded.pages.length,
      });
  }, [loaded, surfaces, onReady]);
  if (!loaded)
    return (
      <div className="renderer-loading" role="status">
        Preparing PDF text…
      </div>
    );
  return (
    <div className="pdf-stack">
      {loaded.pages.map((info) => (
        <Page
          key={info.number}
          pdf={loaded.pdf}
          info={info}
          zoom={zoom}
          register={register}
          onCurrent={onCurrent}
          onError={onError}
        />
      ))}
    </div>
  );
}
function Page({
  pdf,
  info,
  zoom,
  register,
  onCurrent,
  onError,
}: {
  pdf: PDFDocumentProxy;
  info: PageInfo;
  zoom: number;
  register: (page: number, surface: Surface | null) => void;
  onCurrent: (page: number) => void;
  onError: (e: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => setNear(entries[0].isIntersecting),
      { rootMargin: "1200px 0px" },
    );
    observer.observe(host.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (
          entry.isIntersecting &&
          entry.boundingClientRect.top < window.innerHeight * 0.65
        )
          onCurrent(info.number);
      },
      { threshold: [0, 0.2, 0.5, 0.8] },
    );
    observer.observe(host.current!);
    return () => observer.disconnect();
  }, [info.number, onCurrent]);
  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let render:
      | ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]>
      | undefined;
    let layer: TextLayer | undefined;
    void (async () => {
      try {
        const page = await pdf.getPage(info.number);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: (96 / 72) * zoom }),
          ratio = Math.min(window.devicePixelRatio || 1, 2),
          c = canvas.current!,
          t = text.current!;
        c.width = Math.floor(viewport.width * ratio);
        c.height = Math.floor(viewport.height * ratio);
        c.style.width = `${viewport.width}px`;
        c.style.height = `${viewport.height}px`;
        t.replaceChildren();
        t.style.setProperty("--scale-factor", String(viewport.scale));
        t.style.setProperty("--total-scale-factor", String(viewport.scale));
        render = page.render({
          canvas: c,
          viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
        });
        await render.promise;
        if (cancelled) return;
        layer = new TextLayer({
          textContentSource: info.text,
          container: t,
          viewport,
        });
        await layer.render();
        if (!cancelled)
          register(info.number, {
            element: t,
            page: info.number,
            baseOffset: info.offset,
          });
      } catch (e) {
        if (!cancelled) onError(`Page ${info.number}: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
      render?.cancel();
      layer?.cancel();
      register(info.number, null);
    };
  }, [near, pdf, info, zoom, register, onError]);
  return (
    <div
      ref={host}
      id={`pdf-page-${info.number}`}
      className="pdf-page paper"
      style={{
        width: info.width * zoom,
        height: info.height * zoom,
        minHeight: 0,
      }}
      aria-label={`Page ${info.number}`}
    >
      {near ? (
        <>
          <canvas ref={canvas} />
          <div key={zoom} className="textLayer" ref={text} />
        </>
      ) : (
        <span className="page-placeholder">{info.number}</span>
      )}
    </div>
  );
}
export function PdfThumbnails({
  pdf,
  current,
  onPage,
}: {
  pdf: PDFDocumentProxy;
  current: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="thumbnails">
      {Array.from({ length: pdf.numPages }, (_, i) => (
        <Thumbnail
          key={i}
          pdf={pdf}
          page={i + 1}
          current={current}
          onPage={onPage}
        />
      ))}
    </div>
  );
}
function Thumbnail({
  pdf,
  page,
  current,
  onPage,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  current: number;
  onPage: (page: number) => void;
}) {
  const button = useRef<HTMLButtonElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    [near, setNear] = useState(false);
  useEffect(() => {
    const io = new IntersectionObserver((e) => setNear(e[0].isIntersecting), {
      rootMargin: "200px",
    });
    io.observe(button.current!);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!near) {
      if (canvas.current) {
        canvas.current.width = 0;
        canvas.current.height = 0;
      }
      return;
    }
    let cancelled = false;
    let task:
      | ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]>
      | undefined;
    void pdf
      .getPage(page)
      .then((p) => {
        if (cancelled) return;
        const viewport = p.getViewport({
          scale: 130 / p.getViewport({ scale: 1 }).width,
        });
        const c = canvas.current!;
        c.width = viewport.width * 2;
        c.height = viewport.height * 2;
        c.style.width = `${viewport.width}px`;
        c.style.height = `${viewport.height}px`;
        task = p.render({ canvas: c, viewport, transform: [2, 0, 0, 2, 0, 0] });
        return task.promise;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, pdf, page]);
  return (
    <button
      ref={button}
      className={`thumbnail ${current === page ? "current" : ""}`}
      onClick={() => onPage(page)}
      aria-label={`Go to page ${page}`}
    >
      <canvas ref={canvas} />
      <span>{page}</span>
    </button>
  );
}
