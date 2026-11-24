//! Token usage ledger, read from the local CLI logs (read-only):
//!
//! * Claude Code: `<config dir>/projects/**/*.jsonl`, assistant messages with
//!   `message.usage`; deduplicated by `message.id + requestId` (streamed messages
//!   are written more than once, resumed sessions copy earlier turns).
//! * Antigravity: `<acp dir>/brain/*/.system_generated/logs/transcript.jsonl`,
//!   model response lines carrying `input_tokens` / `output_tokens` / `cache_read_tokens`.
//! * Codex: `<codex home>/sessions/YYYY/MM/DD/*.jsonl`, `token_count` events
//!   (`last_token_usage`); the model comes from the preceding `turn_context`.
//!
//! Usage is summed into hourly buckets per (account, model) and kept for
//! `KEEP_DAYS`, persisted to `%APPDATA%\t3-deskcat\usage-ledger.json` together
//! with how far each log file was read. Logs are append-only, so a refresh only
//! parses newly appended lines; the first run backfills older files on a
//! background thread so the dashboard is not held up.
//!
//! Cost is the equivalent API list price (see `price`), overridable per model in
//! the settings.

use chrono::{DateTime, Local, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, SystemTime};

const KEEP_DAYS: i64 = 92;
const HOUR: i64 = 3600;

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
    /// Equivalent API cost in USD (None when no model used today has a price).
    pub cost_usd: Option<f64>,
}

#[derive(Clone)]
pub enum Source {
    Claude { account_id: String, config_dir: PathBuf },
    Codex { account_id: String, codex_home: PathBuf },
    Antigravity { account_id: String, brain_dir: PathBuf },
}

impl Source {
    fn account(&self) -> &str {
        match self {
            Source::Claude { account_id, .. }
            | Source::Codex { account_id, .. }
            | Source::Antigravity { account_id, .. } => account_id,
        }
    }
}

/// Tokens of one kind of work, summed.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct Agg {
    #[serde(rename = "i")]
    pub input: u64,
    #[serde(rename = "o")]
    pub output: u64,
    #[serde(rename = "r")]
    pub cache_read: u64,
    #[serde(rename = "w")]
    pub cache_write_5m: u64,
    #[serde(rename = "W", default)]
    pub cache_write_1h: u64,
    #[serde(rename = "n")]
    pub requests: u64,
}

impl Agg {
    fn add(&mut self, o: &Agg) {
        self.input += o.input;
        self.output += o.output;
        self.cache_read += o.cache_read;
        self.cache_write_5m += o.cache_write_5m;
        self.cache_write_1h += o.cache_write_1h;
        self.requests += o.requests;
    }
    pub fn total(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write_5m + self.cache_write_1h
    }
}

/// USD per million tokens.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    /// 5-minute cache write; the 1-hour write is billed at 2x input.
    pub cache_write: f64,
}

impl Price {
    const fn claude(i: f64, o: f64, r: f64) -> Self {
        Price { input: i, output: o, cache_read: r, cache_write: i * 1.25 }
    }
    const fn openai(i: f64, o: f64, r: f64) -> Self {
        Price { input: i, output: o, cache_read: r, cache_write: i }
    }
    const fn gemini(i: f64, o: f64, r: f64) -> Self {
        Price { input: i, output: o, cache_read: r, cache_write: i }
    }
}

