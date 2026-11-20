//! What the coding agents are doing right now, read from their local session
//! logs (read-only, the same files as `usage_stats`):
//!
//! * Claude Code: `<config dir>/projects/**/*.jsonl`
//! * Codex: `<codex home>/sessions/YYYY/MM/DD/*.jsonl`
//!
//! Every 2 s the newest log file is checked: written in the last few seconds,
//! or waiting on a tool / the model → `working`; last turn finished → `done`;
//! last line is an API error → `error`; nothing recent → `idle`.
//! Only the last 16 KB of one file are read per check.

use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Claude,
    Codex,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Src {
    pub account_id: String,
    pub kind: Kind,
    /// Claude: the config dir; Codex: the codex home.
    pub dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// "working" | "done" | "error" | "idle" | "unknown" (no log sources at all).
    pub state: &'static str,
    pub account_id: Option<String>,
    /// Unix seconds of the newest log write.
    pub last_write: i64,
}

impl Default for Activity {
    fn default() -> Self {
        Activity { state: "unknown", account_id: None, last_write: 0 }
    }
}

/// Written within this many seconds = working, whatever the last line says.
const FRESH_SECS: u64 = 6;
/// A turn waiting on a tool or the model counts as working for this long.
const PENDING_SECS: u64 = 180;
/// An error line is shown for this long.
const ERROR_SECS: u64 = 120;
/// After this long without writes everything is idle.
const IDLE_SECS: u64 = 600;
/// Files modified longer ago than this are not watched.
const WATCH_SECS: u64 = 30 * 60;
const TAIL_BYTES: u64 = 16 * 1024;

fn sources() -> &'static Mutex<Vec<Src>> {
    static S: OnceLock<Mutex<Vec<Src>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Vec::new()))
}

fn current() -> &'static Mutex<Activity> {
    static A: OnceLock<Mutex<Activity>> = OnceLock::new();
    A.get_or_init(|| Mutex::new(Activity::default()))
}

pub fn set_sources(list: Vec<Src>) {
    if let Ok(mut s) = sources().lock() {
        *s = list;
    }
}

pub fn get() -> Activity {
    current().lock().map(|a| a.clone()).unwrap_or_default()
}

/// What the last meaningful line of a session log says.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum LastEvent {
    /// Turn finished; waiting for the user.
    Done,
    /// Waiting on a tool result or the model.
    Pending,
    Error,
    Unknown,
}

pub fn classify_claude(tail: &str) -> LastEvent {
    for line in tail.lines().rev() {
        let Ok(o) = serde_json::from_str::<Value>(line) else { continue };
        let ty = o.get("type").and_then(Value::as_str).unwrap_or("");
        match ty {
            "assistant" => {
                if o.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true) {
                    return LastEvent::Error;
                }
                let stop = o.pointer("/message/stop_reason").and_then(Value::as_str);
                return match stop {
                    Some("end_turn") | Some("stop_sequence") => LastEvent::Done,
                    _ => LastEvent::Pending,
                };
            }
            "user" => return LastEvent::Pending,
            "system" => {
                if o.get("subtype").and_then(Value::as_str) == Some("api_error") {
                    return LastEvent::Error;
                }
            }
            _ => {}
        }
    }
    LastEvent::Unknown
}

pub fn classify_codex(tail: &str) -> LastEvent {
    for line in tail.lines().rev() {
        let Ok(o) = serde_json::from_str::<Value>(line) else { continue };
        if o.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        match o.pointer("/payload/type").and_then(Value::as_str).unwrap_or("") {
            "task_complete" | "turn_aborted" => return LastEvent::Done,
            "task_started" | "user_message" | "agent_message" | "exec_command_begin" => return LastEvent::Pending,
            "error" | "stream_error" => return LastEvent::Error,
            _ => {}
        }
    }
    LastEvent::Unknown
}

/// The state for a file last written `quiet` seconds ago whose last line is `ev`.
pub fn decide(quiet: u64, ev: LastEvent) -> &'static str {
    if quiet <= FRESH_SECS {
        return "working";
    }
    if quiet > IDLE_SECS {
        return "idle";
    }
    match ev {
        LastEvent::Pending if quiet <= PENDING_SECS => "working",
        LastEvent::Error if quiet <= ERROR_SECS => "error",
        LastEvent::Done => "done",
        _ => "idle",
    }
}

fn collect(dir: &Path, depth: u32, cutoff: SystemTime, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for ent in rd.flatten() {
        let p = ent.path();
        let Ok(ft) = ent.file_type() else { continue };
        if ft.is_dir() {
            collect(&p, depth - 1, cutoff, out);
        } else if p.extension().and_then(|e| e.to_str()) == Some("jsonl")
            && ent.metadata().and_then(|m| m.modified()).is_ok_and(|t| t >= cutoff)
        {
            out.push(p);
        }
    }
}

