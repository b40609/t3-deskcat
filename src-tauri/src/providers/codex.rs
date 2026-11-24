use crate::models::{AccountQuota, ProviderKind, QuotaWindow};
use crate::providers::{parse_retry_after, FetchOutcome};
use chrono::{DateTime, Local, Utc};
use reqwest::Client;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const LOG_TAIL_BYTES: u64 = 64 * 1024;

/// Strictly read-only quota fetcher for Codex / ChatGPT subscription credentials.
pub async fn fetch_codex_quota(
    client: &Client,
    id: String,
    name: String,
    auth_path: &Path,
) -> FetchOutcome {
    fetch_codex_quota_at(client, id, name, auth_path, CODEX_USAGE_URL).await
}

async fn fetch_codex_quota_at(
    client: &Client,
    id: String,
    name: String,
    auth_path: &Path,
    usage_url: &str,
) -> FetchOutcome {
    let now = Utc::now().timestamp();

    let raw = match fs::read_to_string(auth_path) {
        Ok(s) => s,
        Err(err) => {
            return FetchOutcome::local(error_account(
                id,
                name,
                now,
                "error",
                crate::tr!("無法讀取認證: {err}", err = err),
            ));
        }
    };

    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(err) => {
            return FetchOutcome::local(error_account(
                id,
                name,
                now,
                "error",
                crate::tr!("認證 JSON 錯誤: {err}", err = err),
            ));
        }
    };

    let Some(tokens) = parsed.get("tokens") else {
        return FetchOutcome::local(error_account(
            id,
            name,
            now,
            "expired",
            crate::tr!("尚未登入 Codex / ChatGPT"),
        ));
    };

    let access_token = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if access_token.is_empty() {
        return FetchOutcome::local(error_account(
            id,
            name,
            now,
            "expired",
            crate::tr!("缺少 Access Token"),
        ));
    }

    if jwt_expired(access_token, now) {
        return FetchOutcome::local(error_account(
            id,
            name,
            now,
            "expired",
            crate::tr!("授權已過期，請在 Codex 重新登入"),
        ));
    }

    let account_id = tokens
        .get("account_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut req = client
        .get(usage_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {access_token}"))
        .header(
            reqwest::header::USER_AGENT,
            concat!("t3-deskcat/", env!("CARGO_PKG_VERSION")),
        );

    if let Some(acc_id) = account_id {
        req = req.header("ChatGPT-Account-Id", acc_id);
    }

    let response = match req.send().await {
        Ok(r) => r,
        Err(err) => {
            return FetchOutcome::network(error_account(
                id,
                name,
                now,
                "error",
                crate::tr!("連線失敗: {err}", err = err),
            ));
        }
    };

    let status = response.status().as_u16();
    let retry_after = parse_retry_after(response.headers(), now);

    if status == 401 || status == 403 {
        return FetchOutcome::network(error_account(
            id,
            name,
            now,
            "expired",
            crate::tr!("授權已過期，請在 Codex 重新登入"),
        ));
    }
    if status == 429 || status == 503 {
        return FetchOutcome::rate_limited(
            error_account(id, name, now, "cooldown", format!("HTTP {status}")),
            retry_after,
        );
    }
    if !response.status().is_success() {
        return FetchOutcome::network(error_account(
            id,
            name,
            now,
            "error",
            format!("HTTP {status}"),
        ));
    }

    let body: Value = match response.json().await {
        Ok(v) => v,
        Err(err) => {
            return FetchOutcome::network(error_account(
                id,
                name,
                now,
                "error",
                crate::tr!("解析回應失敗: {err}", err = err),
            ));
        }
    };

    let plan = body
        .get("plan_type")
        .and_then(Value::as_str)
        .map(format_plan);

    let rate_limit = body.get("rate_limit");
    let mut windows = Vec::new();
    if let Some(w) = parse_window(
        rate_limit.and_then(|r| r.get("primary_window")),
        "5h",
        now,
    ) {
        windows.push(w);
    }
    if let Some(w) = parse_window(
        rate_limit.and_then(|r| r.get("secondary_window")),
        "Wk",
        now,
    ) {
        windows.push(w);
    }

    let effective = windows
        .iter()
        .map(|w| w.remaining_percent)
        .min()
        .unwrap_or(0);

    FetchOutcome::network(AccountQuota {
        id,
        provider: ProviderKind::Codex,
        name,
        plan,
        effective_remaining: effective,
        primary_windows: windows,
        extra_windows: Vec::new(),
        status: "ok".to_string(),
        error: None,
        updated_at: now,
    })
}

/// Reads the freshest `rate_limits` block directly from Codex's local session `.jsonl`
/// rollout logs (zero network requests). Returns `Some(quota)` only when a record newer
/// than `min_timestamp` is found.
pub fn read_local_codex_quota(
    id: &str,
    name: &str,
    codex_home: &Path,
    min_timestamp: i64,
    now: i64,
) -> Option<AccountQuota> {
    let today = Local::now().date_naive();
    let mut candidates: Vec<(SystemTime, PathBuf)> = Vec::new();
    for d in [today, today.pred_opt().unwrap_or(today)] {
        let dir = codex_home
            .join("sessions")
            .join(d.format("%Y").to_string())
            .join(d.format("%m").to_string())
            .join(d.format("%d").to_string());
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for ent in rd.flatten() {
            let p = ent.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Ok(mtime) = ent.metadata().and_then(|m| m.modified()) {
                candidates.push((mtime, p));
            }
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));

    let mut best: Option<AccountQuota> = None;
    for (_, path) in candidates.into_iter().take(3) {
        let tail = read_tail(&path, LOG_TAIL_BYTES);
        if let Some(q) = parse_local_rate_limits(id, name, &tail, now) {
            if q.updated_at > min_timestamp
                && best.as_ref().is_none_or(|b| q.updated_at > b.updated_at)
            {
                best = Some(q);
            }
        }
    }
    best
}

fn read_tail(path: &Path, max_bytes: u64) -> String {
    let Ok(mut f) = File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(max_bytes);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let s = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        s.split_once('\n').map(|(_, r)| r.to_string()).unwrap_or_default()
    } else {
        s
    }
}