/// Built-in list prices, matched by substring (first match wins).
const PRICES: &[(&str, Price)] = &[
    ("fable-5-2", Price::claude(8.0, 40.0, 0.20)),
    ("mythos-5-2", Price::claude(8.0, 40.0, 0.20)),
    ("fable-5", Price::claude(10.0, 50.0, 1.0)),
    ("mythos", Price::claude(10.0, 50.0, 1.0)),
    ("opus-5-5", Price::claude(4.0, 20.0, 0.20)),
    ("opus-5", Price::claude(5.0, 25.0, 0.50)),
    ("opus-4-8", Price::claude(5.0, 25.0, 0.50)),
    ("opus-4-7", Price::claude(5.0, 25.0, 0.50)),
    ("opus-4-6", Price::claude(5.0, 25.0, 0.50)),
    ("opus-4-5", Price::claude(5.0, 25.0, 0.50)),
    ("opus", Price::claude(15.0, 75.0, 1.50)),
    ("sonnet-5-5", Price::claude(2.0, 10.0, 0.10)),
    ("sonnet-5", Price::claude(2.0, 10.0, 0.20)),
    ("sonnet", Price::claude(3.0, 15.0, 0.30)),
    ("haiku-5-5", Price::claude(0.10, 0.50, 0.01)),
    ("haiku-4-5", Price::claude(1.0, 5.0, 0.10)),
    ("haiku", Price::claude(0.80, 4.0, 0.08)),
    // Gemini / Antigravity list prices (USD per million tokens)
    ("gemini-4-neon", Price::gemini(3.0, 15.0, 0.15)),
    ("orchestrator-neon", Price::gemini(3.0, 15.0, 0.15)),
    ("gemini-4-argon", Price::gemini(2.0, 10.0, 0.10)),
    ("orchestrator-argon", Price::gemini(2.0, 10.0, 0.10)),
    ("gemini-4-carbon", Price::gemini(2.0, 10.0, 0.10)),
    ("gemini-4-hydrogen", Price::gemini(1.5, 7.5, 0.075)),
    ("gemini-3.8-flash", Price::gemini(0.75, 3.75, 0.075)),
    ("gemini-3-pro", Price::gemini(2.0, 12.0, 0.20)),
    ("gemini-3-flash", Price::gemini(0.50, 3.0, 0.05)),
    ("gemini-2.5-pro", Price::gemini(1.25, 10.0, 0.125)),
    ("gemini-2.5-flash-lite", Price::gemini(0.10, 0.40, 0.01)),
    ("gemini-2.5-flash", Price::gemini(0.30, 2.50, 0.03)),
    // developers.openai.com/api/docs/models/gpt-5.6-terra (2026-11-20)
    ("gpt-5.6-terra", Price::openai(2.0, 12.0, 0.20)),
];

fn overrides() -> &'static RwLock<HashMap<String, Price>> {
    static O: OnceLock<RwLock<HashMap<String, Price>>> = OnceLock::new();
    O.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Per-model prices set by the user (exact model id, lower case).
pub fn set_price_overrides(map: &HashMap<String, Price>) {
    if let Ok(mut o) = overrides().write() {
        *o = map.iter().map(|(k, v)| (k.to_ascii_lowercase(), *v)).collect();
    }
}

/// The price used for a model, and whether it is the user's own.
pub fn price_of(model: &str) -> Option<(Price, bool)> {
    let m = model.to_ascii_lowercase();
    if let Some(p) = overrides().read().ok().and_then(|o| o.get(&m).copied()) {
        return Some((p, true));
    }
    if m.is_empty() {
        return None;
    }
    if m.contains("claude") || ["opus", "sonnet", "haiku", "fable", "mythos"].iter().any(|k| m.contains(k)) {
        return PRICES.iter().find(|(k, _)| m.contains(k)).map(|(_, p)| (*p, false)).or(Some((Price::claude(4.0, 20.0, 0.20), false)));
    }
    PRICES.iter().find(|(k, _)| m.contains(k)).map(|(_, p)| (*p, false))
}

/// Cost split by token type, USD.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cost {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    /// What the cache reads would have cost as plain input.
    pub cache_savings: f64,
}

