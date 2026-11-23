use crate::models::{AccountQuota, ProviderKind, QuotaWindow};
use chrono::Utc;
use reqwest::Client;
use serde_json::Value;
use std::fs;
use std::path::Path;

const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

/// Strictly read-only quota fetcher for Codex / ChatGPT subscription credentials.
pub async fn fetch_codex_quota(
    client: &Client,
    id: String,
    name: String,
    auth_path: &Path,
) -> AccountQuota {
    let now = Utc::now().timestamp();

    let raw = match fs::read_to_string(auth_path) {
        Ok(s) => s,
        Err(err) => {
            return error_account(id, name, now, "error", crate::tr!("無法讀取認證: {err}", err = err));
        }
    };

    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(err) => {
            return error_account(id, name, now, "error", crate::tr!("認證 JSON 錯誤: {err}", err = err));
        }
    };

    let Some(tokens) = parsed.get("tokens") else {
        return error_account(id, name, now, "expired", crate::tr!("尚未登入 Codex / ChatGPT"));
    };

    let access_token = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if access_token.is_empty() {
        return error_account(id, name, now, "expired", crate::tr!("缺少 Access Token"));
    }

    let account_id = tokens
        .get("account_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut req = client
        .get(CODEX_USAGE_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {access_token}"))
        .header(reqwest::header::USER_AGENT, "t3-deskcat");

    if let Some(acc_id) = account_id {
        req = req.header("ChatGPT-Account-Id", acc_id);
    }

    let response = match req.send().await {
        Ok(r) => r,
        Err(err) => {
            return error_account(id, name, now, "error", crate::tr!("連線失敗: {err}", err = err));
        }
    };

    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        return error_account(
            id,
            name,
            now,
            "expired",
            crate::tr!("授權已過期，請在 Codex 重新登入"),
        );
    }
    if !response.status().is_success() {
        return error_account(id, name, now, "error", format!("HTTP {status}"));
    }

    let body: Value = match response.json().await {
        Ok(v) => v,
        Err(err) => {
            return error_account(id, name, now, "error", crate::tr!("解析回應失敗: {err}", err = err));
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

    AccountQuota {
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
    }
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
        assert_eq!((w5h.label.as_str(), w5h.remaining_percent, w5h.reset_at), ("5h", 69, Some(now + 3600)));

        let wk = parse_window(
            Some(&json!({"used_percent": -15.0, "limit_window_seconds": 604800, "reset_after_seconds": 500})),
            "fallback",
            now,
        )
        .unwrap();
        assert_eq!((wk.label.as_str(), wk.remaining_percent, wk.reset_at), ("Wk", 100, Some(now + 500)));

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

        let missing = fetch_codex_quota(&client, "codex:m".into(), "Codex".into(), &dir.join("missing.json")).await;
        assert_eq!(missing.status, "error");

        let bad_path = dir.join("bad.json");
        fs::write(&bad_path, "{bad").unwrap();
        let bad = fetch_codex_quota(&client, "codex:b".into(), "Codex".into(), &bad_path).await;
        assert_eq!(bad.status, "error");

        let no_tok = dir.join("no_tokens.json");
        fs::write(&no_tok, r#"{"auth_mode":"none"}"#).unwrap();
        let r1 = fetch_codex_quota(&client, "codex:n".into(), "Codex".into(), &no_tok).await;
        assert_eq!(r1.status, "expired");

        let empty_tok = dir.join("empty_token.json");
        fs::write(&empty_tok, r#"{"tokens":{"access_token":"  "}}"#).unwrap();
        let r2 = fetch_codex_quota(&client, "codex:e".into(), "Codex".into(), &empty_tok).await;
        assert_eq!(r2.status, "expired");

        let _ = fs::remove_dir_all(&dir);
    }
}
