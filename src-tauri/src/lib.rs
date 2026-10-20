mod db;
use base64::Engine;
use db::{Annotation, Database, Document, Pending, SearchResult, Share};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Mutex};
use tauri::{Emitter, Manager};
type Db = Mutex<Database>;
type Reply<T> = Result<T, String>;
#[derive(serde::Serialize)]
struct Opened {
    document: Document,
    data: String,
}
#[tauri::command]
async fn open_document(
    path: String,
    db: tauri::State<'_, Db>,
    app: tauri::AppHandle,
) -> Reply<Opened> {
    let (path, data, hash, format) = tauri::async_runtime::spawn_blocking(move || -> Reply<_> {
        let path = std::fs::canonicalize(&path).map_err(|e| format!("Cannot open file: {e}"))?;
        let ext = path
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_lowercase();
        let format = match ext.as_str() {
            "md" | "markdown" => "md",
            "pdf" => "pdf",
            "docx" => "docx",
            _ => return Err("Choose a PDF, Markdown, or DOCX document.".into()),
        };
        let data = std::fs::read(&path).map_err(|e| e.to_string())?;
        let hash = format!("{:x}", Sha256::digest(&data));
        Ok((path, data, hash, format.to_string()))
    })
    .await
    .map_err(|e| e.to_string())??;
    let title = path.file_name().unwrap_or_default().to_string_lossy();
    let document = db
        .lock()
        .map_err(|e| e.to_string())?
        .register(&path.to_string_lossy(), &hash, &format, &title)
        .map_err(|e| e.to_string())?;
    update_recents(&app);
    Ok(Opened {
        document,
        data: base64::engine::general_purpose::STANDARD.encode(data),
    })
}
#[tauri::command]
fn list_documents(db: tauri::State<Db>) -> Reply<Vec<Document>> {
    db.lock()
        .map_err(|e| e.to_string())?
        .documents()
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn list_annotations(document_id: String, db: tauri::State<Db>) -> Reply<Vec<Annotation>> {
    db.lock()
        .map_err(|e| e.to_string())?
        .annotations(&document_id)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn save_annotation(annotation: Annotation, db: tauri::State<Db>) -> Reply<Annotation> {
    db.lock()
        .map_err(|e| e.to_string())?
        .save(annotation)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn delete_annotation(id: String, db: tauri::State<Db>) -> Reply<()> {
    db.lock()
        .map_err(|e| e.to_string())?
        .delete(&id)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn search_annotations(query: String, db: tauri::State<Db>) -> Reply<Vec<SearchResult>> {
    db.lock()
        .map_err(|e| e.to_string())?
        .search(&query)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_shares(document_id: String, db: tauri::State<Db>) -> Reply<Vec<Share>> {
    db.lock()
        .map_err(|e| e.to_string())?
        .shares(&document_id)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn save_share(share: Share, db: tauri::State<Db>) -> Reply<()> {
    db.lock()
        .map_err(|e| e.to_string())?
        .save_share(share)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn import_annotation(annotation: Annotation, db: tauri::State<Db>) -> Reply<()> {
    db.lock()
        .map_err(|e| e.to_string())?
        .import_annotation(annotation)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn remote_delete(
    id: String,
    share_id: String,
    author_id: Option<String>,
    db: tauri::State<Db>,
) -> Reply<()> {
    db.lock()
        .map_err(|e| e.to_string())?
        .remote_delete(&id, &share_id, author_id)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn share_outbox(share_id: String, db: tauri::State<Db>) -> Reply<Vec<Pending>> {
    db.lock()
        .map_err(|e| e.to_string())?
        .outbox(&share_id)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn acknowledge_share(
    share_id: String,
    id: String,
    updated_at: String,
    db: tauri::State<Db>,
) -> Reply<()> {
    db.lock()
        .map_err(|e| e.to_string())?
        .acknowledge(&share_id, &id, &updated_at)
        .map_err(|e| e.to_string())
}
fn account_full_name() -> String {
    std::process::Command::new("/usr/bin/id")
        .arg("-F")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

#[tauri::command]
fn default_owner_name(db: tauri::State<Db>) -> Reply<String> {
    db.lock()
        .map_err(|e| e.to_string())?
        .owner_name()
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_owner_name(name: String, db: tauri::State<Db>) -> Reply<()> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("Enter a name of 1–80 characters".into());
    }
    db.lock()
        .map_err(|e| e.to_string())?
        .set_owner_name(name)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn data_version(db: tauri::State<Db>) -> Reply<i64> {
    db.lock()
        .map_err(|e| e.to_string())?
        .0
        .pragma_query_value(None, "data_version", |r| r.get(0))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn reanchor_annotation(id: String, start: i64, end: i64, db: tauri::State<Db>) -> Reply<()> {
    db.lock()
        .map_err(|e| e.to_string())?
        .reanchor(&id, start, end)
        .map_err(|e| e.to_string())
}

fn update_recents(app: &tauri::AppHandle) {
    use tauri::menu::{MenuItem, MenuItemKind};
    let Some(menu) = app.menu() else {
        return;
    };
    let Some(MenuItemKind::Submenu(file)) = menu.get("file") else {
        return;
    };
    let Some(MenuItemKind::Submenu(recent)) = file.get("recent") else {
        return;
    };
    if let Ok(items) = recent.items() {
        for item in items {
            let _ = recent.remove(&item);
        }
    }
    let state = app.state::<Db>();
    let Ok(db) = state.lock() else {
        return;
    };
    if let Ok(documents) = db.documents() {
        for doc in documents.into_iter().take(12) {
            if let Ok(item) = MenuItem::with_id(
                app,
                format!("recent:{}", doc.id),
                &doc.title,
                true,
                None::<&str>,
            ) {
                let _ = recent.append(&item);
            }
        }
    }
}
fn menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem as P, Submenu};
    let item =
        |id: &str, title: &str, key: &str| MenuItem::with_id(app, id, title, true, Some(key));
    let app_menu = Submenu::with_items(
        app,
        "annoplan",
        true,
        &[
            &P::about(app, None, None)?,
            &item("settings", "Settings…", "CmdOrCtrl+,")?,
            &P::separator(app)?,
            &P::services(app, None)?,
            &P::separator(app)?,
            &P::hide(app, None)?,
            &P::hide_others(app, None)?,
            &P::show_all(app, None)?,
            &P::separator(app)?,
            &P::quit(app, None)?,
        ],
    )?;
    let recent = Submenu::with_id(app, "recent", "Open Recent", true)?;
    let file = Submenu::with_id_and_items(
        app,
        "file",
        "File",
        true,
        &[
            &item("open", "Open…", "CmdOrCtrl+O")?,
            &recent,
            &item("library", "Library", "CmdOrCtrl+Shift+L")?,
            &P::separator(app)?,
            &item("close-tab", "Close Tab", "CmdOrCtrl+W")?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &P::undo(app, None)?,
            &P::redo(app, None)?,
            &P::separator(app)?,
            &P::cut(app, None)?,
            &P::copy(app, None)?,
            &P::paste(app, None)?,
            &P::select_all(app, None)?,
            &item("find", "Find…", "CmdOrCtrl+F")?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item("zoom-in", "Zoom In", "CmdOrCtrl+=")?,
            &item("zoom-out", "Zoom Out", "CmdOrCtrl+-")?,
            &item("actual-size", "Actual Size", "CmdOrCtrl+0")?,
            &P::separator(app)?,
            &item("highlight", "Highlight Mode", "CmdOrCtrl+Shift+H")?,
            &item("sidebar", "Show Sidebar", "CmdOrCtrl+Ctrl+S")?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &P::minimize(app, None)?,
            &P::maximize(app, None)?,
            &P::separator(app)?,
            &P::close_window(app, None)?,
        ],
    )?;
    app.set_menu(Menu::with_items(
        app,
        &[&app_menu, &file, &edit, &view, &window],
    )?)?;
    update_recents(app.handle());
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if let Some(doc_id) = id.strip_prefix("recent:") {
            if let Ok(db) = app.state::<Db>().lock() {
                if let Ok(docs) = db.documents() {
                    if let Some(doc) = docs.iter().find(|d| d.id == doc_id) {
                        let _ = app.emit("menu-action", format!("open-path:{}", doc.path));
                    }
                }
            }
        } else {
            let _ = app.emit("menu-action", id);
        }
    });
    Ok(())
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let home = std::env::var("HOME")?;
            let dir = PathBuf::from(home).join("Library/Application Support/annoplan");
            std::fs::create_dir_all(&dir)?;
            let database = Database::open(&dir.join("annoplan.db"))?;
            let name = account_full_name();
            database.0.execute(
                "INSERT OR IGNORE INTO settings VALUES('owner_name',?1)",
                [if name.is_empty() { "Owner" } else { &name }],
            )?;
            app.manage(Mutex::new(database));
            menu(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_document,
            list_documents,
            list_annotations,
            save_annotation,
            delete_annotation,
            search_annotations,
            list_shares,
            save_share,
            import_annotation,
            remote_delete,
            share_outbox,
            acknowledge_share,
            default_owner_name,
            set_owner_name,
            data_version,
            reanchor_annotation
        ])
        .run(tauri::generate_context!())
        .expect("Failed to run annoplan");
}
