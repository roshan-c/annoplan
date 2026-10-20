import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import {
  api,
  native,
  desktopEvents,
  shareStore,
  defaultOwnerName,
} from "./api";
import { DesktopSync } from "./share/desktopSync";
import ShareControl from "./share/ShareControl";
import { SHARE_BASE } from "./share/client";
const sync = new DesktopSync(api, shareStore);
function DesktopApp() {
  const [status, setStatus] = React.useState("");
  React.useEffect(() => {
    sync.onStatus = setStatus;
    const stop = () => sync.dispose();
    window.addEventListener("beforeunload", stop);
    return () => {
      sync.onStatus = undefined;
      window.removeEventListener("beforeunload", stop);
    };
  }, []);
  return (
    <>
      <App
        backend={sync.backend}
        native={native}
        events={desktopEvents}
        shareControl={
          SHARE_BASE
            ? (file) => (
                <ShareControl
                  key={file.document.id}
                  file={file}
                  sync={sync}
                  store={shareStore}
                  defaultName={defaultOwnerName}
                  saveName={api.setOwnerName}
                />
              )
            : undefined
        }
      />
      {status && (
        <div className="share-status" role="status">
          {status}
          <button onClick={() => setStatus("")}>Dismiss</button>
        </div>
      )}
    </>
  );
}
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DesktopApp />
  </React.StrictMode>,
);