pub fn cost_of(model: &str, a: &Agg) -> Option<Cost> {
    let (p, _) = price_of(model)?;
    let m = 1_000_000.0;
    Some(Cost {
        input: a.input as f64 * p.input / m,
        output: a.output as f64 * p.output / m,
        cache_read: a.cache_read as f64 * p.cache_read / m,
        cache_write: (a.cache_write_5m as f64 * p.cache_write + a.cache_write_1h as f64 * p.input * 2.0) / m,
        cache_savings: a.cache_read as f64 * (p.input - p.cache_read).max(0.0) / m,
    })
}

// ---------------------------------------------------------------------------

#[derive(Default, Clone, Serialize, Deserialize)]
struct FileState {
    #[serde(rename = "a")]
    account: String,
    #[serde(rename = "o")]
    offset: u64,
    /// Codex: last cumulative total, to skip repeated token_count events.
    #[serde(rename = "t", default)]
    last_total: u64,
    /// Codex: model of the current turn.
    #[serde(rename = "m", default)]
    model: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Ledger {
    #[serde(default)]
    version: u32,
    /// "account\u{1f}hour\u{1f}model" -> tokens
    #[serde(default)]
    buckets: HashMap<String, Agg>,
    #[serde(default)]
    files: HashMap<String, FileState>,
    /// Claude message-key hash -> hour it was seen (for dedup across files).
    #[serde(default)]
    seen: HashMap<u64, i64>,
    #[serde(default)]
    backfilled: bool,
    #[serde(skip)]
    dirty: bool,
}

const VERSION: u32 = 1;
const SEP: char = '\u{1f}';

fn bucket_key(acc: &str, hour: i64, model: &str) -> String {
    format!("{acc}{SEP}{hour}{SEP}{model}")
}

fn split_key(k: &str) -> Option<(&str, i64, &str)> {
    let mut it = k.splitn(3, SEP);
    let a = it.next()?;
    let h = it.next()?.parse().ok()?;
    Some((a, h, it.next().unwrap_or("")))
}

fn ledger_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("t3-deskcat").join("usage-ledger.json"))
}

fn ledger() -> &'static Mutex<Ledger> {
    static L: OnceLock<Mutex<Ledger>> = OnceLock::new();
    L.get_or_init(|| {
        let loaded: Ledger = ledger_path()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .filter(|l: &Ledger| l.version == VERSION)
            .unwrap_or(Ledger { version: VERSION, ..Default::default() });
        Mutex::new(loaded)
    })
}

fn save(l: &mut Ledger) {
    if !l.dirty {
        return;
    }
    let Some(path) = ledger_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(body) = serde_json::to_string(&*l) {
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, body).is_ok() && fs::rename(&tmp, &path).is_ok() {
            l.dirty = false;
        }
    }
}

fn prune(l: &mut Ledger, now: i64) {
    let cut = now - KEEP_DAYS * 24 * HOUR;
    let before = (l.buckets.len(), l.seen.len());
    l.buckets.retain(|k, _| split_key(k).map(|(_, h, _)| h >= cut).unwrap_or(false));
    l.seen.retain(|_, h| *h >= cut);
    if before != (l.buckets.len(), l.seen.len()) {
        l.dirty = true;
    }
}

