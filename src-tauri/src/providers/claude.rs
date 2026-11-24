use crate::models::{AccountQuota, ProviderKind, QuotaWindow};
use crate::providers::{parse_retry_after, FetchOutcome};
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
) -> FetchOutcome {
    let now = Utc::now().timestamp();

    let raw_creds = match fs::read_to_string(credentials_path) {
        Ok(s) => s,
        Err(err) => {
            return FetchOutcome::local(error_account(
                id,
                name,
                now,
                "error",
                crate::tr!("無法讀取憑證: {err}", err = err),
            ));
        }
    };

    let parsed: Value = match serde_json::from_str(&raw_creds) {
        Ok(v) => v,
        Err(err) => {
            return FetchOutcome::local(error_account(
                id,
                name,
                now,
                "error",
                crate::tr!("憑證 JSON 格式錯誤: {err}", err = err),
            ));
        }
    };

    let Some(oauth) = parsed.get("claudeAiOauth") else {
        return FetchOutcome::local(error_account(
            id,
            name,
            now,
            "expired",
            crate::tr!("尚未登入 Claude Code"),
        ));
    };

    let access_token = oauth
        .get("accessToken")
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

    let plan = oauth
        .get("subscriptionType")
        .and_then(Value::as_str)
        .map(format_plan);

    // Claude Code refreshes its own token when that account is used; an expired
    // one would only earn a 401, so don't spend a request on it.
    if token_expired(oauth, now) {
        return FetchOutcome::local(AccountQuota {
            id,
            provider: ProviderKind::Claude,
            name,
            plan,
            effective_remaining: 0,
            primary_windows: Vec::new(),
            extra_windows: Vec::new(),
            status: "expired".to_string(),
            error: Some(crate::tr!("憑證已過期：用這個帳號跑一次 Claude Code 就會自動更新")),
            updated_at: now,
        });
    }

    let resp = client
        .get(CLAUDE_USAGE_URL)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {access_token}"))
        .header("anthropic-beta", CLAUDE_BETA_HEADER)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, concat!("t3-deskcat/", env!("CARGO_PKG_VERSION")))
        .send()
        .await;

    let response = match resp {
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
        return FetchOutcome::network(AccountQuota {
            id,
            provider: ProviderKind::Claude,
            name,
            plan,
            effective_remaining: 0,
            primary_windows: Vec::new(),
            extra_windows: Vec::new(),
            status: "expired".to_string(),
            error: Some(crate::tr!("授權已過期，請在 Claude Code 重新登入")),
            updated_at: now,
        });
    }

    if status == 429 || status == 503 {
        return FetchOutcome::rate_limited(
            AccountQuota {
                id,
                provider: ProviderKind::Claude,
                name,
                plan,
                effective_remaining: 0,
                primary_windows: Vec::new(),
                extra_windows: Vec::new(),
                status: "cooldown".to_string(),
                error: Some(crate::tr!("429 請求頻繁冷卻中")),
                updated_at: now,
            },
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

    FetchOutcome::network(build_claude_quota(id, name, plan, &body, now))
}

fn build_claude_quota(
    id: String,
    name: String,
    plan: Option<String>,
    body: &Value,
    updated_at: i64,
) -> AccountQuota {
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
    // Newer per-model limits ("Fable" weekly, ...) come in the `limits` array.
    windows.extend(scoped_limits(body, &windows));

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
        updated_at,
    }
}

