//! Spike host. Throwaway code for docs/08 — not a base for real code.
//!
//! Host duties exercised here:
//!   1. one transparent stage window per monitor + 60Hz cursor poll + passthrough toggle
//!   3. axum hook server on 127.0.0.1:<random>, raw forward to the runtime, latency ack
//!   5. `petplugin://` scheme serving <app data>/plugins + file watcher for hot reload

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::http::{Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

struct Spike {
    log: Mutex<fs::File>,
    started: Instant,
    hook_seq: AtomicU64,
    hook_pending: Mutex<HashMap<u64, Instant>>,
    pets: u32,
    anim: bool,
}

impl Spike {
    fn log(&self, line: &str) {
        let t = self.started.elapsed().as_secs_f64();
        let msg = format!("[{t:9.3}] {line}");
        println!("{msg}");
        if let Ok(mut f) = self.log.lock() {
            let _ = writeln!(f, "{msg}");
        }
    }
}

#[derive(Serialize, Clone)]
struct Config {
    pets: u32,
    anim: bool,
    hook_port: u16,
}

#[derive(Serialize, Clone)]
struct HookEvent {
    seq: u64,
    connector: String,
    query: String,
    headers: HashMap<String, String>,
    body: String,
}

#[derive(Serialize, Clone, PartialEq)]
struct Cursor {
    x: f64,
    y: f64,
}

static HOOK_PORT: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
fn get_config(state: tauri::State<'_, Arc<Spike>>) -> Config {
    Config { pets: state.pets, anim: state.anim, hook_port: HOOK_PORT.load(Ordering::Relaxed) as u16 }
}

#[tauri::command]
fn set_hit(window: WebviewWindow, hit: bool) {
    let _ = window.set_ignore_cursor_events(!hit);
}

#[tauri::command]
fn log_line(state: tauri::State<'_, Arc<Spike>>, window: WebviewWindow, line: String) {
    state.log(&format!("{}: {line}", window.label()));
}

#[tauri::command]
fn hook_ack(state: tauri::State<'_, Arc<Spike>>, seq: u64) {
    let start = state.hook_pending.lock().unwrap().remove(&seq);
    if let Some(start) = start {
        let us = start.elapsed().as_micros();
        state.log(&format!("hook #{seq} host->runtime->ack {:.2}ms", us as f64 / 1000.0));
    }
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

fn plugins_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().expect("app data dir").join("plugins")
}

const SEED_PLUGIN: &str = r#"// Sample plugin. Edit and save: the stage hot-reloads it.
export function activate(ctx) {
  const off = ctx.addBadge('hello v1');
  ctx.log('hello plugin activated');
  return () => { off(); ctx.log('hello plugin disposed'); };
}
"#;

fn spawn_hook_server(app: AppHandle, state: Arc<Spike>) {
    use axum::{body::Bytes, extract::{Path, RawQuery}, http::HeaderMap, routing::post, Router};

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            HOOK_PORT.store(port as u64, Ordering::Relaxed);
            let dir = app.path().app_data_dir().unwrap();
            let _ = fs::write(dir.join("hook-port"), port.to_string());
            state.log(&format!("hook server on 127.0.0.1:{port}"));

            let st = state.clone();
            let handler = move |Path(connector): Path<String>, RawQuery(q): RawQuery, headers: HeaderMap, body: Bytes| {
                let st = st.clone();
                let app = app.clone();
                async move {
                    let seq = st.hook_seq.fetch_add(1, Ordering::Relaxed) + 1;
                    st.hook_pending.lock().unwrap().insert(seq, Instant::now());
                    let keep = ["content-type", "user-agent", "x-session-id"];
                    let headers = headers
                        .iter()
                        .filter(|(k, _)| keep.contains(&k.as_str()))
                        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                        .collect();
                    let ev = HookEvent {
                        seq,
                        connector,
                        query: q.unwrap_or_default(),
                        headers,
                        body: String::from_utf8_lossy(&body).into_owned(),
                    };
                    let _ = app.emit_to("stage-0", "hook", ev);
                    "ok"
                }
            };
            let router = Router::new().route("/hook/{connector}", post(handler));
            axum::serve(listener, router).await.unwrap();
        });
    });
}

/// Read the cursor without a main-thread round trip (Tauri's cursor_position() posts to the event loop).
#[cfg(windows)]
fn cursor_now(_app: &AppHandle) -> Option<Cursor> {
    use windows_sys::Win32::{Foundation::POINT, UI::WindowsAndMessaging::GetCursorPos};
    let mut p = POINT { x: 0, y: 0 };
    (unsafe { GetCursorPos(&mut p) } != 0).then(|| Cursor { x: p.x as f64, y: p.y as f64 })
}

#[cfg(not(windows))]
fn cursor_now(app: &AppHandle) -> Option<Cursor> {
    app.cursor_position().ok().map(|p| Cursor { x: p.x, y: p.y })
}