fn u(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

fn hour_of(ts: &str) -> Option<i64> {
    let t = DateTime::parse_from_rfc3339(ts).ok()?.timestamp();
    Some(t - t.rem_euclid(HOUR))
}

/// One usage record parsed from a log line.
struct Rec {
    hour: i64,
    model: String,
    agg: Agg,
    dedup: Option<u64>,
}

fn parse_claude_line(line: &str) -> Option<Rec> {
    if !line.contains("\"usage\"") {
        return None;
    }
    let o: Value = serde_json::from_str(line).ok()?;
    if o.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let hour = hour_of(o.get("timestamp")?.as_str()?)?;
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
    let dedup = (!key.is_empty()).then(|| {
        let mut h = DefaultHasher::new();
        key.hash(&mut h);
        h.finish()
    });
    let cw_total = u(usage, "cache_creation_input_tokens");
    let (cw5, cw1) = match usage.get("cache_creation") {
        Some(c) => (u(c, "ephemeral_5m_input_tokens"), u(c, "ephemeral_1h_input_tokens")),
        None => (cw_total, 0),
    };
    let (cw5, cw1) = if cw5 + cw1 == 0 { (cw_total, 0) } else { (cw5, cw1) };
    Some(Rec {
        hour,
        model,
        dedup,
        agg: Agg {
            input: u(usage, "input_tokens"),
            output: u(usage, "output_tokens"),
            cache_read: u(usage, "cache_read_input_tokens"),
            cache_write_5m: cw5,
            cache_write_1h: cw1,
            requests: 1,
        },
    })
}

fn parse_codex_line(line: &str, st: &mut FileState) -> Option<Rec> {
    if line.contains("\"turn_context\"") {
        if let Ok(o) = serde_json::from_str::<Value>(line) {
            if let Some(m) = o.pointer("/payload/model").and_then(Value::as_str) {
                st.model = m.to_string();
            }
        }
        return None;
    }
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
    let hour = hour_of(o.get("timestamp")?.as_str()?)?;
    let last = info.get("last_token_usage")?;
    let input = u(last, "input_tokens");
    let cached = u(last, "cached_input_tokens");
    Some(Rec {
        hour,
        model: st.model.clone(),
        dedup: None,
        agg: Agg {
            input: input.saturating_sub(cached),
            output: u(last, "output_tokens"),
            cache_read: cached,
            cache_write_5m: u(last, "cache_write_input_tokens"),
            cache_write_1h: 0,
            requests: 1,
        },
    })
}

fn parse_antigravity_line(line: &str, st: &mut FileState) -> Option<Rec> {
    if !line.contains("\"input_tokens\"") && !line.contains("\"output_tokens\"") {
        return None;
    }
    let o: Value = serde_json::from_str(line).ok()?;
    if let Some(m) = o.get("model").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        st.model = m.to_string();
    }
    let input = u(&o, "input_tokens");
    let output = u(&o, "output_tokens");
    let cache_read = u(&o, "cache_read_tokens");
    let cache_write = u(&o, "cache_write_tokens");
    if input + output + cache_read + cache_write == 0 {
        return None;
    }
    let hour = hour_of(o.get("created_at")?.as_str()?)?;
    let model = o
        .get("model")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| st.model.clone());
    Some(Rec {
        hour,
        model,
        dedup: None,
        agg: Agg {
            input,
            output,
            cache_read,
            cache_write_5m: cache_write,
            cache_write_1h: 0,
            requests: 1,
        },
    })
}

fn collect_antigravity_transcripts(brain_dir: &Path, since: SystemTime, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(brain_dir) else { return };
    for ent in rd.flatten() {
        let Ok(ft) = ent.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let p = ent.path().join(".system_generated").join("logs").join("transcript.jsonl");
        let fresh = fs::metadata(&p)
            .and_then(|m| m.modified())
            .map(|t| t >= since)
            .unwrap_or(false);
        if fresh {
            out.push(p);
        }
    }
}

fn collect_jsonl(dir: &Path, since: SystemTime, depth: u32, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for ent in rd.flatten() {
        let p = ent.path();
        let Ok(ft) = ent.file_type() else { continue };
        if ft.is_dir() {
            collect_jsonl(&p, since, depth - 1, out);
        } else if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            let fresh = ent.metadata().and_then(|m| m.modified()).map(|t| t >= since).unwrap_or(false);
            if fresh {
                out.push(p);
            }
        }
    }
}

fn files_of(src: &Source, since: SystemTime) -> Vec<PathBuf> {
    let mut files = Vec::new();
    match src {
        Source::Claude { config_dir, .. } => collect_jsonl(&config_dir.join("projects"), since, 6, &mut files),
        Source::Codex { codex_home, .. } => collect_jsonl(&codex_home.join("sessions"), since, 4, &mut files),
        Source::Antigravity { brain_dir, .. } => collect_antigravity_transcripts(brain_dir, since, &mut files),
    }
    files
}

