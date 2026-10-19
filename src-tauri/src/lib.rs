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

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app.emit_to(stages::KERNEL_STAGE, "second-instance", ());
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
            stages::get_layout,
            stages::set_hit,
            hook::hook_port,
            hook::hook_command,
            caps::fs_read_text,
            caps::fs_read_tail,
            caps::fs_write_text,
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running petween");
}
