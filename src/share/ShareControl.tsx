import { useEffect, useState } from "react";
import { Share2 } from "lucide-react";
import type { Opened, Share } from "../types";
import type { DesktopSync, ShareStore } from "./desktopSync";
import { SHARE_BASE } from "./client";
import { expiresIn } from "./ShareApp";
export default function ShareControl({
  file,
  sync,
  store,
  defaultName,
  saveName,
}: {
  file: Opened;
  sync: DesktopSync;
  store: ShareStore;
  defaultName: () => Promise<string>;
  saveName?: (name: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [hours, setHours] = useState(4),
    [share, setShare] = useState<Share | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [copied, setCopied] = useState(false),
    [, tick] = useState(0);
  useEffect(() => {
    let active = true;
    void store.shares(file.document.id).then((rows) => {
      if (active)
        setShare(
          rows.find(
            (s) => !s.revoked_at && Date.parse(s.expires_at) > Date.now(),
          ) || null,
        );
    });
    return () => {
      active = false;
    };
  }, [file.document.id, open, store]);
  useEffect(() => {
    if (!name) void defaultName().then(setName);
    const timer = setInterval(() => tick((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  async function create() {
    setBusy(true);
    setError("");
    try {
      setShare(await sync.create(file, SHARE_BASE, name.trim(), hours * 3600));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const live =
    share && !share.revoked_at && Date.parse(share.expires_at) > Date.now();
  return (
    <div className="share-control">
      <button
        aria-label="Share document"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Share2 size={16} />
        Share{live && <span className="live-dot" />}
      </button>
      {open && (
        <section
          className="share-popover"
          role="dialog"
          aria-label="Share document"
        >
          <h2>{live ? "Live share link" : "Share this document"}</h2>
          {live ? (
            <>
              <p>
                Expires in {expiresIn(share.expires_at)}. Anyone with the link
                can read and annotate.
              </p>
              <input
                aria-label="Share link"
                readOnly
                value={share.url}
                onFocus={(e) => e.target.select()}
              />
              <button
                className="primary"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(share.url)
                    .then(() => setCopied(true))
                    .catch((e) => setError(String(e)));
                }}
              >
                {copied ? "Copied" : "Copy link"}
              </button>
              <p className="share-people">
                {sync
                  .people(file.document.id)
                  .map((p) => `${p.name}${p.online ? " · here" : ""}`)
                  .join(", ") || "Waiting for contributors"}
              </p>
              <button
                className="revoke"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await sync.revoke(share);
                    setShare(null);
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Revoke link
              </button>
            </>
          ) : (
            <>
              <p>
                Share an encrypted copy. Highlights and notes sync while this
                document is open.
              </p>
              <label>
                Your name
                <input
                  aria-label="Your name"
                  maxLength={80}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    localStorage.setItem("annoplan:owner-name", e.target.value);
                  }}
                />
              </label>
              <label>
                Link lifetime
                <select
                  aria-label="Link lifetime"
                  value={hours}
                  onChange={(e) => setHours(Number(e.target.value))}
                >
                  {[1, 4, 12, 24].map((h) => (
                    <option key={h} value={h}>
                      {h} {h === 1 ? "hour" : "hours"}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="primary"
                disabled={busy || !name.trim()}
                onClick={() => void create()}
              >
                {busy ? "Creating share…" : "Create link"}
              </button>
            </>
          )}
          {error && <p role="alert">{error}</p>}
          <button className="share-close" onClick={() => setOpen(false)}>
            Close
          </button>
        </section>
      )}
    </div>
  );
}
