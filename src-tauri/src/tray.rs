//! Tray: host-owned items (rescue, autostart, quit) + items contributed through `ctx.tray.addItem`
//! (the kernel sends the full list; clicks are routed back to it by id).

use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;

use crate::stages::KERNEL_STAGE;

const TRAY_ID: &str = "main";

#[derive(Deserialize, Clone)]
pub struct TrayItem {
    id: String,
    label: String,
    checked: Option<bool>,
    enabled: Option<bool>,
}

#[derive(Default)]
struct TrayModel {
    items: Vec<TrayItem>,
    rescue_hotkey: Option<String>,
}

#[tauri::command]
pub fn tray_set_items(app: AppHandle, items: Vec<TrayItem>) {
    app.state::<Mutex<TrayModel>>().lock().unwrap().items = items;
    rebuild(&app);
}

pub fn set_rescue_label(app: &AppHandle, hotkey: Option<&str>) {
    app.state::<Mutex<TrayModel>>().lock().unwrap().rescue_hotkey = hotkey.map(pretty_hotkey);
    rebuild(app);
}

fn pretty_hotkey(s: &str) -> String {
    s.split('+')
        .map(|p| match p {
            "ctrl" => "Ctrl".to_string(),
            "alt" => "Alt".to_string(),
            k => k.trim_start_matches("Key").to_string(),
        })
        .collect::<Vec<_>>()
        .join("+")
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let model = app.state::<Mutex<TrayModel>>();
    let model = model.lock().unwrap();
    let mut owned: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    for it in &model.items {
        let id = format!("p:{}", it.id);
        let enabled = it.enabled.unwrap_or(true);
        match it.checked {
            Some(c) => owned.push(Box::new(CheckMenuItem::with_id(app, id, &it.label, enabled, c, None::<&str>)?)),
            None => owned.push(Box::new(MenuItem::with_id(app, id, &it.label, enabled, None::<&str>)?)),
        }
    }
    if !model.items.is_empty() {
        owned.push(Box::new(PredefinedMenuItem::separator(app)?));
    }
    owned.push(Box::new(MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?));
    let rescue = match &model.rescue_hotkey {
        Some(k) => format!("找回宠物（{k}）"),
        None => "找回宠物".to_string(),
    };
    owned.push(Box::new(MenuItem::with_id(app, "rescue", rescue, true, None::<&str>)?));
    let auto = app.autolaunch().is_enabled().unwrap_or(false);
    owned.push(Box::new(CheckMenuItem::with_id(app, "autostart", "开机自启", true, auto, None::<&str>)?));
    owned.push(Box::new(PredefinedMenuItem::separator(app)?));
    owned.push(Box::new(MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?));
    let refs: Vec<&dyn IsMenuItem<Wry>> = owned.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(app, &refs)
}

fn rebuild(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), build_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    app.manage(Mutex::new(TrayModel::default()));
    let menu = build_menu(app)?;
    let mut b = TrayIconBuilder::with_id(TRAY_ID).tooltip("Petween").menu(&menu).show_menu_on_left_click(true);
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.on_menu_event(|app, ev| {
        let id = ev.id().as_ref();
        match id {
            "quit" => app.exit(0),
            "settings" => {
                if let Err(e) = crate::open_settings_window(app) {
                    eprintln!("open settings failed: {e}");
                }
            }
            "rescue" => {
                let _ = app.emit_to(KERNEL_STAGE, "rescue", ());
            }
            "autostart" => {
                let al = app.autolaunch();
                let _ = if al.is_enabled().unwrap_or(false) { al.disable() } else { al.enable() };
                rebuild(app);
            }
            other => {
                if let Some(pid) = other.strip_prefix("p:") {
                    let _ = app.emit_to(KERNEL_STAGE, "tray-click", pid.to_string());
                }
            }
        }
    })
    .build(app)?;
    Ok(())
}