fn parse_local_rate_limits(id: &str, name: &str, tail: &str, now: i64) -> Option<AccountQuota> {
    for line in tail.lines().rev() {
        if !line.contains("rate_limits") || !line.contains("token_count") {
            continue;
        }
        let Ok(o) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if o.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        let Some(p) = o.get("payload") else { continue };
        if p.get("type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        let Some(rl) = p.get("rate_limits").filter(|v| v.is_object()) else {
            continue;
        };
        let ts = o
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp())
            .unwrap_or(now);

        let plan = rl.get("plan_type").and_then(Value::as_str).map(format_plan);
        let mut windows = Vec::new();
        if let Some(w) = parse_local_window(rl.get("primary"), "5h", now) {
            windows.push(w);
        }
        if let Some(w) = parse_local_window(rl.get("secondary"), "Wk", now) {
            windows.push(w);
        }
        if windows.is_empty() {
            continue;
        }
        let effective = windows.iter().map(|w| w.remaining_percent).min().unwrap_or(0);
        return Some(AccountQuota {
            id: id.to_string(),
            provider: ProviderKind::Codex,
            name: name.to_string(),
            plan,
            effective_remaining: effective,
            primary_windows: windows,
            extra_windows: Vec::new(),
            status: "ok".to_string(),
            error: None,
            updated_at: ts.min(now),
        });
    }
    None
}

fn parse_local_window(block: Option<&Value>, fallback_label: &str, now: i64) -> Option<QuotaWindow> {
    let block = block?;
    if block.is_null() {
        return None;
    }
    let used = block.get("used_percent").and_then(Value::as_f64)?;
    if !used.is_finite() {
        return None;
    }
    let remaining = (100.0 - used).round().clamp(0.0, 100.0) as i32;
    let label = block
        .get("window_minutes")
        .and_then(Value::as_i64)
        .filter(|m| *m > 0)
        .and_then(|minutes| {
            if minutes % 1440 == 0 {
                match minutes / 1440 {
                    7 => Some("Wk".to_string()),
                    30 => Some("Mo".to_string()),
                    d => Some(format!("{d}d")),
                }
            } else if minutes % 60 == 0 {
                Some(format!("{}h", minutes / 60))
            } else {
                None
            }
        })
        .unwrap_or_else(|| fallback_label.to_string());

    let reset_at = block
        .get("resets_at")
        .or_else(|| block.get("reset_at"))
        .and_then(Value::as_i64)
        .filter(|r| *r > 0);

    // If the recorded window already reset before `now`, mark full.
    let (remaining, reset_at) = match reset_at {
        Some(r) if r <= now => (100, None),
        other => (remaining, other),
    };

    Some(QuotaWindow {
        label,
        remaining_percent: remaining,
        reset_at,
    })
}

