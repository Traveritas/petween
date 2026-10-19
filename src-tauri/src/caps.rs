//! Capability commands for plugins (docs/06 §4 `ctx.host`). Trust model: no path restrictions.
//! All are async so they run off the main thread.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

type R<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn fs_read_text(path: PathBuf) -> R<String> {
    std::fs::read_to_string(path).map_err(err)
}

/// Atomic: write a sibling temp file, then rename over the target.
#[tauri::command]
pub async fn fs_write_text(path: PathBuf, content: String) -> R<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let tmp = path.with_extension(format!("{}.tmp", path.extension().and_then(|e| e.to_str()).unwrap_or("")));
    std::fs::write(&tmp, content).map_err(err)?;
    std::fs::rename(&tmp, &path).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    is_dir: bool,
}

#[tauri::command]
pub async fn fs_list(path: PathBuf) -> R<Vec<Entry>> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(path).map_err(err)? {
        let e = e.map_err(err)?;
        out.push(Entry { name: e.file_name().to_string_lossy().into_owned(), is_dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false) });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// The last `max_bytes` of a text file, starting at a line boundary (transcripts can be huge).
#[tauri::command]
pub async fn fs_read_tail(path: PathBuf, max_bytes: u64) -> R<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(err)?;
    let len = f.metadata().map_err(err)?.len();
    let start = len.saturating_sub(max_bytes);
    f.seek(SeekFrom::Start(start)).map_err(err)?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf).map_err(err)?;
    let text = String::from_utf8_lossy(&buf);
    // Mid-file start: drop the partial first line.
    Ok(if start > 0 { text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default() } else { text.into_owned() })
}

#[tauri::command]
pub async fn fs_exists(path: PathBuf) -> bool {
    path.exists()
}

#[tauri::command]
pub async fn fs_mkdir(path: PathBuf) -> R<()> {
    std::fs::create_dir_all(path).map_err(err)
}

#[tauri::command]
pub async fn fs_remove(path: PathBuf) -> R<()> {
    if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) }.map_err(err)
}

#[derive(Serialize)]
pub struct ExecResult {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[tauri::command]
pub async fn shell_exec(cmd: String, args: Vec<String>, cwd: Option<PathBuf>) -> R<ExecResult> {
    let mut c = Command::new(cmd);
    c.args(args);
    if let Some(cwd) = cwd {
        c.current_dir(cwd);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = c.output().map_err(err)?;
    Ok(ExecResult {
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> R<()> {
    app.opener().open_url(url, None::<&str>).map_err(err)
}
