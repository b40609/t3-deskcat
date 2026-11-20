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
            return error_account(id, name, now, "error", format!("無法讀取憑證: {err}"));
        }
    };

    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(err) => {
            return error_account(id, name, now, "error", format!("憑證 JSON 錯誤: {err}"));
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
            return error_account(id, name, now, "expired", "缺少 Refresh Token".to_string());
        }
        if client_id.is_empty() || client_secret.is_empty() {
            return error_account(
                id,
                name,
                now,
                "error",
                if t3_token.is_some() {
                    "憑證已過期：開著 T3 Code 會自動刷新".to_string()
                } else {
                    "憑證缺少 client_id / client_secret".to_string()
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
                .unwrap_or_else(|| "無法取得 Antigravity Project ID".to_string()),
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
        .map_err(|err| format!("OAuth 連線失敗: {err}"))?;

    let status = resp.status().as_u16();
    if status == 400 || status == 401 {
        return Err(format!("Google 授權已失效 (HTTP {status})"));
    }
    if !resp.status().is_success() {
        return Err(format!("Token 刷新失敗 (HTTP {status})"));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|err| format!("Token 回應解析失敗: {err}"))?;

    body.get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "OAuth 回應缺少 access_token".to_string())
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
        .map_err(|err| format!("請求 {endpoint} 失敗: {err}"))?;

    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err(format!("授權被拒絕 (HTTP {status})"));
    }
    if !resp.status().is_success() {
        return Err(format!("{endpoint} HTTP {status}"));
    }

    let text = resp
        .text()
        .await
        .map_err(|err| format!("讀取 {endpoint} 回應失敗: {err}"))?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|err| format!("解析 {endpoint} JSON 失敗: {err}"))
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

fn parse_quota_groups(raw: &Value) -> (Vec<QuotaWindow>, Vec<QuotaWindow>) {
    let mut gemini_5h: Option<QuotaWindow> = None;
    let mut gemini_wk: Option<QuotaWindow> = None;
    let mut extras: Vec<QuotaWindow> = Vec::new();

    let Some(groups) = raw.get("groups").and_then(Value::as_array) else {
        return (Vec::new(), Vec::new());
    };

    for grp in groups {
        let group_name = grp
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let Some(buckets) = grp.get("buckets").and_then(Value::as_array) else {
            continue;
        };

        for bucket in buckets {
            let bucket_id = bucket
                .get("bucketId")
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
                bucket
                    .get("remainingFraction")
                    .and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse::<f64>().ok()))
                    .filter(|f| f.is_finite())
                    .map(|f| (f * 100.0).round().clamp(0.0, 100.0) as i32)
                    .unwrap_or(0)
            };

            let reset_at = bucket
                .get("resetTime")
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