/// Reads Claude Code's local `cachedUsageUtilization` snapshot from `.claude.json`
/// (zero network requests). Returns `Some(quota)` only when a record newer than
/// `min_timestamp` is present.
pub fn read_local_claude_quota(
    id: &str,
    name: &str,
    credentials_path: &Path,
    min_timestamp: i64,
    now: i64,
) -> Option<AccountQuota> {
    let config_dir = credentials_path.parent()?;
    let mut candidates = vec![config_dir.join(".claude.json")];
    // Default `~/.claude` stores its state file at `~/.claude.json`.
    if config_dir.file_name().and_then(|n| n.to_str()) == Some(".claude") {
        if let Some(home) = config_dir.parent() {
            candidates.push(home.join(".claude.json"));
        }
    }

    // Read subscription plan locally if available (does not touch any secret token).
    let plan = fs::read_to_string(credentials_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| {
            v.pointer("/claudeAiOauth/subscriptionType")
                .and_then(Value::as_str)
                .map(format_plan)
        });

    let mut best: Option<AccountQuota> = None;
    for path in candidates {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        if !raw.contains("cachedUsageUtilization") {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if let Some(q) = parse_local_cached_usage(id, name, plan.clone(), &parsed, now) {
            if q.updated_at > min_timestamp
                && best.as_ref().is_none_or(|b| q.updated_at > b.updated_at)
            {
                best = Some(q);
            }
        }
    }
    best
}

fn parse_local_cached_usage(
    id: &str,
    name: &str,
    plan: Option<String>,
    root: &Value,
    now: i64,
) -> Option<AccountQuota> {
    let block = root.get("cachedUsageUtilization")?.as_object()?;
    let fetched_at = block
        .get("fetchedAtMs")
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .map(|ms| ms / 1000)
        .or_else(|| {
            block
                .get("fetchedAt")
                .and_then(|v| {
                    v.as_i64()
                        .map(|n| if n > 10_000_000_000 { n / 1000 } else { n })
                        .or_else(|| {
                            v.as_str()
                                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                                .map(|d| d.timestamp())
                        })
                })
        })?;
    if fetched_at <= 0 || fetched_at > now + 120 {
        return None;
    }
    let body = block
        .get("utilization")
        .filter(|v| v.is_object())
        .or_else(|| root.get("cachedUsageUtilization"))?;
    let mut quota = build_claude_quota(id.to_string(), name.to_string(), plan, body, fetched_at.min(now));
    if quota.primary_windows.is_empty() {
        return None;
    }
    // If any recorded window already reset before `now`, mark full and recompute effective.
    let mut changed = false;
    for w in &mut quota.primary_windows {
        if w.reset_at.is_some_and(|r| r <= now) {
            w.remaining_percent = 100;
            w.reset_at = None;
            changed = true;
        }
    }
    if changed {
        if let Some(min) = quota
            .primary_windows
            .iter()
            .filter(|w| !w.label.contains(' '))
            .map(|w| w.remaining_percent)
            .min()
        {
            quota.effective_remaining = min;
        }
    }
    Some(quota)
}

/// Model-scoped entries of `limits`: `{kind, group, percent (used), resets_at,
/// scope.model.display_name}` -> "Wk Fable" / "5h Fable".
fn scoped_limits(body: &Value, existing: &[QuotaWindow]) -> Vec<QuotaWindow> {
    let mut out: Vec<QuotaWindow> = Vec::new();
    for l in body.get("limits").and_then(Value::as_array).into_iter().flatten() {
        let Some(model) = l
            .pointer("/scope/model/display_name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|m| !m.is_empty())
        else {
            continue;
        };
        let Some(used) = l.get("percent").and_then(Value::as_f64) else { continue };
        let span = match l.get("group").and_then(Value::as_str) {
            Some("session") => "5h",
            _ => "Wk",
        };
        let label = format!("{span} {model}");
        if existing.iter().chain(out.iter()).any(|w| w.label == label) {
            continue;
        }
        let reset_at = l
            .get("resets_at")
            .and_then(Value::as_str)
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp());
        out.push(QuotaWindow {
            label,
            remaining_percent: (100.0 - used).round().clamp(0.0, 100.0) as i32,
            reset_at,
        });
    }
    out
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

    #[test]
    fn parses_local_cached_usage_without_network() {
        let now = 1_795_500_000;
        let root = serde_json::json!({
            "cachedUsageUtilization": {
                "fetchedAtMs": (now - 30) * 1000,
                "utilization": {
                    "five_hour": { "utilization": 22.0, "resets_at": "2026-11-24T12:00:00Z" },
                    "seven_day": { "utilization": 45.0, "resets_at": "2026-11-30T00:00:00Z" }
                }
            }
        });
        let q = parse_local_cached_usage("claude:main", "Ryan", Some("Team".into()), &root, now)
            .unwrap();
        assert_eq!(q.status, "ok");
        assert_eq!(q.updated_at, now - 30);
        assert_eq!(q.effective_remaining, 55);
        assert_eq!(q.primary_windows.len(), 2);
        assert_eq!((q.primary_windows[0].label.as_str(), q.primary_windows[0].remaining_percent), ("5h", 78));
        assert_eq!((q.primary_windows[1].label.as_str(), q.primary_windows[1].remaining_percent), ("Wk", 55));
    }
}

#[cfg(test)]
mod scoped_tests {
    use super::*;

    #[test]
    fn model_scoped_limits() {
        let body = serde_json::json!({"limits": [
            {"group": "session", "kind": "session", "percent": 39, "scope": null},
            {"group": "weekly", "kind": "weekly_scoped", "percent": 78,
             "resets_at": "2026-11-18T04:59:59.779999+08:00",
             "scope": {"model": {"display_name": "Fable", "id": null}}}
        ]});
        let w = scoped_limits(&body, &[]);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].label, "Wk Fable");
        assert_eq!(w[0].remaining_percent, 22);
        assert!(w[0].reset_at.is_some());
    }
}
