import { useEffect, useState } from "react";
import App from "../App";
import { ShareClient, ShareError, loadShare, request } from "./client";
import { encryptJson } from "./crypto";
export function expiresIn(value: string, now = Date.now()) {
  const minutes = Math.max(0, Math.ceil((Date.parse(value) - now) / 60000));
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${minutes}m`;
}
export default function ShareApp() {
  const id = location.pathname.split("/")[2] || "",
    key = new URLSearchParams(location.hash.slice(1)).get("k") || "";
  const [loaded, setLoaded] = useState<Awaited<
      ReturnType<typeof loadShare>
    > | null>(null),
    [client, setClient] = useState<ShareClient | null>(null),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [status, setStatus] = useState("loading"),
    [busy, setBusy] = useState(false),
    [, tick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    loadShare(location.origin, id, key)
      .then((value) => {
        if (cancelled) return;
        setLoaded(value);
        setStatus("name");
        try {
          const cached = JSON.parse(
            localStorage.getItem(`annoplan:${id}`) || "null",
          );
          if (cached?.name) {
            setName(cached.name);
            if (cached.token && cached.id)
              activate(value, cached.name, cached.id, cached.token);
          }
        } catch {
          /* ask again */
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setStatus(
            e instanceof ShareError
              ? e.status === 410
                ? "expired"
                : e.status === 404
                  ? "missing"
                  : "error"
              : "key",
          );
          setError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, key]);
  function activate(
    value: NonNullable<typeof loaded>,
    displayName: string,
    actorId: string,
    token: string,
  ) {
    const backend = new ShareClient(
      location.origin,
      id,
      key,
      actorId,
      token,
      displayName,
      value.metadata,
      value.expiresAt,
      value.opened,
    );
    backend.onExpired = () => setStatus("expired");
    backend.onError = (e) => setError(String(e));
    setClient(backend);
    setStatus("ready");
  }
  useEffect(() => {
    if (!client) return;
    client.start();
    const off = client.subscribe(id, () => tick((v) => v + 1));
    const timer = setInterval(() => tick((v) => v + 1), 1000);
    return () => {
      clearInterval(timer);
      off();
      client.stop();
    };
  }, [client, id]);
  async function join(e: React.FormEvent) {
    e.preventDefault();
    if (!loaded || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const joined = await request<{
        participantId: string;
        participantToken: string;
      }>(location.origin, `/${id}/join`, "POST", {
        encrypted_name: await encryptJson(
          key,
          name.trim().slice(0, 80),
          "name",
        ),
      });
      localStorage.setItem(
        `annoplan:${id}`,
        JSON.stringify({
          name: name.trim().slice(0, 80),
          id: joined.participantId,
          token: joined.participantToken,
        }),
      );
      activate(
        loaded,
        name.trim(),
        joined.participantId,
        joined.participantToken,
      );
    } catch (e) {
      if (e instanceof ShareError && e.status === 410) setStatus("expired");
      else setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (status === "ready" && client && loaded)
    return (
      <>
        <App
          shared
          backend={client}
          initial={loaded.opened}
          headerExtra={
            <>
              <span>Expires in {expiresIn(loaded.expiresAt)}</span>
              <span
                className="contributors"
                title={[
                  loaded.metadata.owner_name,
                  ...client.people.map(
                    (p) => `${p.name}${p.online ? " (here)" : ""}`,
                  ),
                ].join(", ")}
              >
                {" "}
                ·{" "}
                {client.people
                  .filter((p) => p.online)
                  .map((p) => p.name)
                  .join(", ") || "Just you"}{" "}
                · {client.people.length} contributors
              </span>
            </>
          }
        />
        {error && (
          <div className="share-status" role="status">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
      </>
    );
  return (
    <main className="share-gate">
      <div className="share-gate-content">
        <span className="wordmark">annoplan</span>
        {status === "name" ? (
          <form onSubmit={join}>
            <h1>{loaded?.metadata.title}</h1>
            <p>
              Shared by {loaded?.metadata.owner_name}. Choose a name for your
              highlights and notes.
            </p>
            <label>
              Your name
              <input
                autoFocus
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
            </label>
            <button className="primary" disabled={busy || !name.trim()}>
              {busy ? "Joining…" : "Open document"}
            </button>
          </form>
        ) : (
          <>
            <h1>
              {status === "expired"
                ? "This link has expired"
                : status === "missing"
                  ? "Document not found"
                  : status === "key"
                    ? "Unable to decrypt this document"
                    : status === "error"
                      ? "Unable to open this document"
                      : "Opening shared document…"}
            </h1>
            <p>
              {status === "expired"
                ? "The document and shared annotations have been removed from the server."
                : status === "key"
                  ? "Open the complete share link, including its #k= key."
                  : status === "missing"
                    ? "Check the link with the person who shared it."
                    : ""}
            </p>
          </>
        )}
        {error && status !== "expired" && <p role="alert">{error}</p>}
      </div>
    </main>
  );
}
