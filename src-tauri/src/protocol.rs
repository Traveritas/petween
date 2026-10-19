//! `petplugin://` and `petpack://` serve files from app data (docs/08 results: CSP + CORS).
//! On Windows the webview sees them as http://petplugin.localhost/ and http://petpack.localhost/.

use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::http::{Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager};

use crate::Host;

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("js" | "mjs") => "text/javascript",
        Some("json") => "application/json",
        Some("css") => "text/css",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webm") => "video/webm",
        Some("mp4") => "video/mp4",
        _ => "application/octet-stream",
    }
}

pub fn serve(root: &Path, uri_path: &str) -> Response<Vec<u8>> {
    let rel = percent_decode(uri_path.trim_start_matches('/'));
    let path = root.join(&rel);
    let inside = !rel.split(['/', '\\']).any(|seg| seg == "..");
    match (inside, std::fs::read(&path)) {
        (true, Ok(bytes)) => Response::builder()
            .header("Content-Type", mime(&path))
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "no-store")
            .body(bytes)
            .unwrap(),
        _ => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .unwrap(),
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Third-party plugin folder watcher; the kernel decides whether to hot-reload (dev mode).
pub fn spawn_plugin_watcher(app: AppHandle, host: Arc<Host>) -> tauri::Result<()> {
    use notify::{RecursiveMode, Watcher};
    let root = host.paths.plugins.clone();
    let app2 = app.clone();
    let root2 = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        for p in ev.paths {
            if let Some(first) = p.strip_prefix(&root2).ok().and_then(|r| r.components().next()) {
                let id = first.as_os_str().to_string_lossy().to_string();
                let _ = app2.emit_to(crate::stages::KERNEL_STAGE, "plugin-changed", id);
            }
        }
    })
    .map_err(|e| tauri::Error::Anyhow(e.into()))?;
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| tauri::Error::Anyhow(e.into()))?;
    app.manage(Mutex::new(watcher));
    Ok(())
}
