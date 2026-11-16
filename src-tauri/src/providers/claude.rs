use crate::models::{AccountQuota, ProviderKind, QuotaWindow};
use chrono::Utc;
use reqwest::Client;
use serde_json::Value;
use std::fs;
use std::path::Path;

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_BETA_HEADER: &str = "oauth-2025-04-20";

/// Strictly read-only quota fetcher for Claude Code OAuth credentials.
/// Never writes or rotates `.credentials.json` so active T3/Claude sessions stay untouched.
pub async fn fetch_claude_quota(
    client: &Client,
    id: String,
    name: String,
    credentials_path: &Path,
) -> AccountQuota {
    let now = Utc::now().timestamp();

    let raw_creds = match fs::read_to_string(credentials_path) {
        Ok(s) => s,
        Err(err) => {
            return error_account(id, name, now, "error", format!("無法讀取憑證: {err}"));
        }
    };

    let parsed: Value = match serde_json::from_str(&raw_creds) {
        Ok(v) => v,
        Err(err) => {
            return error_account(id, name, now, "error", format!("憑證 JSON 格式錯誤: {err}"));
        }
    };

    let Some(oauth) = parsed.get("claudeAiOauth") else {
        return error_account(id, name, now, "expired", "尚未登入 Claude Code".to_string());
    };

    let access_token = oauth
        .get("accessToken")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if access_token.is_empty() {
        return error_account(id, name, now, "expired", "缺少 Access Token".to_string());
    }

    let plan = oauth
        .get("subscriptionType")
        .and_then(Value::as_str)
        .map(format_plan);

    // Claude Code refreshes its own token when that account is used; an expired
    // one would only earn a 401, so don't spend a request on it.
    if token_expired(oauth, now) {
        return AccountQuota {
            id,
            provider: ProviderKind::Claude,
            name,
            plan,
            effective_remaining: 0,
            primary_windows: Vec::new(),
            extra_windows: Vec::new(),
            status: "expired".to_string(),
            error: Some("憑證已過期：在 T3 用一次這個帳號就會自動更新".to_string()),
            updated_at: now,
        };
    }

    let resp = client
        .get(CLAUDE_USAGE_URL)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {access_token}"))
        .header("anthropic-beta", CLAUDE_BETA_HEADER)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, "t3-deskcat")
        .send()
        .await;

    let response = match resp {
        Ok(r) => r,
        Err(err) => {
            return error_account(id, name, now, "error", format!("連線失敗: {err}"));
        }
    };

    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        return AccountQuota {
            id,
            provider: ProviderKind::Claude,
            name,
            plan,
            effective_remaining: 0,
            primary_windows: Vec::new(),
            extra_windows: Vec::new(),
            status: "expired".to_string(),
            error: Some("授權已過期，請在 T3 或終端機重新登入".to_string()),
            updated_at: now,
        };
    }

    if status == 429 {
        return AccountQuota {
            id,
            provider: ProviderKind::Claude,
            name,
            plan,
            effective_remaining: 0,
            primary_windows: Vec::new(),
            extra_windows: Vec::new(),
            status: "cooldown".to_string(),
            error: Some("429 請求頻繁冷卻中".to_string()),
            updated_at: now,
        };
    }

    if !response.status().is_success() {
        return error_account(id, name, now, "error", format!("HTTP {status}"));
    }

    let body: Value = match response.json().await {
        Ok(v) => v,
        Err(err) => {
            return error_account(id, name, now, "error", format!("解析回應失敗: {err}"));
        }
    };

    let mut windows = Vec::new();
    if let Some(w) = parse_window("5h", body.get("five_hour")) {
        windows.push(w);
    }
    if let Some(w) = parse_window("Wk", body.get("seven_day")) {
        windows.push(w);
    }

    let effective = windows
        .iter()
        .map(|w| w.remaining_percent)
        .min()
        .unwrap_or(0);

    // Model-specific weekly limits (shown like Claude's own usage page, but
    // they don't drive the overall score).
    if let Some(w) = parse_window("Wk Sonnet", body.get("seven_day_sonnet")) {
        windows.push(w);
    }
    if let Some(w) = parse_window("Wk Opus", body.get("seven_day_opus")) {
        windows.push(w);
    }

    AccountQuota {
        id,
        provider: ProviderKind::Claude,
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

fn parse_window(label: &str, block: Option<&Value>) -> Option<QuotaWindow> {
    let block = block?;
    if block.is_null() {
        return None;
    }
    let used = block.get("utilization").and_then(Value::as_f64)?;
    if !used.is_finite() {
        return None;
    }
    let remaining = (100.0 - used).round().clamp(0.0, 100.0) as i32;
    let reset_at = block
        .get("resets_at")
        .and_then(Value::as_str)
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.timestamp());

    Some(QuotaWindow {
        label: label.to_string(),
        remaining_percent: remaining,
        reset_at,
    })
}

/// `expiresAt` is epoch milliseconds; missing / unparsable = assume valid.
fn token_expired(oauth: &Value, now: i64) -> bool {
    oauth
        .get("expiresAt")
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .is_some_and(|ms| ms > 0 && ms <= now * 1000)
}

fn format_plan(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "max" => "Max".to_string(),
        "pro" => "Pro".to_string(),
        "team" => "Team".to_string(),
        "enterprise" => "Enterprise".to_string(),
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
        provider: ProviderKind::Claude,
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

    #[test]
    fn expiry_is_checked_locally() {
        let now = 1_800_000_000;
        assert!(token_expired(&serde_json::json!({"expiresAt": (now - 1) * 1000}), now));
        assert!(!token_expired(&serde_json::json!({"expiresAt": (now + 60) * 1000}), now));
        assert!(!token_expired(&serde_json::json!({}), now));
    }
}
