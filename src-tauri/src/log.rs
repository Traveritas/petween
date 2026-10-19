//! Single log file in app data; truncated at startup when it grows past 2 MB.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

pub struct Log {
    file: Mutex<File>,
    started: Instant,
}

impl Log {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        if fs::metadata(path).map(|m| m.len() > 2 * 1024 * 1024).unwrap_or(false) {
            let _ = fs::remove_file(path);
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        Ok(Log { file: Mutex::new(file), started: Instant::now() })
    }

    pub fn write(&self, line: &str) {
        let msg = format!("[{:9.3}] {line}", self.started.elapsed().as_secs_f64());
        #[cfg(debug_assertions)]
        println!("{msg}");
        if let Ok(mut f) = self.file.lock() {
            let _ = writeln!(f, "{msg}");
        }
    }
}
