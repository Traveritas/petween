//! `petween --hook <connectorId> [query]`: the agent-side hook command (docs/05 §1).
//! Reads the hook's stdin, POSTs it verbatim to the running app, prints nothing, always exits 0.
//! It never parses the payload — the connector plugin does that in the runtime.
//!
//! Why not curl / node (v0): curl.exe fails under Codex's Windows hook runner when it reads stdin
//! and does network in one process, and node is not always installed. Being our own exe also
//! removes the per-port cfg files: the port is read from `<app data>/hook-port` at call time.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

/// Must match `identifier` in tauri.conf.json (Tauri's app data dir name).
const IDENTIFIER: &str = "com.petween.app";
const MAX_BODY: u64 = 4 * 1024 * 1024;

pub(crate) fn port_file() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    base.map(|b| b.join(IDENTIFIER).join("hook-port"))
}

fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn valid_query(s: &str) -> bool {
    s.len() <= 256 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_=&.%".contains(&b))
}

pub fn run(args: &[String]) {
    // Hard stop: a hook must never hang the agent.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(2500));
        std::process::exit(0);
    });
    let _ = forward(args);
}

fn forward(args: &[String]) -> Option<()> {
    let id = args.first().filter(|s| valid_id(s))?;
    let query = args.get(1).map(String::as_str).unwrap_or("");
    if !valid_query(query) {
        return None;
    }
    let mut body = Vec::new();
    std::io::stdin().take(MAX_BODY).read_to_end(&mut body).ok()?;

    let port: u16 = std::fs::read_to_string(port_file()?).ok()?.trim().parse().ok()?;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).ok()?;
    s.set_write_timeout(Some(Duration::from_millis(1500))).ok()?;
    s.set_read_timeout(Some(Duration::from_millis(1500))).ok()?;
    let q = if query.is_empty() { String::new() } else { format!("?{query}") };
    let head = format!(
        "POST /hook/{id}{q} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(head.as_bytes()).ok()?;
    s.write_all(&body).ok()?;
    // Wait for the reply so the request is fully delivered before we exit.
    let mut sink = [0u8; 256];
    let _ = s.read(&mut sink);
    Some(())
}