/// Checks JWT `exp` claim locally when `token` is a standard 3-part JWT.
/// Returns false for non-JWT tokens or missing `exp` so valid opaque tokens proceed.
fn jwt_expired(token: &str, now: i64) -> bool {
    let mut parts = token.split('.');
    let (Some(_), Some(payload_b64), Some(_), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let Some(bytes) = decode_base64url(payload_b64) else {
        return false;
    };
    let Ok(v) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    v.get("exp")
        .and_then(Value::as_i64)
        .is_some_and(|exp| exp > 0 && exp <= now)
}

fn decode_base64url(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for b in input.bytes() {
        let val = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => continue,
            _ => return None,
        };
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

fn parse_window(block: Option<&Value>, fallback_label: &str, now: i64) -> Option<QuotaWindow> {
    let block = block?;
    if block.is_null() {
        return None;
    }

    let used = block.get("used_percent").and_then(Value::as_f64)?;
    if !used.is_finite() {
        return None;
    }
    let remaining = (100.0 - used).round().clamp(0.0, 100.0) as i32;

    let label = block
        .get("limit_window_seconds")
        .and_then(Value::as_i64)
        .filter(|s| *s > 0)
        .and_then(|seconds| {
            let minutes = (seconds + 59) / 60;
            if minutes % 1440 == 0 {
                let days = minutes / 1440;
                match days {
                    7 => Some("Wk".to_string()),
                    30 => Some("Mo".to_string()),
                    d => Some(format!("{d}d")),
                }
            } else if minutes % 60 == 0 {
                Some(format!("{}h", minutes / 60))
            } else {
                None
            }
        })
        .unwrap_or_else(|| fallback_label.to_string());

    let reset_at = block
        .get("reset_at")
        .and_then(Value::as_i64)
        .or_else(|| {
            block
                .get("reset_after_seconds")
                .and_then(Value::as_i64)
                .filter(|s| *s >= 0)
                .map(|s| now + s)
        });

    Some(QuotaWindow {
        label,
        remaining_percent: remaining,
        reset_at,
    })
}

fn format_plan(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "free" => "Free".to_string(),
        "plus" => "Plus".to_string(),
        "pro" => "Pro".to_string(),
        "team" => "Team".to_string(),
        other => other.to_string(),
    }
}

fn error_account(
    id: String,
    name: String,
    now: i64,
    status: &str,
    msg: String,
) -> AccountQuota {
    AccountQuota {
        id,
        provider: ProviderKind::Codex,
        name,
        plan: None,
        effective_remaining: 0,
        primary_windows: Vec::new(),
        extra_windows: Vec::new(),
        status: status.to_string(),
        error: Some(msg),
        updated_at: now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "t3_deskcat_codex_{tag}_{}_{}",
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parse_window_maps_durations_clamps_and_resets() {
        let now = 1_800_000_000;
        let w5h = parse_window(
            Some(&json!({"used_percent": 31.4, "limit_window_seconds": 18000, "reset_at": now + 3600})),
            "5h",
            now,
        )
        .unwrap();
        assert_eq!(
            (w5h.label.as_str(), w5h.remaining_percent, w5h.reset_at),
            ("5h", 69, Some(now + 3600))
        );

        let wk = parse_window(
            Some(&json!({"used_percent": -15.0, "limit_window_seconds": 604800, "reset_after_seconds": 500})),
            "fallback",
            now,
        )
        .unwrap();
        assert_eq!(
            (wk.label.as_str(), wk.remaining_percent, wk.reset_at),
            ("Wk", 100, Some(now + 500))
        );

        let mo = parse_window(
            Some(&json!({"used_percent": 120.0, "limit_window_seconds": 2592000})),
            "fallback",
            now,
        )
        .unwrap();
        assert_eq!((mo.label.as_str(), mo.remaining_percent), ("Mo", 0));

        let d2 = parse_window(
            Some(&json!({"used_percent": 50.0, "limit_window_seconds": 172800})),
            "fallback",
            now,
        )
        .unwrap();
        assert_eq!(d2.label, "2d");

        assert!(parse_window(Some(&Value::Null), "5h", now).is_none());
        assert!(parse_window(None, "5h", now).is_none());
        assert!(parse_window(Some(&json!({"used_percent": "bad"})), "5h", now).is_none());
    }

    #[test]
    fn parses_local_codex_rate_limits_without_network() {
        let now = 1_795_500_000;
        let line = format!(
            r#"{{"timestamp":"2026-11-24T06:00:00Z","type":"event_msg","payload":{{"type":"token_count","rate_limits":{{"plan_type":"plus","primary":{{"used_percent":35.0,"window_minutes":300,"resets_at":{}}},"secondary":{{"used_percent":12.0,"window_minutes":10080,"resets_at":{}}}}}}}}}"#,
            now + 3600,
            now + 86400
        );
        let q = parse_local_rate_limits("codex:main", "Codex", &line, now).unwrap();
        assert_eq!(q.status, "ok");
        assert_eq!(q.plan.as_deref(), Some("Plus"));
        assert_eq!(q.effective_remaining, 65);
        assert_eq!(q.primary_windows.len(), 2);
        assert_eq!(
            (q.primary_windows[0].label.as_str(), q.primary_windows[0].remaining_percent),
            ("5h", 65)
        );
        assert_eq!(
            (q.primary_windows[1].label.as_str(), q.primary_windows[1].remaining_percent),
            ("Wk", 88)
        );
    }

    #[test]
    fn detects_expired_jwt_locally() {
        // {"exp":1000} -> base64url: eyJleHAiOjEwMDB9
        assert!(jwt_expired("aaa.eyJleHAiOjEwMDB9.ccc", 2000));
        assert!(!jwt_expired("aaa.eyJleHAiOjEwMDB9.ccc", 500));
        assert!(!jwt_expired("opaque-token", 2000));
    }

    #[test]
    fn format_plan_normalizes_known_tiers() {
        assert_eq!(format_plan(" free "), "Free");
        assert_eq!(format_plan("PLUS"), "Plus");
        assert_eq!(format_plan("pro"), "Pro");
        assert_eq!(format_plan("Team"), "Team");
        assert_eq!(format_plan("enterprise"), "enterprise");
    }

    #[tokio::test]
    async fn fetch_handles_missing_invalid_and_unauthenticated_files() {
        let dir = tmp_dir("fetch");
        let client = Client::new();

        let missing =
            fetch_codex_quota(&client, "codex:m".into(), "Codex".into(), &dir.join("missing.json")).await;
        assert_eq!(missing.quota.status, "error");
        assert!(!missing.network_hit);

        let bad_path = dir.join("bad.json");
        fs::write(&bad_path, "{bad").unwrap();
        let bad = fetch_codex_quota(&client, "codex:b".into(), "Codex".into(), &bad_path).await;
        assert_eq!(bad.quota.status, "error");
        assert!(!bad.network_hit);

        let no_tok = dir.join("no_tokens.json");
        fs::write(&no_tok, r#"{"auth_mode":"none"}"#).unwrap();
        let r1 = fetch_codex_quota(&client, "codex:n".into(), "Codex".into(), &no_tok).await;
        assert_eq!(r1.quota.status, "expired");
        assert!(!r1.network_hit);

        let empty_tok = dir.join("empty_token.json");
        fs::write(&empty_tok, r#"{"tokens":{"access_token":"  "}}"#).unwrap();
        let r2 = fetch_codex_quota(&client, "codex:e".into(), "Codex".into(), &empty_tok).await;
        assert_eq!(r2.quota.status, "expired");
        assert!(!r2.network_hit);

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn mock_http_handles_codex_429_and_retry_after() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 2048];
            let _ = s.read(&mut buf).await;
            let body = r#"{"detail":"rate limited"}"#;
            let resp = format!(
                "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 240\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = s.write_all(resp.as_bytes()).await;
        });

        let dir = tmp_dir("429");
        let auth = dir.join("auth.json");
        fs::write(&auth, r#"{"tokens":{"access_token":"opaque_valid_tok"}}"#).unwrap();
        let client = Client::new();
        let url = format!("http://{addr}/wham/usage");
        let r = fetch_codex_quota_at(&client, "codex:t".into(), "Codex".into(), &auth, &url).await;
        assert!(r.network_hit);
        assert_eq!(r.quota.status, "cooldown");
        assert_eq!(r.retry_after_secs, Some(240));
        srv.await.unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
