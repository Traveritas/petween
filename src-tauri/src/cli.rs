//! `petween --pack <command> …`: pack tooling for scripts and agents (docs/10).
//! Like `--hook`, this never starts the app: it sends the arguments (plus the working directory, so
//! relative paths work) to the running app, which does the work in the kernel and answers with JSON.
//! The JSON is printed to stdout; the exit code is 0 on success, 1 on failure, 2 when Petween isn't running.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use crate::forward::port_file;

/// Imports decode video frame by frame; give them time.
const TIMEOUT: Duration = Duration::from_secs(300);

pub fn run(args: &[String]) -> i32 {
    attach_console();
    match send(args) {
        Ok((ok, body)) => {
            println!("{body}");
            if ok { 0 } else { 1 }
        }
        Err(msg) => {
            println!("{}", serde_json::json!({ "ok": false, "error": msg }));
            2
        }
    }
}

fn send(args: &[String]) -> Result<(bool, String), String> {
    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let body = serde_json::json!({ "args": args, "cwd": cwd }).to_string();
    let port: u16 = port_file()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|s| s.trim().parse().ok())
        .ok_or("Petween 没有在运行（找不到端口文件）")?;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(1500)).map_err(|_| "Petween 没有在运行（连不上）".to_string())?;
    s.set_read_timeout(Some(TIMEOUT)).ok();
    let head = format!(
        "POST /pack HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
    s.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    let mut resp = Vec::new();
    s.read_to_end(&mut resp).map_err(|e| format!("等回复超时或中断：{e}"))?;
    let text = String::from_utf8_lossy(&resp);
    let (head, body) = text.split_once("\r\n\r\n").ok_or("回复格式不对")?;
    let ok = head.lines().next().is_some_and(|l| l.contains(" 200 "));
    Ok((ok, body.to_string()))
}

/// The release exe is a GUI program: when output isn't already piped somewhere (an agent capturing
/// it), borrow the terminal it was started from so println! shows up.
fn attach_console() {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Console::{AttachConsole, GetStdHandle, ATTACH_PARENT_PROCESS, STD_OUTPUT_HANDLE};
        let h = GetStdHandle(STD_OUTPUT_HANDLE);
        if h.is_null() || h == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}