/// Recently modified log files of every source.
fn scan(list: &[Src]) -> Vec<(PathBuf, usize)> {
    let cutoff = SystemTime::now() - Duration::from_secs(WATCH_SECS);
    let mut out = Vec::new();
    for (i, s) in list.iter().enumerate() {
        let mut files = Vec::new();
        match s.kind {
            Kind::Claude => collect(&s.dir.join("projects"), 4, cutoff, &mut files),
            Kind::Codex => {
                let today = chrono::Local::now().date_naive();
                for d in [today, today.pred_opt().unwrap_or(today)] {
                    let dir = s
                        .dir
                        .join("sessions")
                        .join(d.format("%Y").to_string())
                        .join(d.format("%m").to_string())
                        .join(d.format("%d").to_string());
                    collect(&dir, 1, cutoff, &mut files);
                }
            }
        }
        out.extend(files.into_iter().map(|f| (f, i)));
    }
    out
}

fn tail(path: &Path) -> String {
    let Ok(mut f) = File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(TAIL_BYTES);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let s = String::from_utf8_lossy(&buf).into_owned();
    // Drop the first, probably cut, line.
    if start > 0 {
        s.split_once('\n').map(|(_, r)| r.to_string()).unwrap_or_default()
    } else {
        s
    }
}

fn check(list: &[Src], files: &[(PathBuf, usize)]) -> Activity {
    if list.is_empty() {
        return Activity::default();
    }
    let newest = files
        .iter()
        .filter_map(|(p, i)| fs::metadata(p).and_then(|m| m.modified()).ok().map(|t| (t, p, *i)))
        .max_by_key(|(t, _, _)| *t);
    let Some((mtime, path, i)) = newest else {
        return Activity { state: "idle", account_id: None, last_write: 0 };
    };
    let quiet = SystemTime::now().duration_since(mtime).map(|d| d.as_secs()).unwrap_or(0);
    let src = &list[i];
    let ev = if quiet <= FRESH_SECS {
        LastEvent::Pending
    } else {
        let t = tail(path);
        match src.kind {
            Kind::Claude => classify_claude(&t),
            Kind::Codex => classify_codex(&t),
        }
    };
    let last_write = mtime.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    Activity { state: decide(quiet, ev), account_id: Some(src.account_id.clone()), last_write }
}

/// Polls every 2 s and emits `agent-activity` to the pet window on changes.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut files: Vec<(PathBuf, usize)> = Vec::new();
        let mut last_scan = Instant::now() - Duration::from_secs(3600);
        let mut scanned_for: Vec<Src> = Vec::new();
        loop {
            let list = sources().lock().map(|s| s.clone()).unwrap_or_default();
            if list != scanned_for || last_scan.elapsed() >= Duration::from_secs(20) {
                files = scan(&list);
                last_scan = Instant::now();
                scanned_for = list.clone();
            }
            let next = check(&list, &files);
            let changed = current()
                .lock()
                .map(|mut cur| {
                    let changed = cur.state != next.state || cur.account_id != next.account_id;
                    *cur = next.clone();
                    changed
                })
                .unwrap_or(false);
            if changed {
                let _ = app.emit_to("pet", "agent-activity", &next);
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_last_line_wins() {
        let done = r#"{"type":"user","message":{}}
{"type":"assistant","message":{"stop_reason":"end_turn"}}
{"type":"system","subtype":"stop_hook_summary"}"#;
        assert_eq!(classify_claude(done), LastEvent::Done);
        let tool = r#"{"type":"assistant","message":{"stop_reason":"tool_use"}}"#;
        assert_eq!(classify_claude(tool), LastEvent::Pending);
        let err = r#"{"type":"assistant","message":{"stop_reason":"end_turn"}}
{"type":"system","subtype":"api_error"}"#;
        assert_eq!(classify_claude(err), LastEvent::Error);
        assert_eq!(classify_claude("not json"), LastEvent::Unknown);
    }

    #[test]
    fn codex_events() {
        let done = r#"{"type":"event_msg","payload":{"type":"task_started"}}
{"type":"event_msg","payload":{"type":"token_count"}}
{"type":"event_msg","payload":{"type":"task_complete"}}"#;
        assert_eq!(classify_codex(done), LastEvent::Done);
        let busy = r#"{"type":"event_msg","payload":{"type":"task_started"}}
{"type":"response_item","payload":{"type":"message"}}"#;
        assert_eq!(classify_codex(busy), LastEvent::Pending);
    }

    #[test]
    fn decide_by_quiet_time() {
        assert_eq!(decide(2, LastEvent::Done), "working");
        assert_eq!(decide(60, LastEvent::Pending), "working");
        assert_eq!(decide(400, LastEvent::Pending), "idle");
        assert_eq!(decide(30, LastEvent::Done), "done");
        assert_eq!(decide(30, LastEvent::Error), "error");
        assert_eq!(decide(300, LastEvent::Error), "idle");
        assert_eq!(decide(700, LastEvent::Done), "idle");
    }
}
