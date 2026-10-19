//! One transparent stage window per monitor (docs/01 §2).
//! stage-0 always sits on the primary monitor and hosts the kernel; the others are dumb renderers.
//! Monitor changes are polled; windows are moved/added/closed in place so the kernel never reloads.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::Host;

pub const KERNEL_STAGE: &str = "stage-0";

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StageInfo {
    pub label: String,
    /// Work area in physical pixels.
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub scale: f64,
}

#[derive(Default)]
pub struct Layout(pub Mutex<Vec<StageInfo>>);

#[derive(Serialize, Clone, PartialEq)]
struct Cursor {
    x: f64,
    y: f64,
}

#[tauri::command]
pub fn get_layout(layout: tauri::State<'_, Layout>) -> Vec<StageInfo> {
    layout.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_hit(window: WebviewWindow, hit: bool) {
    let _ = window.set_ignore_cursor_events(!hit);
    no_activate(&window);
}

/// Clicking a pet must not steal keyboard focus from the user's app.
fn no_activate(window: &WebviewWindow) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE};
        let h = hwnd.0 as windows_sys::Win32::Foundation::HWND;
        unsafe {
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
            if ex & WS_EX_NOACTIVATE as isize == 0 {
                SetWindowLongPtrW(h, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE as isize);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

fn read_monitors(app: &AppHandle) -> Vec<StageInfo> {
    let Ok(mut monitors) = app.available_monitors() else { return Vec::new() };
    if let Ok(Some(p)) = app.primary_monitor() {
        monitors.sort_by_key(|m| if m.position() == p.position() { 0 } else { 1 });
    }
    monitors
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let wa = m.work_area();
            StageInfo {
                label: format!("stage-{i}"),
                x: wa.position.x,
                y: wa.position.y,
                w: wa.size.width,
                h: wa.size.height,
                scale: m.scale_factor(),
            }
        })
        .collect()
}

fn apply_layout(app: &AppHandle, host: &Host, next: Vec<StageInfo>) -> tauri::Result<()> {
    for s in &next {
        host.log.write(&format!("{}: ({},{} {}x{}) scale={}", s.label, s.x, s.y, s.w, s.h, s.scale));
        let win = match app.get_webview_window(&s.label) {
            Some(w) => w,
            None => WebviewWindowBuilder::new(app, &s.label, WebviewUrl::App("stage.html".into()))
                .title("petween stage")
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .build()?,
        };
        win.set_position(PhysicalPosition::new(s.x, s.y))?;
        win.set_size(PhysicalSize::new(s.w, s.h))?;
        win.set_ignore_cursor_events(true)?;
        no_activate(&win);
        win.show()?;
    }
    for (label, win) in app.webview_windows() {
        if label.starts_with("stage-") && !next.iter().any(|s| s.label == label) {
            let _ = win.close();
        }
    }
    *app.state::<Layout>().0.lock().unwrap() = next.clone();
    let _ = app.emit("layout", next);
    Ok(())
}

pub fn init(app: &AppHandle, host: &Arc<Host>) -> tauri::Result<()> {
    app.manage(Layout::default());
    apply_layout(app, host, read_monitors(app))?;

    // Monitor watch: cheap poll, rebuild only on change.
    let (a, h) = (app.clone(), host.clone());
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        let next = read_monitors(&a);
        let changed = !next.is_empty() && *a.state::<Layout>().0.lock().unwrap() != next;
        if changed {
            h.log.write("monitor layout changed");
            if let Err(e) = apply_layout(&a, &h, next) {
                h.log.write(&format!("apply layout failed: {e}"));
            }
        }
    });

    // Cursor poll at ~60Hz; emits only on change (docs/08: idle CPU).
    let a = app.clone();
    std::thread::spawn(move || {
        let mut last: Option<Cursor> = None;
        loop {
            std::thread::sleep(Duration::from_millis(16));
            let Some(c) = cursor_now(&a) else { continue };
            if last.as_ref() != Some(&c) {
                let _ = a.emit("cursor", c.clone());
                last = Some(c);
            }
        }
    });
    Ok(())
}

/// Tauri's cursor_position() round-trips through the main event loop; read it directly instead.
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

