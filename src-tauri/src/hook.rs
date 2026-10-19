//! Hook ingress (docs/05 §1): POST /hook/<connectorId> on 127.0.0.1:<random>.
//! Forwarded verbatim to the kernel stage; the host never parses agent formats.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::Host;

static PORT: AtomicU16 = AtomicU16::new(0);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HookRequest {
    connector_id: String,
    query: String,
    headers: HashMap<String, String>,
    body: String,
    received_at: u64,
}

#[tauri::command]
pub fn hook_port() -> u16 {
    PORT.load(Ordering::Relaxed)
}

/// The command an agent should run for a hook: this exe in forwarding mode (forward.rs).
#[derive(Serialize)]
pub struct HookCommand {
    command: String,
    args: Vec<String>,
}

#[tauri::command]
pub fn hook_command(connector_id: String, query: Option<String>) -> Result<HookCommand, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut args = vec!["--hook".to_string(), connector_id];
    if let Some(q) = query.filter(|q| !q.is_empty()) {
        args.push(q);
    }
    Ok(HookCommand { command: exe.to_string_lossy().into_owned(), args })
}

pub fn spawn_server(app: AppHandle, host: Arc<Host>) {
    use axum::{body::Bytes, extract::{Path, RawQuery}, http::HeaderMap, routing::post, Router};

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().expect("tokio");
        rt.block_on(async move {
            let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
                Ok(l) => l,
                Err(e) => return host.log.write(&format!("hook server bind failed: {e}")),
            };
            let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
            PORT.store(port, Ordering::Relaxed);
            let _ = std::fs::write(&host.paths.hook_port_file, port.to_string());
            host.log.write(&format!("hook server on 127.0.0.1:{port}"));

            let handler = move |Path(connector_id): Path<String>, RawQuery(q): RawQuery, headers: HeaderMap, body: Bytes| {
                let app = app.clone();
                async move {
                    const KEEP: [&str; 3] = ["content-type", "user-agent", "x-session-id"];
                    let headers = headers
                        .iter()
                        .filter(|(k, _)| KEEP.contains(&k.as_str()))
                        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                        .collect();
                    let received_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                    let req = HookRequest {
                        connector_id,
                        query: q.unwrap_or_default(),
                        headers,
                        body: String::from_utf8_lossy(&body).into_owned(),
                        received_at,
                    };
                    let _ = app.emit_to(crate::stages::KERNEL_STAGE, "hook", req);
                    "ok"
                }
            };
            let router = Router::new().route("/hook/{connector}", post(handler));
            if let Err(e) = axum::serve(listener, router).await {
                host.log.write(&format!("hook server stopped: {e}"));
            }
        });
    });
}
