//! Petween host (docs/01 §1, §6). Thin by design: windows, tray, OS capabilities, hook ingress.
//! No pet logic and no agent formats live here.

mod caps;
mod forward;
mod hook;
mod log;
mod protocol;
mod stages;
mod tray;

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub struct Host {
    pub log: log::Log,
    pub paths: Paths,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Paths {
    pub app_data: PathBuf,
    pub home: PathBuf,
    pub pets: PathBuf,
    pub plugins: PathBuf,
    pub settings: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
    pub instances: PathBuf,
    pub hook_port_file: PathBuf,
}

impl Paths {
    fn new(app: &AppHandle) -> tauri::Result<Self> {
        let app_data = app.path().app_data_dir()?;
        let home = app.path().home_dir()?;
        let p = Paths {
            pets: app_data.join("pets"),
            plugins: app_data.join("plugins"),
            settings: app_data.join("settings"),
            data: app_data.join("data"),
            cache: app_data.join("cache"),
            instances: app_data.join("instances.json"),
            hook_port_file: app_data.join("hook-port"),
            home,
            app_data,
        };
        for d in [&p.pets, &p.plugins, &p.settings, &p.data, &p.cache] {
            std::fs::create_dir_all(d)?;
        }
        Ok(p)
    }
}

/// Entry for `petween --hook …` (see forward.rs).
pub fn forward_hook(args: &[String]) {
    forward::run(args);
}

pub type HostState<'a> = tauri::State<'a, Arc<Host>>;

/// Rescue hotkey candidates, first free one wins (same list as v0).
const RESCUE_HOTKEYS: [&str; 3] = ["ctrl+alt+KeyP", "ctrl+alt+KeyI", "ctrl+alt+KeyU"];

#[tauri::command]
fn paths(state: HostState<'_>) -> Paths {
    state.paths.clone()
}

#[tauri::command]
fn log_line(state: HostState<'_>, window: tauri::WebviewWindow, level: String, line: String) {
    state.log.write(&format!("{} {level}: {line}", window.label()));
}

/// The settings window (docs/01 §2): created on demand, focused if already open.
pub fn open_settings_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        w.show()?;
        return w.set_focus();
    }
    tauri::WebviewWindowBuilder::new(app, "settings", tauri::WebviewUrl::App("settings.html".into()))
        .title("Petween 设置")
        .inner_size(940.0, 660.0)
        .min_inner_size(760.0, 520.0)
        .center()
        .build()?;
    Ok(())
}

#[tauri::command]
async fn open_settings(app: AppHandle) -> Result<(), String> {
    open_settings_window(&app).map_err(|e| e.to_string())
}

/// The pet pack editor (docs/09 M3a): one window, focused if already open. `pack` = which pack to open.
pub fn open_editor_window(app: &AppHandle, pack: Option<&str>) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("editor") {
        if let Some(p) = pack {
            let _ = app.emit_to("editor", "editor-open", p.to_string());
        }
        let _ = w.unminimize();
        w.show()?;
        return w.set_focus();
    }
    let url = match pack {
        Some(p) => format!(
            "editor.html?pack={}",
            p.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>()
        ),
        None => "editor.html".to_string(),
    };
    tauri::WebviewWindowBuilder::new(app, "editor", tauri::WebviewUrl::App(url.into()))
        .title("Petween 宠物编辑器")
        .inner_size(1280.0, 800.0)
        .min_inner_size(980.0, 620.0)
        .center()
        // Let the page receive HTML drag-and-drop (files dropped onto the clip library).
        .disable_drag_drop_handler()
        .build()?
        // Whatever the editor was showing on the desktop (draft try-on, forced state) ends with it.
        .on_window_event({
            let app = app.clone();
            move |e| {
                if let tauri::WindowEvent::Destroyed = e {
                    let _ = app.emit_to(stages::KERNEL_STAGE, "editor-closed", ());
                }
            }
        });
    Ok(())
}

#[tauri::command]
async fn open_editor(app: AppHandle, pack: Option<String>) -> Result<(), String> {
    open_editor_window(&app, pack.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // `petween --settings` while running opens the settings; a plain second launch flashes the pets.
            if args.iter().any(|a| a == "--settings") {
                let _ = open_settings_window(app);
            } else if args.iter().any(|a| a == "--editor") {
                let _ = open_editor_window(app, None);
            } else {
                let _ = app.emit_to(stages::KERNEL_STAGE, "second-instance", ());
            }
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = app.emit_to(stages::KERNEL_STAGE, "rescue", ());
                    }
                })
                .build(),
        )
        .register_uri_scheme_protocol("petplugin", |ctx, req| {
            let dir = ctx.app_handle().state::<Arc<Host>>().paths.plugins.clone();
            protocol::serve(&dir, req.uri().path())
        })
        .register_uri_scheme_protocol("petpack", |ctx, req| {
            let dir = ctx.app_handle().state::<Arc<Host>>().paths.pets.clone();
            protocol::serve(&dir, req.uri().path())
        })
        .invoke_handler(tauri::generate_handler![
            paths,
            log_line,
            quit,
            open_settings,
            open_editor,
            stages::get_layout,
            stages::set_hit,
            hook::hook_port,
            hook::hook_command,
            caps::fs_read_text,
            caps::fs_read_tail,
            caps::fs_write_text,
            caps::fs_read_bytes,
            caps::fs_write_bytes,
            caps::fs_list,
            caps::fs_exists,
            caps::fs_mkdir,
            caps::fs_remove,
            caps::shell_exec,
            caps::open_external,
            tray::tray_set_items,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let paths = Paths::new(&handle)?;
            let host = Arc::new(Host { log: log::Log::open(&paths.app_data.join("petween.log"))?, paths });
            host.log.write(&format!("=== petween {} start, data={}", env!("CARGO_PKG_VERSION"), host.paths.app_data.display()));
            app.manage(host.clone());

            hook::spawn_server(handle.clone(), host.clone());
            protocol::spawn_plugin_watcher(handle.clone(), host.clone())?;
            tray::create(&handle)?;
            stages::init(&handle, &host)?;

            let shortcuts = handle.global_shortcut();
            let used = RESCUE_HOTKEYS.iter().find(|s| shortcuts.register(**s).is_ok());
            match used {
                Some(s) => host.log.write(&format!("rescue hotkey: {s}")),
                None => host.log.write("rescue hotkey: all candidates taken"),
            }
            tray::set_rescue_label(&handle, used.copied());
            if std::env::args().any(|a| a == "--settings") {
                open_settings_window(&handle)?;
            }
            if std::env::args().any(|a| a == "--editor") {
                open_editor_window(&handle, None)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running petween");
}