/// Reads what was appended to `path` since last time and adds it to the ledger.
/// The file is read without holding the ledger lock.
fn scan_file(src: &Source, path: &Path) {
    let key = path.to_string_lossy().to_string();
    let acc = src.account().to_string();
    let len = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let start = {
        let Ok(l) = ledger().lock() else { return };
        match l.files.get(&key) {
            Some(st) if st.account == acc && st.offset == len => return, // nothing new
            Some(st) if st.account == acc && st.offset < len => st.clone(),
            _ => FileState { account: acc.clone(), ..Default::default() }, // new, rewritten or moved
        }
    };
    let Ok(file) = File::open(path) else { return };
    let mut reader = BufReader::new(file);
    if reader.seek(SeekFrom::Start(start.offset)).is_err() {
        return;
    }
    let mut st = start.clone();
    let mut recs = Vec::new();
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
                    let rec = match src {
                        Source::Claude { .. } => parse_claude_line(line),
                        Source::Codex { .. } => parse_codex_line(line, &mut st),
                        Source::Antigravity { .. } => parse_antigravity_line(line, &mut st),
                    };
                    if let Some(r) = rec {
                        recs.push(r);
                    }
                }
            }
        }
    }
    let cut = Local::now().timestamp() - KEEP_DAYS * 24 * HOUR;
    let Ok(mut l) = ledger().lock() else { return };
    // Another scan got here first: drop ours.
    let current = l.files.get(&key).map(|s| s.offset);
    if current.is_some_and(|o| o != start.offset) {
        return;
    }
    for r in recs {
        if r.hour < cut {
            continue;
        }
        if let Some(h) = r.dedup {
            // Per account: the same log re-attributed to another account counts there.
            let mut hs = DefaultHasher::new();
            (h, acc.as_str()).hash(&mut hs);
            if l.seen.insert(hs.finish(), r.hour).is_some() {
                continue;
            }
        }
        l.buckets.entry(bucket_key(&acc, r.hour, &r.model)).or_default().add(&r.agg);
    }
    l.files.insert(key, st);
    l.dirty = true;
}

static BACKFILLING: AtomicBool = AtomicBool::new(false);

fn backfill(sources: Vec<Source>) {
    if BACKFILLING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let since = SystemTime::now() - Duration::from_secs((KEEP_DAYS * 24 * HOUR) as u64);
        for src in &sources {
            for p in files_of(src, since) {
                scan_file(src, &p);
            }
        }
        if let Ok(mut l) = ledger().lock() {
            l.backfilled = true;
            l.dirty = true;
            prune(&mut l, Local::now().timestamp());
            save(&mut l);
        }
        BACKFILLING.store(false, Ordering::SeqCst);
    });
}

fn known() -> &'static Mutex<Vec<String>> {
    static K: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    K.get_or_init(|| Mutex::new(Vec::new()))
}

