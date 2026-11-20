//! Tiny file logger, panic hook and crash-relaunch guard.
//!
//! The app runs as a windowless tray program, so without a log file a silent
//! exit leaves nothing to diagnose. Log: `<config dir>/t3-deskcat/deskcat.log`
//! (rotated to `deskcat.log.1` past 1 MB).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_LOG_BYTES: u64 = 1024 * 1024;
/// At most this many relaunches inside the window, so a crash on startup cannot loop.
const RELAUNCH_MAX: usize = 3;
const RELAUNCH_WINDOW_SECS: u64 = 600;
pub const RELAUNCH_FLAG: &str = "--relaunch";

fn dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("t3-deskcat"))
}

pub fn log_path() -> Option<PathBuf> {
    dir().map(|d| d.join("deskcat.log"))
}

pub fn log(msg: &str) {
    let Some(path) = log_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::metadata(&path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, path.with_extension("log.1"));
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(f, "[{ts}] [pid {}] {msg}", std::process::id());
    }
}

/// Log every panic with thread, location and backtrace. A panic on the main
/// thread kills the app, so that case also relaunches it (rate-limited).
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("<unnamed>").to_string();
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string payload>".to_string());
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let backtrace = std::backtrace::Backtrace::force_capture();
        log(&format!(
            "PANIC thread={name} at {location}: {payload}\n{backtrace}"
        ));
        if name == "main" {
            relaunch_guard("panic on main thread");
        }
        previous(info);
    }));
}

/// Start a fresh copy of this exe unless it already relaunched
/// `RELAUNCH_MAX` times in the last `RELAUNCH_WINDOW_SECS`.
pub fn relaunch_guard(reason: &str) {
    let Some(marker) = dir().map(|d| d.join("last_relaunch")) else { return };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut recent: Vec<u64> = fs::read_to_string(&marker)
        .unwrap_or_default()
        .split(',')
        .filter_map(|s| s.trim().parse::<u64>().ok())
        .filter(|t| now.saturating_sub(*t) < RELAUNCH_WINDOW_SECS)
        .collect();
    if recent.len() >= RELAUNCH_MAX {
        log(&format!("relaunch skipped ({} in last {RELAUNCH_WINDOW_SECS}s): {reason}", recent.len()));
        return;
    }
    recent.push(now);
    let body: Vec<String> = recent.iter().map(u64::to_string).collect();
    let _ = fs::write(&marker, body.join(","));
    match std::env::current_exe().and_then(|exe| std::process::Command::new(exe).arg(RELAUNCH_FLAG).spawn()) {
        Ok(child) => log(&format!("relaunching (new pid {}): {reason}", child.id())),
        Err(err) => log(&format!("relaunch failed: {err} ({reason})")),
    }
}
