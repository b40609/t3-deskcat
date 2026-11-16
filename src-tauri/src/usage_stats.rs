//! Today's token usage per account, read from the local CLI logs (read-only):
//!
//! * Claude Code: `<config dir>/projects/**/*.jsonl`, assistant messages with
//!   `message.usage`; deduplicated by `message.id + requestId` (streamed messages
//!   are written more than once). Cost = equivalent Anthropic API list price.
//! * Codex: `<codex home>/sessions/YYYY/MM/DD/*.jsonl`, `token_count` events
//!   (`last_token_usage`).
//!
//! Files are parsed incrementally (append-only logs): each file remembers the byte
//! offset it was read up to, so a refresh only parses newly appended lines.

use chrono::{DateTime, Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageToday {
    pub account_id: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub total_tokens: u64,
    pub requests: u64,
    /// Equivalent API cost in USD (Claude only).
    pub cost_usd: Option<f64>,
}

pub enum Source {
    Claude { account_id: String, config_dir: PathBuf },
    Codex { account_id: String, codex_home: PathBuf },
}

#[derive(Clone)]
struct Entry {
    key: String,
    model: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write_5m: u64,
    cache_write_1h: u64,
}

#[derive(Default)]
struct FileState {
    offset: u64,
    entries: Vec<Entry>,
    /// Codex: last cumulative total, to skip repeated token_count events.
    last_total: u64,
}

#[derive(Default)]
struct Scanner {
    day: Option<NaiveDate>,
    files: HashMap<PathBuf, FileState>,
}

fn scanner() -> &'static Mutex<Scanner> {
    static S: OnceLock<Mutex<Scanner>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Scanner::default()))
}

/// USD per million tokens: (input, output, cache read). Cache writes are billed at
/// 1.25x (5 min) / 2x (1 h) of input.
fn price(model: &str) -> (f64, f64, f64) {
    let m = model.to_ascii_lowercase();
    let table: &[(&str, (f64, f64, f64))] = &[
        ("fable-5-2", (8.0, 40.0, 0.20)),
        ("mythos-5-2", (8.0, 40.0, 0.20)),
        ("fable-5", (10.0, 50.0, 1.0)),
        ("mythos", (10.0, 50.0, 1.0)),
        ("opus-5-5", (4.0, 20.0, 0.20)),
        ("opus-5", (5.0, 25.0, 0.50)),
        ("opus-4-8", (5.0, 25.0, 0.50)),
        ("opus-4-7", (5.0, 25.0, 0.50)),
        ("opus-4-6", (5.0, 25.0, 0.50)),
        ("opus-4-5", (5.0, 25.0, 0.50)),
        ("opus", (15.0, 75.0, 1.50)),
        ("sonnet-5-5", (2.0, 10.0, 0.10)),
        ("sonnet-5", (2.0, 10.0, 0.20)),
        ("sonnet", (3.0, 15.0, 0.30)),
        ("haiku-5-5", (0.10, 0.50, 0.01)),
        ("haiku-4-5", (1.0, 5.0, 0.10)),
        ("haiku", (0.80, 4.0, 0.08)),
    ];
    table
        .iter()
        .find(|(k, _)| m.contains(k))
        .map(|(_, p)| *p)
        .unwrap_or((4.0, 20.0, 0.20))
}

fn entry_cost(e: &Entry) -> f64 {
    let (i, o, r) = price(&e.model);
    (e.input as f64 * i
        + e.output as f64 * o
        + e.cache_read as f64 * r
        + e.cache_write_5m as f64 * i * 1.25
        + e.cache_write_1h as f64 * i * 2.0)
        / 1_000_000.0
}

fn is_today(ts: &str, today: NaiveDate) -> bool {
    DateTime::parse_from_rfc3339(ts)
        .map(|t| t.with_timezone(&Local).date_naive() == today)
        .unwrap_or(false)
}

fn modified_today(path: &Path, midnight: SystemTime) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| t >= midnight)
        .unwrap_or(false)
}

fn collect_jsonl(dir: &Path, midnight: SystemTime, depth: u32, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for ent in rd.flatten() {
        let p = ent.path();
        let Ok(ft) = ent.file_type() else { continue };
        if ft.is_dir() {
            collect_jsonl(&p, midnight, depth - 1, out);
        } else if p.extension().and_then(|e| e.to_str()) == Some("jsonl") && modified_today(&p, midnight) {
            out.push(p);
        }
    }
}