fn spawn_cursor_poll(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<Cursor> = None;
        loop {
            std::thread::sleep(Duration::from_millis(16));
            let Some(c) = cursor_now(&app) else { continue };
            if last.as_ref() != Some(&c) {
                let _ = app.emit("cursor", c.clone());
                last = Some(c);
            }
        }
    });
}

fn spawn_plugin_watcher(app: AppHandle, state: Arc<Spike>) {
    use notify::{RecursiveMode, Watcher};
    let dir = plugins_dir(&app);
    let app2 = app.clone();
    let root = dir.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        for p in ev.paths {
            if let Ok(rel) = p.strip_prefix(&root) {
                if let Some(first) = rel.components().next() {
                    let id = first.as_os_str().to_string_lossy().to_string();
                    let _ = app2.emit_to("stage-0", "plugin-changed", id);
                }
            }
        }
    })
    .expect("watcher");
    watcher.watch(&dir, RecursiveMode::Recursive).expect("watch plugins dir");
    state.log(&format!("watching {}", dir.display()));
    // Keep the watcher alive for the app's lifetime.
    app.manage(Mutex::new(watcher));
}

fn open_stages(app: &AppHandle, state: &Spike) -> tauri::Result<()> {
    let mut monitors = app.available_monitors()?;
    let primary = app.primary_monitor()?;
    // Primary monitor first: stage-0 hosts the kernel, the rest are dumb renderers.
    if let Some(p) = &primary {
        monitors.sort_by_key(|m| if m.position() == p.position() { 0 } else { 1 });
    }
    for (i, m) in monitors.iter().enumerate() {
        // SPIKE_SMALL=1: 600x600 stage, to measure what the full-screen surface costs.
        let mut wa = *m.work_area();
        if std::env::var("SPIKE_SMALL").is_ok() {
            wa.size.width = 600;
            wa.size.height = 600;
        }
        let scale = m.scale_factor();
        state.log(&format!(
            "monitor {i}: {:?} work_area=({},{} {}x{}) scale={scale}",
            m.name(),
            wa.position.x,
            wa.position.y,
            wa.size.width,
            wa.size.height
        ));
        let url = format!(
            "index.html?stage={i}&n={}&x={}&y={}&w={}&h={}&scale={scale}",
            monitors.len(),
            wa.position.x, wa.position.y, wa.size.width, wa.size.height
        );
        let win = WebviewWindowBuilder::new(app, format!("stage-{i}"), WebviewUrl::App(url.into()))
            .title("petween stage")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .build()?;
        win.set_position(PhysicalPosition::new(wa.position.x, wa.position.y))?;
        win.set_size(PhysicalSize::new(wa.size.width, wa.size.height))?;
        win.set_ignore_cursor_events(true)?;
        win.show()?;
    }
    Ok(())
}

fn arg_value(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

pub fn run() {
    let pets = arg_value("--pets").or_else(|| std::env::var("SPIKE_PETS").ok()).and_then(|v| v.parse().ok()).unwrap_or(3);
    let anim = arg_value("--anim").or_else(|| std::env::var("SPIKE_ANIM").ok()).map(|v| v != "0").unwrap_or(true);

    tauri::Builder::default()
        .register_uri_scheme_protocol("petplugin", |ctx, req| {
            let dir = plugins_dir(ctx.app_handle());
            let rel = req.uri().path().trim_start_matches('/');
            let path = dir.join(rel);
            let ok = !rel.contains("..") && path.starts_with(&dir);
            match (ok, fs::read(&path)) {
                (true, Ok(bytes)) => Response::builder()
                    .header("Content-Type", "text/javascript")
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
        })
        .invoke_handler(tauri::generate_handler![get_config, set_hit, log_line, hook_ack, quit])
        .setup(move |app| {
            let handle = app.handle().clone();
            let data = handle.path().app_data_dir()?;
            fs::create_dir_all(data.join("plugins/hello"))?;
            let seed = data.join("plugins/hello/index.js");
            if !seed.exists() {
                fs::write(&seed, SEED_PLUGIN)?;
            }
            let log = OpenOptions::new().create(true).append(true).open(data.join("spike.log"))?;
            let state = Arc::new(Spike {
                log: Mutex::new(log),
                started: Instant::now(),
                hook_seq: AtomicU64::new(0),
                hook_pending: Mutex::new(HashMap::new()),
                pets,
                anim,
            });
            let epoch = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
            state.log(&format!("=== start epoch={epoch} pets={pets} anim={anim} data={}", data.display()));
            app.manage(state.clone());

            spawn_hook_server(handle.clone(), state.clone());
            spawn_plugin_watcher(handle.clone(), state.clone());
            open_stages(&handle, &state)?;
            spawn_cursor_poll(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
