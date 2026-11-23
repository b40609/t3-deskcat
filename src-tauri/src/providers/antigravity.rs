use crate::models::{AccountQuota, ProviderKind, QuotaWindow};
use chrono::Utc;
use reqwest::Client;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

const GOOGLE_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const CODE_ASSIST_BASE: &str = "https://daily-cloudcode-pa.googleapis.com";

/// Fetches Antigravity quota using T3's `acp_token.json` (or legacy `~/.gemini/oauth_creds.json`).
/// Refreshes the short-lived access token in memory only and never modifies local credential files.
pub async fn fetch_antigravity_quota(
    client: &Client,
    id: String,
    name: String,
    token_path: &Path,
    is_legacy_gemini: bool,
) -> AccountQuota {
    let now = Utc::now().timestamp();

    let raw = match fs::read_to_string(token_path) {
        Ok(s) => s,
        Err(err) => {
            return error_account(id, name, now, "error", crate::tr!("無法讀取憑證: {err}", err = err));
        }
    };

    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(err) => {
            return error_account(id, name, now, "error", crate::tr!("憑證 JSON 錯誤: {err}", err = err));
        }
    };

    // T3 0.1.11+ writes `antigravity-oauth-token`:
    // {"token":{"access_token","refresh_token","expiry"(RFC3339),..},"auth_method",..}
    // T3 keeps it refreshed while running; it carries no OAuth client.
    let t3_token = parsed.get("token").filter(|v| v.is_object());
    let token_obj = t3_token.unwrap_or(&parsed);
    let refresh_token = token_obj
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let env_client_id = std::env::var("T3_DESKCAT_AG_CLIENT_ID").ok();
    let env_client_secret = std::env::var("T3_DESKCAT_AG_CLIENT_SECRET").ok();
    // New-format files have no client: borrow it from an older `acp_token.json`
    // of any Antigravity account (they all use the Antigravity app's client).
    let sibling = if t3_token.is_some() { sibling_client(token_path) } else { None };
    let client_id = parsed
        .get("client_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(env_client_id.as_deref())
        .or(sibling.as_ref().map(|s| s.0.as_str()))
        .unwrap_or("");
    let client_secret = parsed
        .get("client_secret")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(env_client_secret.as_deref())
        .or(sibling.as_ref().map(|s| s.1.as_str()))
        .unwrap_or("");
    let token_uri = parsed
        .get("token_uri")
        .and_then(Value::as_str)
        .unwrap_or(GOOGLE_TOKEN_ENDPOINT);

    // For legacy oauth_creds.json, try existing access_token if not expired, else refresh
    let mut access_token = if let Some(tok) = t3_token {
        let exp = tok
            .get("expiry")
            .and_then(Value::as_str)
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp())
            .unwrap_or(0);
        let at = tok.get("access_token").and_then(Value::as_str).unwrap_or("");
        if !at.is_empty() && exp > now + 60 {
            Some(at.to_string())
        } else {
            None
        }
    } else if is_legacy_gemini {
        let exp = parsed.get("expiry_date").and_then(Value::as_i64).unwrap_or(0);
        let tok = parsed.get("access_token").and_then(Value::as_str).unwrap_or("");
        if !tok.is_empty() && exp > (now * 1000 + 60_000) {
            Some(tok.to_string())
        } else {
            None
        }
    } else {
        None
    };

    if access_token.is_none() {
        if refresh_token.is_empty() {
            return error_account(id, name, now, "expired", crate::tr!("缺少 Refresh Token"));
        }
        if client_id.is_empty() || client_secret.is_empty() {
            return error_account(
                id,
                name,
                now,
                "error",
                if t3_token.is_some() {
                    crate::tr!("憑證已過期：開啟 Antigravity（或 T3 Code）會自動刷新")
                } else {
                    crate::tr!("憑證缺少 client_id / client_secret")
                },
            );
        }
        match refresh_google_token(client, token_uri, client_id, client_secret, refresh_token).await
        {
            Ok(tok) => access_token = Some(tok),
            Err(msg) => {
                let st = if msg.contains("expired") || msg.contains("400") || msg.contains("401") {
                    "expired"
                } else {
                    "error"
                };
                return error_account(id, name, now, st, msg);
            }
        }
    }

    let access_token = access_token.unwrap_or_default();

    let load_res = post_code_assist(
        client,
        &access_token,
        "v1internal:loadCodeAssist",
        &json!({
            "mode": "FULL_ELIGIBILITY_CHECK",
            "metadata": {
                "ideName": "antigravity",
                "ideType": "ANTIGRAVITY",
                "ideVersion": "1.20.5",
                "pluginVersion": "t3-deskcat",
                "platform": "WINDOWS_AMD64",
                "updateChannel": "stable",
                "pluginType": "GEMINI"
            }
        }),
        "antigravity/1.20.5 windows/amd64 google-api-nodejs-client/10.3.0",
    )
    .await;

    let (plan, resolved_project) = match &load_res {
        Ok(load) => (extract_tier(load), extract_project(load)),
        Err(_) => (None, None),
    };

    let project_id = resolved_project.or_else(|| {
        parsed
            .get("project_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    });

    let Some(project) = project_id else {
        return error_account(
            id,
            name,
            now,
            "error",
            load_res
                .err()
                .unwrap_or_else(|| crate::tr!("無法取得 Antigravity Project ID")),
        );
    };

    let project_payload = json!({ "project": project });

    // Cloud Code requires fetchAvailableModels before retrieveUserQuotaSummary returns buckets.
    if let Err(err) = post_code_assist(
        client,
        &access_token,
        "v1internal:fetchAvailableModels",
        &project_payload,
        "antigravity/1.20.5 windows/amd64",
    )
    .await
    {
        return error_account(id, name, now, "error", err);
    }

    let quota = match post_code_assist(
        client,
        &access_token,
        "v1internal:retrieveUserQuotaSummary",
        &project_payload,
        "antigravity/cli/1.4.10 windows/amd64",
    )
    .await
    {
        Ok(q) => q,
        Err(err) => return error_account(id, name, now, "error", err),
    };

    let (primary_windows, extra_windows) = parse_quota_groups(&quota);
    let effective = primary_windows
        .iter()
        .map(|w| w.remaining_percent)
        .min()
        .unwrap_or(0);

    AccountQuota {
        id,
        provider: ProviderKind::Antigravity,
        name,
        plan,
        effective_remaining: effective,
        primary_windows,
        extra_windows,
        status: "ok".to_string(),
        error: None,
        updated_at: now,
    }
}

/// Find an OAuth client (id, secret) in any `<instance>/antigravity-acp/acp_token.json`
/// next to this account's token. Read-only; nothing is written.
fn sibling_client(token_path: &Path) -> Option<(String, String)> {
    // token_path = .../providers/antigravity/<hash>/antigravity-acp/<file>
    let root = token_path.parent()?.parent()?.parent()?;
    for entry in fs::read_dir(root).ok()?.flatten() {
        let p = entry.path().join("antigravity-acp").join("acp_token.json");
        let Ok(raw) = fs::read_to_string(&p) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else { continue };
        let id = v.get("client_id").and_then(Value::as_str).unwrap_or("").trim();
        let secret = v.get("client_secret").and_then(Value::as_str).unwrap_or("").trim();
        if !id.is_empty() && !secret.is_empty() {
            return Some((id.to_string(), secret.to_string()));
        }
    }
    None
}

async fn refresh_google_token(
    client: &Client,
    token_uri: &str,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<String, String> {
    let resp = client
        .post(token_uri)
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|err| crate::tr!("OAuth 連線失敗: {err}", err = err))?;

    let status = resp.status().as_u16();
    if status == 400 || status == 401 {
        return Err(crate::tr!("Google 授權已失效 (HTTP {status})", status = status));
    }
    if !resp.status().is_success() {
        return Err(crate::tr!("Token 刷新失敗 (HTTP {status})", status = status));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|err| crate::tr!("Token 回應解析失敗: {err}", err = err))?;

    body.get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| crate::tr!("OAuth 回應缺少 access_token"))
}

async fn post_code_assist(
    client: &Client,
    access_token: &str,
    endpoint: &str,
    payload: &Value,
    user_agent: &str,
) -> Result<Value, String> {
    let url = format!("{CODE_ASSIST_BASE}/{endpoint}");
    let resp = client
        .post(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {access_token}"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "*/*")
        .header(reqwest::header::USER_AGENT, user_agent)
        .header("x-goog-api-client", "gl-node/22.21.1")
        .json(payload)
        .send()
        .await
        .map_err(|err| crate::tr!("請求 {endpoint} 失敗: {err}", endpoint = endpoint, err = err))?;

    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err(crate::tr!("授權被拒絕 (HTTP {status})", status = status));
    }
    if !resp.status().is_success() {
        return Err(format!("{endpoint} HTTP {status}"));
    }

    let text = resp
        .text()
        .await
        .map_err(|err| crate::tr!("讀取 {endpoint} 回應失敗: {err}", endpoint = endpoint, err = err))?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|err| crate::tr!("解析 {endpoint} JSON 失敗: {err}", endpoint = endpoint, err = err))
}

fn extract_project(load: &Value) -> Option<String> {
    let field = load.get("cloudaicompanionProject")?;
    field
        .as_str()
        .or_else(|| field.get("id").and_then(Value::as_str))
        .or_else(|| field.get("projectId").and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn extract_tier(load: &Value) -> Option<String> {
    ["paidTier", "currentTier"]
        .iter()
        .filter_map(|k| load.get(*k)?.get("name")?.as_str())
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(|s| {
            s.strip_prefix("Google AI ")
                .unwrap_or(s)
                .to_string()
        })
}

/// Accepts both the Cloud Code API shape (`displayName`, `bucketId`, `remainingFraction`,
/// `resetTime`) and the `agy -p /usage` report (`name`, `id`, `remaining_fraction`, `reset_time`).
pub(crate) fn parse_quota_groups(raw: &Value) -> (Vec<QuotaWindow>, Vec<QuotaWindow>) {
    fn field<'a>(v: &'a Value, camel: &str, snake: &str) -> Option<&'a Value> {
        v.get(camel).or_else(|| v.get(snake))
    }
    let mut gemini_5h: Option<QuotaWindow> = None;
    let mut gemini_wk: Option<QuotaWindow> = None;
    let mut extras: Vec<QuotaWindow> = Vec::new();

    let Some(groups) = raw.get("groups").and_then(Value::as_array) else {
        return (Vec::new(), Vec::new());
    };

    for grp in groups {
        let group_name = field(grp, "displayName", "name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let Some(buckets) = grp.get("buckets").and_then(Value::as_array) else {
            continue;
        };

        for bucket in buckets {
            let bucket_id = field(bucket, "bucketId", "id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let window = bucket
                .get("window")
                .and_then(Value::as_str)
                .unwrap_or("");
            let is_weekly = window == "weekly" || bucket_id.ends_with("weekly");
            let is_5h = window == "5h" || bucket_id.ends_with("5h");
            if !is_weekly && !is_5h {
                continue;
            }

            let disabled = bucket
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let remaining = if disabled {
                0
            } else {
                field(bucket, "remainingFraction", "remaining_fraction")
                    .and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse::<f64>().ok()))
                    .filter(|f| f.is_finite())
                    .map(|f| (f * 100.0).round().clamp(0.0, 100.0) as i32)
                    .unwrap_or(0)
            };

            let reset_at = field(bucket, "resetTime", "reset_time")
                .and_then(Value::as_str)
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.timestamp());

            let win_tag = if is_weekly { "Wk" } else { "5h" };

            if group_name.contains("argon") || bucket_id.contains("argon") {
                extras.push(QuotaWindow {
                    label: format!("Argon {win_tag}"),
                    remaining_percent: remaining,
                    reset_at,
                });
            } else if group_name.contains("claude")
                || group_name.contains("gpt")
                || bucket_id.starts_with("3p")
            {
                extras.push(QuotaWindow {
                    label: format!("3P {win_tag}"),
                    remaining_percent: remaining,
                    reset_at,
                });
            } else if group_name.contains("gemini") || bucket_id.starts_with("gemini") {
                let w = QuotaWindow {
                    label: win_tag.to_string(),
                    remaining_percent: remaining,
                    reset_at,
                };
                if is_weekly {
                    if gemini_wk.is_none() {
                        gemini_wk = Some(w);
                    }
                } else if gemini_5h.is_none() {
                    gemini_5h = Some(w);
                }
            }
        }
    }

    let mut primary = Vec::new();
    if let Some(w) = gemini_5h {
        primary.push(w);
    }
    if let Some(w) = gemini_wk {
        primary.push(w);
    }

    (primary, extras)
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
        provider: ProviderKind::Antigravity,
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "t3_deskcat_ag_{tag}_{}_{}",
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parse_quota_groups_supports_cloud_code_and_agy_shapes() {
        let cloud = json!({
            "groups": [
                {
                    "displayName": "Gemini 3",
                    "buckets": [
                        { "bucketId": "gemini-5h", "remainingFraction": 0.924, "resetTime": "2026-11-23T12:00:00Z" },
                        { "bucketId": "gemini-weekly", "remainingFraction": 0.87, "resetTime": "2026-11-29T00:00:00Z" }
                    ]
                },
                {
                    "displayName": "Argon",
                    "buckets": [
                        { "bucketId": "argon-5h", "remainingFraction": 1.0 },
                        { "bucketId": "argon-weekly", "remainingFraction": "0.55" }
                    ]
                },
                {
                    "displayName": "Claude / GPT",
                    "buckets": [
                        { "bucketId": "3p-5h", "remainingFraction": 0.9, "disabled": true },
                        { "bucketId": "3p-weekly", "remainingFraction": 0.41 }
                    ]
                }
            ]
        });
        let (primary, extra) = parse_quota_groups(&cloud);
        assert_eq!(primary.len(), 2);
        assert_eq!((primary[0].label.as_str(), primary[0].remaining_percent), ("5h", 92));
        assert!(primary[0].reset_at.is_some());
        assert_eq!((primary[1].label.as_str(), primary[1].remaining_percent), ("Wk", 87));
        assert_eq!(extra.len(), 4);
        assert_eq!((extra[0].label.as_str(), extra[0].remaining_percent), ("Argon 5h", 100));
        assert_eq!((extra[1].label.as_str(), extra[1].remaining_percent), ("Argon Wk", 55));
        assert_eq!((extra[2].label.as_str(), extra[2].remaining_percent), ("3P 5h", 0));
        assert_eq!((extra[3].label.as_str(), extra[3].remaining_percent), ("3P Wk", 41));

        let agy = json!({
            "groups": [
                {
                    "name": "Gemini",
                    "buckets": [
                        { "id": "gem_1", "window": "5h", "remaining_fraction": 1.25, "reset_time": "2026-11-23T12:00:00Z" },
                        { "id": "gem_2", "window": "weekly", "remaining_fraction": -0.2 }
                    ]
                }
            ]
        });
        let (p2, e2) = parse_quota_groups(&agy);
        assert_eq!(p2.len(), 2);
        assert_eq!(p2[0].remaining_percent, 100);
        assert_eq!(p2[1].remaining_percent, 0);
        assert!(e2.is_empty());

        let (p3, e3) = parse_quota_groups(&json!({}));
        assert!(p3.is_empty() && e3.is_empty());
    }

    #[test]
    fn extract_project_and_tier_handle_all_shapes() {
        assert_eq!(extract_project(&json!({"cloudaicompanionProject": "proj-1"})), Some("proj-1".into()));
        assert_eq!(extract_project(&json!({"cloudaicompanionProject": {"id": "proj-2"}})), Some("proj-2".into()));
        assert_eq!(extract_project(&json!({"cloudaicompanionProject": {"projectId": "proj-3"}})), Some("proj-3".into()));
        assert_eq!(extract_project(&json!({"cloudaicompanionProject": "  "})), None);

        assert_eq!(
            extract_tier(&json!({"paidTier": {"name": "Google AI Pro"}, "currentTier": {"name": "Free"}})),
            Some("Pro".into())
        );
        assert_eq!(extract_tier(&json!({"currentTier": {"name": "Standard"}})), Some("Standard".into()));
        assert_eq!(extract_tier(&json!({})), None);
    }

    #[tokio::test]
    async fn fetch_handles_missing_invalid_and_incomplete_tokens() {
        let dir = tmp_dir("fetch");
        let client = Client::new();

        let missing = fetch_antigravity_quota(&client, "ag:m".into(), "M".into(), &dir.join("missing.json"), false).await;
        assert_eq!(missing.status, "error");
        assert!(missing.error.is_some());

        let bad_json_path = dir.join("bad.json");
        fs::write(&bad_json_path, "{not-json").unwrap();
        let bad = fetch_antigravity_quota(&client, "ag:b".into(), "B".into(), &bad_json_path, false).await;
        assert_eq!(bad.status, "error");

        let no_rt_path = dir.join("no_rt.json");
        fs::write(&no_rt_path, r#"{"token":{"access_token":"","expiry":"2000-01-01T00:00:00Z"}}"#).unwrap();
        let no_rt = fetch_antigravity_quota(&client, "ag:n".into(), "N".into(), &no_rt_path, false).await;
        assert_eq!(no_rt.status, "expired");

        let t3_expired_no_client = dir.join("providers").join("antigravity").join("h").join("antigravity-acp").join("antigravity-oauth-token");
        fs::create_dir_all(t3_expired_no_client.parent().unwrap()).unwrap();
        fs::write(&t3_expired_no_client, r#"{"token":{"access_token":"old","refresh_token":"rt","expiry":"2020-01-01T00:00:00Z"}}"#).unwrap();
        let no_cli = fetch_antigravity_quota(&client, "ag:c".into(), "C".into(), &t3_expired_no_client, false).await;
        assert_eq!(no_cli.status, "error");
        assert!(no_cli.error.as_deref().unwrap_or("").contains("Antigravity"));

        let _ = fs::remove_dir_all(&dir);
    }
}