/// Scans recent logs and returns today's usage per source. Blocking (file IO).
/// The first time (or when an account appears) it also starts a background
/// backfill of the last `KEEP_DAYS` days.
pub fn compute(sources: &[Source]) -> Vec<UsageToday> {
    let now = Local::now();
    let midnight_ts = Local
        .from_local_datetime(&now.date_naive().and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .map(|t| t.timestamp())
        .unwrap_or(0);
    // Files touched in the last two days cover anything that can still change.
    let since = SystemTime::now() - Duration::from_secs(2 * 24 * HOUR as u64);
    for src in sources {
        for p in files_of(src, since) {
            scan_file(src, &p);
        }
    }

    let ids: Vec<String> = sources.iter().map(|s| s.account().to_string()).collect();
    let new_account = known().lock().map(|mut k| {
        let fresh = ids.iter().any(|i| !k.contains(i));
        *k = ids.clone();
        fresh
    });
    let need_backfill = ledger().lock().map(|l| !l.backfilled).unwrap_or(false);
    if need_backfill || new_account.unwrap_or(false) {
        backfill(sources.to_vec());
    }

    let Ok(mut l) = ledger().lock() else { return Vec::new() };
    prune(&mut l, now.timestamp());
    if !BACKFILLING.load(Ordering::SeqCst) {
        save(&mut l);
    }
    let mut out: HashMap<String, UsageToday> = HashMap::new();
    for (k, a) in &l.buckets {
        let Some((acc, h, model)) = split_key(k) else { continue };
        if h + HOUR <= midnight_ts || !ids.iter().any(|i| i == acc) {
            continue;
        }
        let t = out.entry(acc.to_string()).or_insert_with(|| UsageToday { account_id: acc.to_string(), ..Default::default() });
        t.input_tokens += a.input;
        t.output_tokens += a.output;
        t.cache_read_tokens += a.cache_read;
        t.cache_write_tokens += a.cache_write_5m + a.cache_write_1h;
        t.total_tokens += a.total();
        t.requests += a.requests;
        if let Some(c) = cost_of(model, a) {
            *t.cost_usd.get_or_insert(0.0) += c.input + c.output + c.cache_read + c.cache_write;
        }
    }
    ids.into_iter().map(|i| out.remove(&i).unwrap_or(UsageToday { account_id: i, ..Default::default() })).collect()
}

// ---------------------------------------------------------------------------
// Report for the analytics view.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRow {
    /// Start of the slot (unix seconds): an hour for "day", a local day otherwise.
    pub t: i64,
    pub account_id: String,
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub requests: u64,
    pub cost: Option<Cost>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    pub model: String,
    pub price: Option<Price>,
    pub custom: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub period: String,
    pub from: i64,
    pub to: i64,
    /// "hour" or "day"
    pub slot: String,
    pub rows: Vec<ReportRow>,
    pub models: Vec<ModelPrice>,
    /// Still reading older logs: totals may grow.
    pub backfilling: bool,
}

