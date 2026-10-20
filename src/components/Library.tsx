import { useEffect, useState } from "react";
import { FileText, Search, ArrowUpRight, BookOpen } from "lucide-react";
import type { AnnotationBackend } from "../backend";
import type { Annotation, Document, SearchResult } from "../types";
export default function Library({
  backend: api,
  documents,
  onOpen,
}: {
  backend: AnnotationBackend;
  documents: Document[];
  onOpen: (path: string, annotation?: Annotation) => void;
}) {
  const [query, setQuery] = useState(""),
    [results, setResults] = useState<SearchResult[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    if (!query.trim()) {
      setResults([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      void api
        .search(query)
        .then((r) => {
          if (!cancelled) {
            setResults(r);
            setError("");
          }
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);
  return (
    <section className="library-view">
      <div className="library-heading">
        <div>
          <BookOpen size={24} />
          <h1>Library</h1>
          <p>Documents you’ve opened. Ideas you’ve kept.</p>
        </div>
        <span>{documents.length} documents</span>
      </div>
      <label className="library-search">
        <Search size={18} />
        <input
          autoFocus
          aria-label="Search all quotes and notes"
          placeholder="Search all highlights and notes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {busy && <span>Searching…</span>}
      </label>
      {error && <p role="alert">{error}</p>}
      {query.trim() ? (
        <div className="library-results">
          <h2>
            {results.length} matching passages
            {results.length === 200 ? " (first 200)" : ""}
          </h2>
          {results.map((r) => (
            <button
              key={r.annotation.id}
              className="library-result"
              onClick={() => onOpen(r.document.path, r.annotation)}
            >
              <i style={{ background: `var(--${r.annotation.color})` }} />
              <span>
                <small>{r.document.title}</small>
                <q>{r.annotation.quote}</q>
                {r.annotation.note && <p>{r.annotation.note}</p>}
              </span>
              <ArrowUpRight size={16} />
            </button>
          ))}
          {!results.length && !busy && (
            <p className="muted">
              No matching passages. Try a word from a quote or note.
            </p>
          )}
        </div>
      ) : (
        <div className="library-documents">
          <div className="library-labels">
            <span>Document</span>
            <span>Highlights</span>
            <span>Last opened</span>
          </div>
          {documents.map((d) => (
            <button
              key={d.id}
              className="library-document"
              onClick={() => onOpen(d.path)}
            >
              <span className="library-name">
                <FileText size={23} />
                <span>
                  <strong>{d.title}</strong>
                  <small title={d.path}>{d.path}</small>
                </span>
              </span>
              <span className="count">{d.annotation_count}</span>
              <time>
                {new Date(d.last_opened_at).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </time>
            </button>
          ))}
          {!documents.length && (
            <p className="muted library-empty">
              Open a document to start your library.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