fn u(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

fn parse_claude_line(line: &str, today: NaiveDate) -> Option<Entry> {
    if !line.contains("\"usage\"") {
        return None;
    }
    let o: Value = serde_json::from_str(line).ok()?;
    if o.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    if !is_today(o.get("timestamp")?.as_str()?, today) {
        return None;
    }
    let msg = o.get("message")?;
    let usage = msg.get("usage")?;
    let model = msg.get("model").and_then(Value::as_str).unwrap_or("").to_string();
    if model == "<synthetic>" {
        return None;
    }
    let id = msg.get("id").and_then(Value::as_str).unwrap_or("");
    let req = o.get("requestId").and_then(Value::as_str).unwrap_or("");
    let key = if id.is_empty() && req.is_empty() {
        o.get("uuid").and_then(Value::as_str).unwrap_or("").to_string()
    } else {
        format!("{id}|{req}")
    };
    let cw_total = u(usage, "cache_creation_input_tokens");
    let (cw5, cw1) = match usage.get("cache_creation") {
        Some(c) => (u(c, "ephemeral_5m_input_tokens"), u(c, "ephemeral_1h_input_tokens")),
        None => (cw_total, 0),
    };
    let (cw5, cw1) = if cw5 + cw1 == 0 { (cw_total, 0) } else { (cw5, cw1) };
    Some(Entry {
        key,
        model,
        input: u(usage, "input_tokens"),
        output: u(usage, "output_tokens"),
        cache_read: u(usage, "cache_read_input_tokens"),
        cache_write_5m: cw5,
        cache_write_1h: cw1,
    })
}

fn parse_codex_line(line: &str, today: NaiveDate, st: &mut FileState) -> Option<Entry> {
    if !line.contains("token_count") {
        return None;
    }
    let o: Value = serde_json::from_str(line).ok()?;
    let p = o.get("payload")?;
    if p.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }
    let info = p.get("info")?;
    let total = info.get("total_token_usage").map(|t| u(t, "total_tokens")).unwrap_or(0);
    if total != 0 && total == st.last_total {
        return None; // repeated event, nothing new
    }
    st.last_total = total;
    if !is_today(o.get("timestamp")?.as_str()?, today) {
        return None;
    }
    let last = info.get("last_token_usage")?;
    let input = u(last, "input_tokens");
    let cached = u(last, "cached_input_tokens");
    Some(Entry {
        key: String::new(),
        model: String::new(),
        input: input.saturating_sub(cached),
        output: u(last, "output_tokens"),
        cache_read: cached,
        cache_write_5m: u(last, "cache_write_input_tokens"),
        cache_write_1h: 0,
    })
}

fn read_new_lines(path: &Path, st: &mut FileState, mut f: impl FnMut(&str, &mut FileState) -> Option<Entry>) {
    let Ok(file) = File::open(path) else { return };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len < st.offset {
        *st = FileState::default(); // truncated / rewritten
    }
    let mut reader = BufReader::new(file);
    if reader.seek(SeekFrom::Start(st.offset)).is_err() {
        return;
    }
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if buf.last() != Some(&b'\n') {
                    break; // partial line still being written; retry next time
                }
                st.offset += n as u64;
                if let Ok(line) = std::str::from_utf8(&buf) {
                    if let Some(e) = f(line, st) {
                        st.entries.push(e);
                    }
                }
            }
        }
    }
}

/// Today's usage for every source. Blocking (file IO) — call from a blocking task.
pub fn compute(sources: &[Source]) -> Vec<UsageToday> {
    let now = Local::now();
    let today = now.date_naive();
    let midnight: SystemTime = Local
        .from_local_datetime(&today.and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .map(SystemTime::from)
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let Ok(mut sc) = scanner().lock() else { return Vec::new() };
    if sc.day != Some(today) {
        sc.files.clear();
        sc.day = Some(today);
    }

    let mut out = Vec::new();
    for src in sources {
        match src {
            Source::Claude { account_id, config_dir } => {
                let mut files = Vec::new();
                collect_jsonl(&config_dir.join("projects"), midnight, 6, &mut files);
                let mut seen: HashSet<String> = HashSet::new();
                let mut acc = UsageToday { account_id: account_id.clone(), cost_usd: Some(0.0), ..Default::default() };
                for p in files {
                    let st = sc.files.entry(p.clone()).or_default();
                    read_new_lines(&p, st, |l, _| parse_claude_line(l, today));
                    for e in &st.entries {
                        if !e.key.is_empty() && !seen.insert(e.key.clone()) {
                            continue;
                        }
                        add(&mut acc, e);
                        *acc.cost_usd.as_mut().unwrap() += entry_cost(e);
                    }
                }
                out.push(acc);
            }
            Source::Codex { account_id, codex_home } => {
                let mut files = Vec::new();
                for d in [today, today.pred_opt().unwrap_or(today)] {
                    let dir = codex_home
                        .join("sessions")
                        .join(d.format("%Y").to_string())
                        .join(d.format("%m").to_string())
                        .join(d.format("%d").to_string());
                    collect_jsonl(&dir, midnight, 1, &mut files);
                }
                let mut acc = UsageToday { account_id: account_id.clone(), ..Default::default() };
                for p in files {
                    let st = sc.files.entry(p.clone()).or_default();
                    read_new_lines(&p, st, |l, s| parse_codex_line(l, today, s));
                    for e in &st.entries {
                        add(&mut acc, e);
                    }
                }
                out.push(acc);
            }
        }
    }
    out
}

fn add(acc: &mut UsageToday, e: &Entry) {
    acc.input_tokens += e.input;
    acc.output_tokens += e.output;
    acc.cache_read_tokens += e.cache_read;
    acc.cache_write_tokens += e.cache_write_5m + e.cache_write_1h;
    acc.total_tokens += e.input + e.output + e.cache_read + e.cache_write_5m + e.cache_write_1h;
    acc.requests += 1;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_line_parses_and_prices() {
        let today = Local::now().date_naive();
        let ts = Local::now().to_rfc3339();
        let line = format!(
            r#"{{"type":"assistant","timestamp":"{ts}","requestId":"r1","message":{{"id":"m1","model":"claude-opus-5-5","usage":{{"input_tokens":1000000,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#
        );
        let e = parse_claude_line(&line, today).unwrap();
        assert_eq!(e.key, "m1|r1");
        assert!((entry_cost(&e) - 4.0).abs() < 1e-9);
    }

    #[test]
    fn codex_skips_repeated_totals() {
        let today = Local::now().date_naive();
        let ts = Local::now().to_rfc3339();
        let line = format!(
            r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"total_tokens":150}},"last_token_usage":{{"input_tokens":100,"cached_input_tokens":40,"output_tokens":50}}}}}}}}"#
        );
        let mut st = FileState::default();
        let e = parse_codex_line(&line, today, &mut st).unwrap();
        assert_eq!((e.input, e.cache_read, e.output), (60, 40, 50));
        assert!(parse_codex_line(&line, today, &mut st).is_none());
    }
}