fn local_day_start(ts: i64) -> i64 {
    let d = Local.timestamp_opt(ts, 0).single().unwrap_or_else(Local::now);
    Local
        .from_local_datetime(&d.date_naive().and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .map(|t| t.timestamp())
        .unwrap_or(ts - ts.rem_euclid(24 * HOUR))
}

/// period: "day" (24 h, hourly), "week" (7 d), "month" (30 d), "quarter" (90 d).
pub fn report(period: &str) -> UsageReport {
    let now = Local::now();
    let now_ts = now.timestamp();
    let (from, slot) = match period {
        "day" => {
            let cur = now_ts - (now.minute() as i64 * 60 + now.second() as i64);
            (cur - 23 * HOUR, "hour")
        }
        "month" => (local_day_start(now_ts - 29 * 24 * HOUR), "day"),
        "quarter" => (local_day_start(now_ts - 89 * 24 * HOUR), "day"),
        _ => (local_day_start(now_ts - 6 * 24 * HOUR), "day"),
    };
    let mut agg: HashMap<(i64, String, String), Agg> = HashMap::new();
    let mut models: Vec<String> = Vec::new();
    let ids = known().lock().map(|k| k.clone()).unwrap_or_default();
    if let Ok(l) = ledger().lock() {
        for (k, a) in &l.buckets {
            let Some((acc, h, model)) = split_key(k) else { continue };
            if h < from || (!ids.is_empty() && !ids.iter().any(|i| i == acc)) {
                continue;
            }
            let t = if slot == "hour" { h } else { local_day_start(h) };
            agg.entry((t, acc.to_string(), model.to_string())).or_default().add(a);
            if !models.iter().any(|m| m == model) {
                models.push(model.to_string());
            }
        }
    }
    let mut rows: Vec<ReportRow> = agg
        .into_iter()
        .map(|((t, account_id, model), a)| ReportRow {
            t,
            cost: cost_of(&model, &a),
            account_id,
            model,
            input: a.input,
            output: a.output,
            cache_read: a.cache_read,
            cache_write: a.cache_write_5m + a.cache_write_1h,
            requests: a.requests,
        })
        .collect();
    rows.sort_by(|a, b| a.t.cmp(&b.t).then(a.account_id.cmp(&b.account_id)));
    models.sort();
    UsageReport {
        period: period.to_string(),
        from,
        to: now_ts,
        slot: slot.to_string(),
        rows,
        models: models
            .into_iter()
            .map(|m| {
                let p = price_of(&m);
                ModelPrice { price: p.map(|x| x.0), custom: p.map(|x| x.1).unwrap_or(false), model: m }
            })
            .collect(),
        backfilling: BACKFILLING.load(Ordering::SeqCst) || ledger().lock().map(|l| !l.backfilled).unwrap_or(true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_line_parses_and_prices() {
        let ts = Local::now().to_rfc3339();
        let line = format!(
            r#"{{"type":"assistant","timestamp":"{ts}","requestId":"r1","message":{{"id":"m1","model":"claude-opus-5-5","usage":{{"input_tokens":1000000,"output_tokens":0,"cache_read_input_tokens":1000000,"cache_creation_input_tokens":0}}}}}}"#
        );
        let r = parse_claude_line(&line).unwrap();
        assert!(r.dedup.is_some());
        let c = cost_of(&r.model, &r.agg).unwrap();
        assert!((c.input - 4.0).abs() < 1e-9);
        assert!((c.cache_read - 0.2).abs() < 1e-9);
        assert!((c.cache_savings - 3.8).abs() < 1e-9);
    }

    #[test]
    fn codex_skips_repeated_totals_and_tracks_model() {
        let ts = Local::now().to_rfc3339();
        let mut st = FileState::default();
        let ctx = r#"{"type":"turn_context","payload":{"model":"gpt-5.6-terra"}}"#;
        assert!(parse_codex_line(ctx, &mut st).is_none());
        let line = format!(
            r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"total_tokens":150}},"last_token_usage":{{"input_tokens":100,"cached_input_tokens":40,"output_tokens":50}}}}}}}}"#
        );
        let r = parse_codex_line(&line, &mut st).unwrap();
        assert_eq!((r.agg.input, r.agg.cache_read, r.agg.output), (60, 40, 50));
        assert_eq!(r.model, "gpt-5.6-terra");
        assert!(cost_of(&r.model, &r.agg).is_some());
        assert!(parse_codex_line(&line, &mut st).is_none());
    }

    #[test]
    fn antigravity_transcript_parses_and_prices() {
        let ts = Local::now().to_rfc3339();
        let mut st = FileState::default();
        let planner = format!(
            r#"{{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"{ts}","model":"gemini-4-neon-xhigh","input_tokens":3000,"cache_read_tokens":50000,"output_tokens":400}}"#
        );
        let r1 = parse_antigravity_line(&planner, &mut st).unwrap();
        assert_eq!((r1.agg.input, r1.agg.cache_read, r1.agg.output, r1.agg.requests), (3000, 50000, 400, 1));
        assert_eq!(r1.model, "gemini-4-neon-xhigh");
        assert!(cost_of(&r1.model, &r1.agg).is_some());

        // CHECKPOINT omits model and should inherit the preceding planner model.
        let checkpoint = format!(
            r#"{{"step_index":2,"source":"SYSTEM","type":"CHECKPOINT","status":"DONE","created_at":"{ts}","model":null,"input_tokens":1000,"cache_read_tokens":20000,"output_tokens":500}}"#
        );
        let r2 = parse_antigravity_line(&checkpoint, &mut st).unwrap();
        assert_eq!(r2.model, "gemini-4-neon-xhigh");
        assert_eq!((r2.agg.input, r2.agg.cache_read, r2.agg.output), (1000, 20000, 500));

        // GENERIC tool output mentioning "input_tokens" in content without numeric fields is skipped.
        let generic = format!(
            r#"{{"step_index":3,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"{ts}","content":"\"input_tokens\": 123"}}"#
        );
        assert!(parse_antigravity_line(&generic, &mut st).is_none());
    }

    static OVERRIDE_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn unknown_model_has_no_price_until_overridden() {
        let _guard = OVERRIDE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        assert!(price_of("some-new-model").is_none());
        let mut m = HashMap::new();
        m.insert("Some-New-Model".to_string(), Price { input: 1.0, output: 2.0, cache_read: 0.1, cache_write: 1.0 });
        set_price_overrides(&m);
        assert_eq!(price_of("some-new-model").map(|p| p.1), Some(true));
        set_price_overrides(&HashMap::new());
    }

    #[test]
    fn cost_includes_1h_cache_write_and_custom_override() {
        let _guard = OVERRIDE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let agg = Agg {
            input: 1_000_000,
            output: 500_000,
            cache_read: 2_000_000,
            cache_write_5m: 1_000_000,
            cache_write_1h: 1_000_000,
            requests: 1,
        };
        let mut m = HashMap::new();
        m.insert(
            "custom-test-model".to_string(),
            Price { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
        );
        set_price_overrides(&m);
        let c = cost_of("custom-test-model", &agg).unwrap();
        assert!((c.input - 3.0).abs() < 1e-9);
        assert!((c.output - 7.5).abs() < 1e-9);
        assert!((c.cache_read - 0.6).abs() < 1e-9);
        // 5m (3.75) + 1h (2 * input = 6.0)
        assert!((c.cache_write - 9.75).abs() < 1e-9);
        // 2M * (3.0 - 0.3) = 5.4
        assert!((c.cache_savings - 5.4).abs() < 1e-9);
        set_price_overrides(&HashMap::new());
    }

    #[test]
    fn bucket_keys_round_trip() {
        let k = bucket_key("claude:a b", 1_800_000_000, "claude-opus-5-5");
        assert_eq!(split_key(&k), Some(("claude:a b", 1_800_000_000, "claude-opus-5-5")));
    }
}

