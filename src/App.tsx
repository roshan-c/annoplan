import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  PanelLeft,
  Highlighter,
  Minus,
  Plus,
  StickyNote,
  Search,
  FileText,
  FolderOpen,
  ChevronDown,
  Library,
  X,
} from "lucide-react";
import LibraryView from "./components/Library";
const Docx = lazy(() => import("./renderers/docx/Docx"));
const Pdf = lazy(() => import("./renderers/pdf/Pdf"));
const PdfThumbnails = lazy(() =>
  import("./renderers/pdf/Pdf").then((module) => ({
    default: module.PdfThumbnails,
  })),
);
import type { PDFDocumentProxy } from "pdfjs-dist";
import { decode, type AnnotationBackend, type DesktopEvents } from "./backend";
import {
  colors,
  type Annotation,
  type Color,
  type Document,
  type Opened,
} from "./types";
import Markdown, { type RendererReady } from "./renderers/markdown/Markdown";
import { AnnotationLayer } from "./annotation/AnnotationLayer";
import { createSelector, reanchor } from "./annotation/anchoring";
import { plainText, selectionOffsets } from "./annotation/dom";
import {
  AnnotationPopover,
  type Popover,
} from "./components/AnnotationPopover";

export default function App({
  backend: api,
  native = false,
  events,
  shared = false,
  initial,
  headerExtra,
  shareControl,
}: {
  backend: AnnotationBackend;
  native?: boolean;
  events?: DesktopEvents;
  shared?: boolean;
  initial?: Opened;
  headerExtra?: ReactNode;
  shareControl?: (opened: Opened) => ReactNode;
}) {
  const [tabs, setTabs] = useState<Opened[]>([]),
    [library, setLibrary] = useState(false);
  const pendingJump = useRef<Annotation | null>(null);
  const activeDocument = useRef<string | null>(null);
  const viewStates = useRef(
    new Map<string, { zoom: number; plain: boolean; scroll: number }>(),
  );
  const restoreScroll = useRef<number | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null),
    [currentPage, setCurrentPage] = useState(1);
  const [opened, setOpened] = useState<Opened | null>(null),
    [data, setData] = useState(new Uint8Array());
  const [annotations, setAnnotations] = useState<Annotation[]>([]),
    [recent, setRecent] = useState<Document[]>([]);
  const [sidebar, setSidebar] = useState(true),
    [panel, setPanel] = useState<"outline" | "annotations">(
      shared ? "annotations" : "outline",
    );
  const [zoom, setZoom] = useState(1),
    [plain, setPlain] = useState(false),
    [highlight, setHighlight] = useState(false),
    [color, setColor] = useState<Color>("yellow"),
    [notes, setNotes] = useState(true);
  const [ready, setReady] = useState<RendererReady>({
      surfaces: [],
      text: "",
      headings: [],
      pageCount: 0,
    }),
    [popover, setPopover] = useState<Popover | null>(null),
    [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ownerName, setOwnerName] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [authorFilter, setAuthorFilter] = useState("all");
  const canvas = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null),
    request = useRef(0);
  activeDocument.current = opened?.document.id || null;
  const rememberView = () => {
    if (opened && !library)
      viewStates.current.set(opened.document.id, {
        zoom,
        plain,
        scroll: canvas.current?.scrollTop || 0,
      });
  };
  const onReady = useCallback((r: RendererReady) => setReady(r), []);
  const refresh = useCallback(
    () =>
      api
        .documents()
        .then(setRecent)
        .catch((e) => setError(String(e))),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const openPath = useCallback(
    async (path: string, annotation?: Annotation) => {
      pendingJump.current = annotation || null;
      setLibrary(false);
      const ticket = ++request.current;
      setLoading(true);
      setError("");
      setPopover(null);
      try {
        const file = await api.open(path);
        const anns = await api.annotations(file.document.id);
        if (ticket !== request.current) return;
        setReady({ surfaces: [], text: "", headings: [], pageCount: 0 });
        rememberView();
        setOpened(file);
        setTabs((prev) =>
          prev.some((t) => t.document.id === file.document.id)
            ? prev.map((t) => (t.document.id === file.document.id ? file : t))
            : [...prev, file],
        );
        setData(decode(file.data));
        setAnnotations(anns);
        const view = viewStates.current.get(file.document.id);
        setPlain(view?.plain || false);
        setZoom(view?.zoom || 1);
        restoreScroll.current = annotation ? null : view?.scroll || 0;
        setCurrentPage(1);
        void refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        if (ticket === request.current) setLoading(false);
      }
    },
    [refresh, opened, zoom, plain, library],
  );
  useEffect(() => {
    if (initial) void openPath(initial.document.path);
  }, [initial]);
  useEffect(() => {
    if (!opened || !api.subscribe) return;
    return api.subscribe(opened.document.id, () => {
      const id = opened.document.id;
      void api
        .annotations(id)
        .then((rows) => {
          if (activeDocument.current === id) setAnnotations(rows);
        })
        .catch((e) => setError(String(e)));
    });
  }, [opened, api]);
  const choose = useCallback(async () => {
    if (!native) {
      setError(
        "Open documents in the annoplan desktop app. Run pnpm tauri dev.",
      );
      return;
    }
    try {
      const path = await api.choose();
      if (typeof path === "string") await openPath(path);
    } catch (e) {
      setError(String(e));
    }
  }, [openPath]);
  const activate = useCallback(
    async (file: Opened) => {
      const ticket = ++request.current;
      setLibrary(false);
      setPopover(null);
      setError("");
      try {
        const anns = await api.annotations(file.document.id);
        if (ticket !== request.current) return;
        setReady({ surfaces: [], text: "", headings: [], pageCount: 0 });
        rememberView();
        setOpened(file);
        setData(decode(file.data));
        setAnnotations(anns);
        const view = viewStates.current.get(file.document.id);
        setPlain(view?.plain || false);
        setZoom(view?.zoom || 1);
        restoreScroll.current = view?.scroll || 0;
        setCurrentPage(1);
      } catch (e) {
        setError(String(e));
      }
    },
    [opened, zoom, plain, library],
  );
  const closeTab = useCallback(
    (id?: string) => {
      if (library && !id) {
        setLibrary(false);
        return;
      }
      setPopover(null);
      const closing = id || opened?.document.id;
      const rest = tabs.filter((t) => t.document.id !== closing);
      setTabs(rest);
      if (closing === opened?.document.id) {
        if (rest.length) void activate(rest[rest.length - 1]);
        else {
          request.current++;
          setOpened(null);
          setData(new Uint8Array());
          setAnnotations([]);
          setReady({ surfaces: [], text: "", headings: [], pageCount: 0 });
        }
      }
    },
    [library, opened, tabs, activate],
  );
  const action = useCallback(
    (id: string) => {
      switch (id) {
        case "settings":
          setSettingsOpen(true);
          void api
            .ownerName?.()
            .then(setOwnerName)
            .catch((e) => setSettingsError(String(e)));
          break;
        case "open":
          void choose();
          break;
        case "library":
          rememberView();
          restoreScroll.current = library
            ? viewStates.current.get(opened?.document.id || "")?.scroll || 0
            : null;
          setLibrary((v) => !v);
          setPopover(null);
          void refresh();
          break;
        case "sidebar":
          setSidebar((v) => !v);
          break;
        case "highlight":
          setHighlight((v) => !v);
          break;
        case "zoom-in":
          setZoom((v) => Math.min(3, v + 0.1));
          break;
        case "zoom-out":
          setZoom((v) => Math.max(0.4, v - 0.1));
          break;
        case "actual-size":
          setZoom(1);
          break;
        case "find":
          if (library)
            document
              .querySelector<HTMLInputElement>(
                '[aria-label="Search all quotes and notes"]',
              )
              ?.focus();
          else search.current?.focus();
          break;
        case "close-tab":
          closeTab();
          break;
      }
    },
    [choose, closeTab, refresh, library, opened, zoom, plain],
  );
  useEffect(() => {
    return events?.attach(action, (path) => void openPath(path));
  }, [action, openPath, events]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPopover(null);
        setSettingsOpen(false);
        return;
      }
      if (native || !(e.metaKey || e.ctrlKey)) return;
      const id =
        e.key.toLowerCase() === "l" && e.shiftKey
          ? "library"
          : e.key === "o"
            ? "open"
            : e.key === "f"
              ? "find"
              : e.key === "="
                ? "zoom-in"
                : e.key === "-"
                  ? "zoom-out"
                  : e.key === "0"
                    ? "actual-size"
                    : e.key === "H" && e.shiftKey
                      ? "highlight"
                      : "";
      if (id) {
        e.preventDefault();
        action(id);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [action]);
  const save = useCallback(
    async (a: Annotation) => {
      if (api.canEdit && !api.canEdit(a) && a.created_at)
        throw new Error("You can only edit your own annotations");
      const saved = await api.save(a);
      if (activeDocument.current === saved.document_id)
        setAnnotations((prev) =>
          prev.some((x) => x.id === saved.id)
            ? prev.map((x) => (x.id === saved.id ? saved : x))
            : [...prev, saved].sort((a, b) => a.start_offset - b.start_offset),
        );
      void refresh();
    },
    [refresh],
  );
  const remove = async (a: Annotation) => {
    if (api.canEdit && !api.canEdit(a))
      throw new Error("You can only delete your own annotations");
    await api.delete(a.id);
    if (activeDocument.current === a.document_id)
      setAnnotations((prev) => prev.filter((x) => x.id !== a.id));
    void refresh();
  };
  useEffect(() => {
    if (!popover) return;
    const dismiss = (e: PointerEvent) => {
      if (
        !(e.target as HTMLElement).closest(".popover,[data-annotation-overlay]")
      )
        setPopover(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [popover]);
  const select = () => {
    const selection = window.getSelection();
    if (!opened || !selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const surface = ready.surfaces.find(
      (s) =>
        s.element.contains(range.startContainer) &&
        s.element.contains(range.endContainer),
    );
    if (!surface) return;
    const offsets = selectionOffsets(surface.element, range);
    if (!offsets) return;
    const text = plainText(surface.element),
      selector = createSelector(text, offsets.start, offsets.end),
      box = surface.element.getBoundingClientRect();
    const rects = Array.from(range.getClientRects())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({
        x: (r.x - box.x) / box.width,
        y: (r.y - box.y) / box.height,
        width: r.width / box.width,
        height: r.height / box.height,
      }));
    const a: Annotation = {
      ...selector,
      start_offset: selector.start_offset + surface.baseOffset,
      end_offset: selector.end_offset + surface.baseOffset,
      id: crypto.randomUUID(),
      document_id: opened.document.id,
      color,
      page: surface.page,
      rects_json: surface.page ? JSON.stringify(rects) : null,
      note: null,
      created_at: "",
      updated_at: "",
    };
    const bounds = range.getBoundingClientRect();
    if (highlight) {
      selection.removeAllRanges();
      void save(a).catch((e) => setError(String(e)));
    } else {
      setPopover({
        x: bounds.x + bounds.width / 2,
        y: bounds.bottom,
        annotation: a,
        fresh: true,
      });
    }
  };
  const jump = (a: Annotation) => {
    setLibrary(false);
    setSidebar(true);
    setPanel("annotations");
    pendingJump.current = a;
    if (a.page)
      document
        .getElementById(`pdf-page-${a.page}`)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
    const s = ready.surfaces.find((s) => s.page === a.page);
    const element = s?.element.querySelector(
      `[data-highlight-id="${a.id}"] button`,
    );
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlash(a.id);
    setTimeout(() => setFlash(null), 1600);
  };
  useEffect(() => {
    const a = pendingJump.current;
    if (!a || a.document_id !== opened?.document.id) return;
    if (a.page)
      document
        .getElementById(`pdf-page-${a.page}`)
        ?.scrollIntoView({ block: "start" });
    const timer = setTimeout(() => {
      const target = canvas.current?.querySelector(
        `[data-highlight-id="${a.id}"] button`,
      );
      if (target) {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        setFlash(a.id);
        pendingJump.current = null;
        setTimeout(() => setFlash(null), 1600);
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [ready, annotations, opened]);
  useEffect(() => {
    if (restoreScroll.current !== null && ready.pageCount > 0 && !library) {
      const top = restoreScroll.current;
      restoreScroll.current = null;
      requestAnimationFrame(() => canvas.current?.scrollTo(0, top));
    }
  }, [ready, library]);
  const visibleAnnotations = annotations.filter(
    (a) =>
      (authorFilter === "all" ||
        (a.source === "mcp" ? "agent" : a.author_id || "me") ===
          authorFilter) &&
      (!query ||
        `${a.quote} ${a.note || ""}`
          .toLowerCase()
          .includes(query.toLowerCase())),
  );
  const sidebarContent = () =>
    panel === "annotations" ? (
      <div className="annotation-list">
        <label className="author-filter">
          Author{" "}
          <select
            aria-label="Filter by author"
            value={authorFilter}
            onChange={(e) => setAuthorFilter(e.target.value)}
          >
            <option value="all">Everyone</option>
            {Array.from(
              new Map(
                annotations.map((a) => [
                  a.source === "mcp" ? "agent" : a.author_id || "me",
                  a.source === "mcp"
                    ? a.author_name || "Agent"
                    : a.author_id
                      ? a.author_name || "Contributor"
                      : "Me",
                ]),
              ),
            ).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {visibleAnnotations.map((a) => (
          <div key={a.id} className="annotation-row">
            <button className="annotation-jump" onClick={() => jump(a)}>
              <i style={{ background: `var(--${a.color})` }} />
              <span>
                <small
                  className="author-label"
                  title={a.agent_client || undefined}
                >
                  {a.source === "mcp"
                    ? a.author_name || "Agent"
                    : api.canEdit?.(a) !== false
                      ? "Me"
                      : a.author_name || "Contributor"}
                </small>
                <span className="quote">{a.quote}</span>
                {a.note && <span className="annotation-note">{a.note}</span>}
                {!reanchor(ready.text, a) && (
                  <small className="orphan">Unattached in this view</small>
                )}
              </span>
            </button>
            <button
              aria-label={
                api.canEdit?.(a) === false
                  ? "View annotation"
                  : "Edit annotation"
              }
              className="annotation-edit"
              onClick={(e) => {
                e.stopPropagation();
                setPopover({
                  x: 280,
                  y: e.clientY,
                  annotation: a,
                  fresh: false,
                  withNote: true,
                });
              }}
            >
              <StickyNote size={13} />
            </button>
          </div>
        ))}
        {!visibleAnnotations.length && (
          <p className="sidebar-empty muted">
            {query
              ? "No matching annotations."
              : "Select a passage to create your first highlight."}
          </p>
        )}
      </div>
    ) : opened?.document.format === "pdf" && pdf ? (
      <Suspense
        fallback={<p className="sidebar-empty muted">Loading thumbnails…</p>}
      >
        <PdfThumbnails
          pdf={pdf}
          current={currentPage}
          onPage={(page) =>
            document
              .getElementById(`pdf-page-${page}`)
              ?.scrollIntoView({ block: "start", behavior: "smooth" })
          }
        />
      </Suspense>
    ) : (
      <nav className="outline">
        {ready.headings.map((h) => (
          <button
            key={h.id}
            style={{ paddingLeft: 16 + (h.level - 1) * 12 }}
            onClick={() =>
              document
                .getElementById(h.id)
                ?.scrollIntoView({ block: "start", behavior: "smooth" })
            }
          >
            {h.text}
          </button>
        ))}
        {!ready.headings.length && (
          <p className="sidebar-empty muted">
            {opened
              ? "No headings in this view."
              : "Your document outline and annotations appear here."}
          </p>
        )}
      </nav>
    );
  const showSidebar = sidebar && !library;
  return (
    <main
      className={`app ${shared ? "share-view" : ""} ${showSidebar ? "with-sidebar" : ""}`}
    >
      {showSidebar && (
        <aside>
          {!shared && (
            <div className="sidebar-titlebar" data-tauri-drag-region>
              <button
                aria-label="Toggle sidebar"
                title="Toggle sidebar (⌃⌘S)"
                onClick={() => setSidebar(false)}
              >
                <PanelLeft size={19} />
              </button>
            </div>
          )}
          <div className="segments" role="tablist" aria-label="Sidebar">
            {!shared && (
              <button
                role="tab"
                aria-selected={panel === "outline"}
                className={panel === "outline" ? "selected" : ""}
                onClick={() => setPanel("outline")}
              >
                {opened?.document.format === "pdf" ? "Thumbnails" : "Outline"}
              </button>
            )}
            <button
              role="tab"
              aria-selected={panel === "annotations"}
              className={panel === "annotations" ? "selected" : ""}
              onClick={() => setPanel("annotations")}
            >
              Highlights
              {annotations.length > 0 && (
                <span className="segment-count">{annotations.length}</span>
              )}
            </button>
          </div>
          {sidebarContent()}
        </aside>
      )}
      <div className="main-column">
        <header className="toolbar" data-tauri-drag-region>
          {(!showSidebar || shared) && (
            <button
              aria-label="Toggle sidebar"
              title="Toggle sidebar (⌃⌘S)"
              onClick={() => setSidebar(!sidebar)}
            >
              <PanelLeft size={19} />
            </button>
          )}
          <div className="document-title" data-tauri-drag-region>
            {library ? "Library" : opened?.document.title || "annoplan"}
            <small>
              {shared
                ? headerExtra
                : library
                  ? `${recent.length} documents`
                  : loading
                    ? "Opening document…"
                    : opened
                      ? opened.document.format === "pdf"
                        ? `${currentPage} of ${ready.pageCount || "…"}`
                        : "Read only · Changes saved to annoplan"
                      : "Read. Highlight. Remember."}
            </small>
          </div>
          <div className="toolbar-actions">
            {opened && !library && shareControl?.(opened)}
            {!shared && opened?.document.format === "md" && !library && (
              <div className="control-group" role="group" aria-label="View">
                <button
                  aria-pressed={!plain}
                  className={!plain ? "active" : ""}
                  onClick={() => {
                    setPopover(null);
                    setPlain(false);
                  }}
                >
                  Rendered
                </button>
                <button
                  aria-pressed={plain}
                  className={plain ? "active" : ""}
                  onClick={() => {
                    setPopover(null);
                    setPlain(true);
                  }}
                >
                  Plain
                </button>
              </div>
            )}
            <div className="control-group" role="group" aria-label="Zoom">
              <button
                aria-label="Zoom out"
                title="Zoom out (⌘−)"
                disabled={!opened || library}
                onClick={() => action("zoom-out")}
              >
                <Minus size={15} />
              </button>
              <button
                className="zoom-value"
                title="Actual size (⌘0)"
                disabled={!opened || library}
                onClick={() => setZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                aria-label="Zoom in"
                title="Zoom in (⌘=)"
                disabled={!opened || library}
                onClick={() => action("zoom-in")}
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="control-group" role="group" aria-label="Markup">
              <button
                disabled={!opened || library}
                aria-label="Highlight mode"
                aria-pressed={highlight}
                className={highlight ? "active" : ""}
                title="Highlight mode (⇧⌘H)"
                onClick={() => setHighlight(!highlight)}
              >
                <Highlighter size={16} />
                <i
                  className="color-dot"
                  style={{ background: `var(--${color})` }}
                />
              </button>
              <label className="color-picker" title="Highlight colour">
                <select
                  disabled={!opened || library}
                  aria-label="Highlight colour"
                  value={color}
                  onChange={(e) => setColor(e.target.value as Color)}
                >
                  {colors.map((c) => (
                    <option key={c} value={c}>
                      {c[0].toUpperCase() + c.slice(1)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={11} />
              </label>
            </div>
            <button
              disabled={!opened || library}
              aria-label="Show notes"
              title="Show notes"
              aria-pressed={notes}
              className={notes ? "active" : ""}
              onClick={() => setNotes(!notes)}
            >
              <StickyNote size={16} />
            </button>
            {!shared && (
              <button
                className={library ? "active" : ""}
                title="Library (⇧⌘L)"
                aria-label="Library"
                aria-pressed={library}
                onClick={() => action("library")}
              >
                <Library size={16} />
              </button>
            )}
            {!shared && (
              <label className="search">
                <Search size={15} />
                <input
                  ref={search}
                  disabled={library}
                  aria-label="Search annotations"
                  placeholder="Search"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPanel("annotations");
                    setSidebar(true);
                  }}
                />
              </label>
            )}
          </div>
        </header>
        {error && (
          <div role="alert" className="error-banner">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {tabs.length > 1 && (
          <div className="tabbar" role="tablist" aria-label="Open documents">
            {tabs.map((t) => (
              <div
                key={t.document.id}
                className={`document-tab ${!library && opened?.document.id === t.document.id ? "selected" : ""}`}
              >
                <button
                  role="tab"
                  aria-selected={
                    !library && opened?.document.id === t.document.id
                  }
                  onClick={() => void activate(t)}
                >
                  <FileText size={12} />
                  <span>{t.document.title}</span>
                </button>
                <button
                  aria-label={`Close ${t.document.title}`}
                  className="tab-close"
                  onClick={() => closeTab(t.document.id)}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="workspace">
          <section
            ref={canvas}
            className={`canvas ${!opened && !library ? "empty" : ""} ${highlight ? "highlight-mode" : ""}`}
            onMouseUp={select}
            onKeyUp={(e) => {
              if (e.key === "Shift") select();
            }}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("a")) e.preventDefault();
            }}
          >
            {library ? (
              <LibraryView
                backend={api}
                documents={recent}
                onOpen={(path, annotation) => void openPath(path, annotation)}
              />
            ) : opened ? (
              <>
                <Suspense
                  fallback={
                    <div className="renderer-loading" role="status">
                      Loading document renderer…
                    </div>
                  }
                >
                  {opened.document.format === "pdf" ? (
                    <Pdf
                      key={opened.document.id}
                      data={data}
                      zoom={zoom}
                      onReady={onReady}
                      onLoad={setPdf}
                      onCurrent={setCurrentPage}
                      onError={setError}
                    />
                  ) : opened.document.format === "docx" ? (
                    <Docx
                      key={opened.document.id}
                      data={data}
                      zoom={zoom}
                      onReady={onReady}
                      onError={setError}
                    />
                  ) : (
                    <Markdown
                      key={`${opened.document.id}-${plain}`}
                      data={data}
                      zoom={zoom}
                      plain={plain}
                      onReady={onReady}
                    />
                  )}
                </Suspense>
                <AnnotationLayer
                  surfaces={ready.surfaces}
                  annotations={annotations}
                  showNotes={notes}
                  flash={flash}
                  // Rendered Markdown is canonical; Plain offsets would flip-flop on toggle.
                  onReanchor={
                    plain && opened.document.format === "md"
                      ? undefined
                      : api.reanchor
                  }
                  onEdit={(annotation, x, y) =>
                    setPopover({ annotation, x, y, fresh: false })
                  }
                />
              </>
            ) : (
              <>
                <FileText size={58} strokeWidth={1} />
                <h1>Open a document…</h1>
                <p>A place for the passages you want to keep.</p>
                <button className="primary" onClick={() => void choose()}>
                  <FolderOpen size={17} />
                  Open Document <kbd>⌘O</kbd>
                </button>
                <small>PDF · Markdown · Word</small>
                {recent.length > 0 && (
                  <div className="recent-list">
                    <h2>Open Recent</h2>
                    {recent.slice(0, 5).map((d) => (
                      <button key={d.id} onClick={() => void openPath(d.path)}>
                        <FileText size={15} />
                        <span>{d.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
      {settingsOpen && (
        <div
          className="settings-backdrop"
          onClick={() => setSettingsOpen(false)}
        >
          <form
            className="settings-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              setSettingsBusy(true);
              setSettingsError("");
              try {
                await api.setOwnerName?.(ownerName);
                if (opened)
                  setAnnotations(await api.annotations(opened.document.id));
                setSettingsOpen(false);
              } catch (error) {
                setSettingsError(String(error));
              } finally {
                setSettingsBusy(false);
              }
            }}
          >
            <h2>Settings</h2>
            <label>
              Your name
              <input
                autoFocus
                required
                maxLength={80}
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
              />
            </label>
            <p>Agent highlights appear as “{ownerName || "Owner"}'s agent”.</p>
            {settingsError && <p role="alert">{settingsError}</p>}
            <div>
              <button type="button" onClick={() => setSettingsOpen(false)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={settingsBusy || !ownerName.trim()}
              >
                Save
              </button>
            </div>
          </form>
        </div>
      )}
      {popover && (
        <AnnotationPopover
          key={popover.annotation.id}
          value={popover}
          readOnly={
            !popover.fresh && api.canEdit?.(popover.annotation) === false
          }
          onSave={save}
          onDelete={remove}
          onClose={() => {
            setPopover(null);
            window.getSelection()?.removeAllRanges();
          }}
        />
      )}
    </main>
  );
}
