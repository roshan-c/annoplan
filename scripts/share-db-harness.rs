//! Local integration adapter: runs the production database methods over JSON lines.
//! Never starts Tauri or touches the default database; an explicit path is required.
#[path = "../src-tauri/src/db/mod.rs"]
mod db;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{self, BufRead, Write};
fn dispatch(
    db: &db::Database,
    cmd: &str,
    args: &Value,
) -> Result<Value, Box<dyn std::error::Error>> {
    let text = |key: &str| args[key].as_str().unwrap_or("");
    Ok(match cmd {
        "open" => {
            let path = text("path");
            let bytes = std::fs::read(path)?;
            let format = std::path::Path::new(path)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("md");
            let title = std::path::Path::new(path)
                .file_name()
                .unwrap()
                .to_string_lossy();
            let doc = db.register(
                path,
                &format!("{:x}", Sha256::digest(&bytes)),
                format,
                &title,
            )?;
            json!({"document":doc,"data":base64::engine::general_purpose::STANDARD.encode(bytes)})
        }
        "ownerName" => json!(db.owner_name()?),
        "setOwnerName" => {
            db.set_owner_name(text("name"))?;
            Value::Null
        }
        "reanchor" => {
            db.reanchor(
                text("id"),
                args["start"].as_i64().unwrap(),
                args["end"].as_i64().unwrap(),
            )?;
            Value::Null
        }
        "documents" => json!(db.documents()?),
        "search" => json!(db.search(text("query"))?),
        "annotations" => json!(db.annotations(text("documentId"))?),
        "save" => json!(db.save(serde_json::from_value(args["annotation"].clone())?)?),
        "delete" => {
            db.delete(text("id"))?;
            Value::Null
        }
        "shares" => json!(db.shares(text("documentId"))?),
        "saveShare" => {
            db.save_share(serde_json::from_value(args["share"].clone())?)?;
            Value::Null
        }
        "importAnnotation" => {
            db.import_annotation(serde_json::from_value(args["annotation"].clone())?)?;
            Value::Null
        }
        "remoteDelete" => {
            db.remote_delete(
                text("id"),
                text("shareId"),
                args["authorId"].as_str().map(String::from),
            )?;
            Value::Null
        }
        "outbox" => json!(db.outbox(text("shareId"))?),
        "acknowledge" => {
            db.acknowledge(text("shareId"), text("id"), text("updatedAt"))?;
            Value::Null
        }
        _ => return Err("Unknown harness command".into()),
    })
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("Explicit database path required")?;
    let database = db::Database::open(std::path::Path::new(&path))?;
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line?)?;
        let id = &input["id"];
        let result = match dispatch(
            &database,
            input["command"].as_str().unwrap_or(""),
            &input["args"],
        ) {
            Ok(value) => json!({"id":id,"result":value}),
            Err(error) => json!({"id":id,"error":error.to_string()}),
        };
        println!("{result}");
        io::stdout().flush()?;
    }
    Ok(())
}