#[cfg(test)]
mod real_logs {
    use super::*;
    #[test]
    #[ignore]
    fn backfill_real_logs() {
        let home = dirs::home_dir().unwrap();
        let srcs = vec![
            Source::Claude { account_id: "claude:main".into(), config_dir: home.join(".claude") },
            Source::Codex { account_id: "codex:main".into(), codex_home: home.join(".codex") },
        ];
        let t0 = std::time::Instant::now();
        let today = compute(&srcs);
        eprintln!("today scan {:?}: {:?}", t0.elapsed(), today.iter().map(|u| (u.account_id.clone(), u.total_tokens, u.cost_usd)).collect::<Vec<_>>());
        while BACKFILLING.load(Ordering::SeqCst) { std::thread::sleep(Duration::from_millis(200)); }
        eprintln!("backfill done {:?}", t0.elapsed());
        for p in ["day", "week", "month", "quarter"] {
            let r = report(p);
            let tok: u64 = r.rows.iter().map(|x| x.input + x.output + x.cache_read + x.cache_write).sum();
            let cost: f64 = r.rows.iter().filter_map(|x| x.cost).map(|c| c.input + c.output + c.cache_read + c.cache_write).sum();
            eprintln!("{p}: rows {} tokens {} cost {:.2} models {:?}", r.rows.len(), tok, cost, r.models.iter().map(|m| (&m.model, m.price.is_some())).collect::<Vec<_>>());
        }
        let sz = fs::metadata(ledger_path().unwrap()).map(|m| m.len()).unwrap_or(0);
        eprintln!("ledger file {} KB", sz / 1024);
    }
}
