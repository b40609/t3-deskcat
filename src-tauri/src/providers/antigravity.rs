use crate::models::{AccountQuota, ProviderKind, QuotaWindow};
use crate::providers::{parse_retry_after, FetchOutcome};
use chrono::Utc;
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

const GOOGLE_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const CODE_ASSIST_BASE: &str = "https://daily-cloudcode-pa.googleapis.com";
/// Cache `loadCodeAssist` project_id + tier in memory to avoid repeating it on every poll.
const META_CACHE_TTL_SECS: i64 = 6 * 3600;

#[derive(Clone)]
struct CachedToken {
    access_token: String,
    expires_at: i64,
    refresh_hash: u64,
}

#[derive(Clone)]
struct CachedMeta {
    project_id: String,
    plan: Option<String>,
    fetched_at: i64,
}

fn token_cache() -> &'static Mutex<HashMap<String, CachedToken>> {
    static C: OnceLock<Mutex<HashMap<String, CachedToken>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn meta_cache() -> &'static Mutex<HashMap<String, CachedMeta>> {
    static C: OnceLock<Mutex<HashMap<String, CachedMeta>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn hash_str(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

fn evict_caches(id: &str) {
    if let Ok(mut tc) = token_cache().lock() {
        tc.remove(id);
    }
    if let Ok(mut mc) = meta_cache().lock() {
        mc.remove(id);
    }
}

enum ApiErr {
    Auth(String),
    RateLimit { retry_after: Option<i64>, msg: String },
    Other(String),
}

impl ApiErr {
    fn into_outcome(self, id: String, name: String, now: i64) -> FetchOutcome {
        match self {
            ApiErr::Auth(msg) => {
                evict_caches(&id);
                FetchOutcome::network(error_account(id, name, now, "expired", msg))
            }
            ApiErr::RateLimit { retry_after, msg } => FetchOutcome::rate_limited(
                error_account(id, name, now, "cooldown", msg),
                retry_after,
            ),
            ApiErr::Other(msg) => FetchOutcome::network(error_account(id, name, now, "error", msg)),
        }
    }
}

/// Fetches Antigravity quota using T3's `antigravity-oauth-token` / `acp_token.json`
/// (or legacy `~/.gemini/oauth_creds.json`).
/// Refreshes the short-lived access token in memory only (cached until expiry) and
/// caches `loadCodeAssist` project/tier metadata so each poll sends 2 calls instead of 4.
pub async fn fetch_antigravity_quota(
    client: &Client,
    id: String,
    name: String,
    token_path: &Path,
    is_legacy_gemini: bool,
) -> FetchOutcome {
    fetch_antigravity_quota_at(client, id, name, token_path, is_legacy_gemini, CODE_ASSIST_BASE)
        .await
}

async fn fetch_antigravity_quota_at(
    client: &Client,
    id: String,
    name: String,
    token_path: &Path,
    is_legacy_gemini: bool,
    code_assist_base: &str,
) -> FetchOutcome {
    let now = Utc::now().timestamp();

    let raw = match fs::read_to_string(token_path) {
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

    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(err) => {
            return FetchOutcome::local(error_account(
                id,
                name,
                now,
                "error",
                crate::tr!("憑證 JSON 錯誤: {err}", err = err),
            ));
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

    // 1. Prefer unexpired token straight from disk (T3 keeps it refreshed while active).
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

    // 2. Otherwise check our in-memory refreshed-token cache before hitting Google OAuth.
    let rt_hash = hash_str(refresh_token);
    if access_token.is_none() && !refresh_token.is_empty() {
        if let Ok(tc) = token_cache().lock() {
            if let Some(cached) = tc.get(&id) {
                if cached.refresh_hash == rt_hash && cached.expires_at > now + 90 {
                    access_token = Some(cached.access_token.clone());
                }
            }
        }
    }

    // 3. Only call Google OAuth refresh when both disk & memory tokens are expired.
    if access_token.is_none() {
        if refresh_token.is_empty() {
            return FetchOutcome::local(error_account(
                id,
                name,
                now,
                "expired",
                crate::tr!("缺少 Refresh Token"),
            ));
        }
        if client_id.is_empty() || client_secret.is_empty() {
            return FetchOutcome::local(error_account(
                id,
                name,
                now,
                if t3_token.is_some() { "expired" } else { "error" },
                if t3_token.is_some() {
                    crate::tr!("憑證已過期：開啟 Antigravity（或 T3 Code）會自動更新")
                } else {
                    crate::tr!("憑證缺少 client_id / client_secret")
                },
            ));
        }
        match refresh_google_token(client, token_uri, client_id, client_secret, refresh_token, now)
            .await
        {
            Ok((tok, expires_in)) => {
                if let Ok(mut tc) = token_cache().lock() {
                    tc.insert(
                        id.clone(),
                        CachedToken {
                            access_token: tok.clone(),
                            expires_at: now + expires_in.clamp(300, 7200),
                            refresh_hash: rt_hash,
                        },
                    );
                }
                access_token = Some(tok);
            }
            Err(err) => return err.into_outcome(id, name, now),
        }
    }

    let access_token = access_token.unwrap_or_default();

    // Reuse cached project_id + plan for META_CACHE_TTL_SECS to avoid calling loadCodeAssist every poll.
    let cached_meta = meta_cache()
        .lock()
        .ok()
        .and_then(|mc| mc.get(&id).cloned())
        .filter(|m| now - m.fetched_at < META_CACHE_TTL_SECS);

    let (plan, project) = if let Some(m) = cached_meta {
        (m.plan, m.project_id)
    } else {
        let load_res = post_code_assist(
            client,
            code_assist_base,
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
            now,
        )
        .await;

        let (plan, resolved_project, load_err) = match load_res {
            Ok(load) => (extract_tier(&load), extract_project(&load), None),
            Err(err) => match err {
                ApiErr::Auth(_) | ApiErr::RateLimit { .. } => {
                    return err.into_outcome(id, name, now);
                }
                ApiErr::Other(msg) => (None, None, Some(msg)),
            },
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
            return FetchOutcome::network(error_account(
                id,
                name,
                now,
                "error",
                load_err.unwrap_or_else(|| crate::tr!("無法取得 Antigravity Project ID")),
            ));
        };

        if let Ok(mut mc) = meta_cache().lock() {
            mc.insert(
                id.clone(),
                CachedMeta {
                    project_id: project.clone(),
                    plan: plan.clone(),
                    fetched_at: now,
                },
            );
        }
        (plan, project)
    };

    let project_payload = json!({ "project": project });

    // Cloud Code requires fetchAvailableModels before retrieveUserQuotaSummary returns buckets.
    if let Err(err) = post_code_assist(
        client,
        code_assist_base,
        &access_token,
        "v1internal:fetchAvailableModels",
        &project_payload,
        "antigravity/1.20.5 windows/amd64",
        now,
    )
    .await
    {
        if matches!(err, ApiErr::Other(_)) {
            if let Ok(mut mc) = meta_cache().lock() {
                mc.remove(&id);
            }
        }
        return err.into_outcome(id, name, now);
    }

    let quota = match post_code_assist(
        client,
        code_assist_base,
        &access_token,
        "v1internal:retrieveUserQuotaSummary",
        &project_payload,
        "antigravity/cli/1.4.10 windows/amd64",
        now,
    )
    .await
    {
        Ok(q) => q,
        Err(err) => {
            if matches!(err, ApiErr::Other(_)) {
                if let Ok(mut mc) = meta_cache().lock() {
                    mc.remove(&id);
                }
            }
            return err.into_outcome(id, name, now);
        }
    };

    let (primary_windows, extra_windows) = parse_quota_groups(&quota);
    let effective = primary_windows
        .iter()
        .map(|w| w.remaining_percent)
        .min()
        .unwrap_or(0);

    FetchOutcome::network(AccountQuota {
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
    })
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
    now: i64,
) -> Result<(String, i64), ApiErr> {
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
        .map_err(|err| ApiErr::Other(crate::tr!("OAuth 連線失敗: {err}", err = err)))?;

    let status = resp.status().as_u16();
    let retry_after = parse_retry_after(resp.headers(), now);
    if status == 400 || status == 401 {
        return Err(ApiErr::Auth(crate::tr!(
            "Google 授權已失效 (HTTP {status})",
            status = status
        )));
    }
    if status == 429 || status == 503 {
        return Err(ApiErr::RateLimit {
            retry_after,
            msg: crate::tr!("Google OAuth 請求受限 (HTTP {status})", status = status),
        });
    }
    if !resp.status().is_success() {
        return Err(ApiErr::Other(crate::tr!(
            "Token 刷新失敗 (HTTP {status})",
            status = status
        )));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|err| ApiErr::Other(crate::tr!("Token 回應解析失敗: {err}", err = err)))?;

    let access_token = body
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| ApiErr::Other(crate::tr!("OAuth 回應缺少 access_token")))?;
    let expires_in = body
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(3600);
    Ok((access_token, expires_in))
}

async fn post_code_assist(
    client: &Client,
    code_assist_base: &str,
    access_token: &str,
    endpoint: &str,
    payload: &Value,
    user_agent: &str,
    now: i64,
) -> Result<Value, ApiErr> {
    let url = format!("{code_assist_base}/{endpoint}");
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
        .map_err(|err| {
            ApiErr::Other(crate::tr!(
                "請求 {endpoint} 失敗: {err}",
                endpoint = endpoint,
                err = err
            ))
        })?;

    let status = resp.status().as_u16();
    let retry_after = parse_retry_after(resp.headers(), now);
    if status == 401 || status == 403 {
        return Err(ApiErr::Auth(crate::tr!(
            "授權被拒絕 (HTTP {status})",
            status = status
        )));
    }
    if status == 429 || status == 503 {
        return Err(ApiErr::RateLimit {
            retry_after,
            msg: format!("{endpoint} HTTP {status}"),
        });
    }
    if !resp.status().is_success() {
        return Err(ApiErr::Other(format!("{endpoint} HTTP {status}")));
    }

    let text = resp.text().await.map_err(|err| {
        ApiErr::Other(crate::tr!(
            "讀取 {endpoint} 回應失敗: {err}",
            endpoint = endpoint,
            err = err
        ))
    })?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|err| {
        ApiErr::Other(crate::tr!(
            "解析 {endpoint} JSON 失敗: {err}",
            endpoint = endpoint,
            err = err
        ))
    })
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
            let span_slug = if is_weekly { "weekly" } else { "5h" };
            let raw_id = field(bucket, "bucketId", "id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);

            if group_name.contains("argon") || bucket_id.contains("argon") {
                extras.push(QuotaWindow {
                    id: Some(raw_id.unwrap_or_else(|| format!("gemini-argon-{span_slug}"))),
                    label: format!("Argon {win_tag}"),
                    remaining_percent: remaining,
                    reset_at,
                });
            } else if group_name.contains("claude")
                || group_name.contains("gpt")
                || bucket_id.starts_with("3p")
            {
                extras.push(QuotaWindow {
                    id: Some(raw_id.unwrap_or_else(|| format!("3p-{span_slug}"))),
                    label: format!("3P {win_tag}"),
                    remaining_percent: remaining,
                    reset_at,
                });
            } else if group_name.contains("gemini") || bucket_id.starts_with("gemini") {
                let w = QuotaWindow {
                    id: Some(raw_id.unwrap_or_else(|| format!("gemini-{span_slug}"))),
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
        assert_eq!(missing.quota.status, "error");
        assert!(!missing.network_hit);
        assert!(missing.quota.error.is_some());

        let bad_json_path = dir.join("bad.json");
        fs::write(&bad_json_path, "{not-json").unwrap();
        let bad = fetch_antigravity_quota(&client, "ag:b".into(), "B".into(), &bad_json_path, false).await;
        assert_eq!(bad.quota.status, "error");
        assert!(!bad.network_hit);

        let no_rt_path = dir.join("no_rt.json");
        fs::write(&no_rt_path, r#"{"token":{"access_token":"","expiry":"2000-01-01T00:00:00Z"}}"#).unwrap();
        let no_rt = fetch_antigravity_quota(&client, "ag:n".into(), "N".into(), &no_rt_path, false).await;
        assert_eq!(no_rt.quota.status, "expired");
        assert!(!no_rt.network_hit);

        let t3_expired_no_client = dir.join("providers").join("antigravity").join("h").join("antigravity-acp").join("antigravity-oauth-token");
        fs::create_dir_all(t3_expired_no_client.parent().unwrap()).unwrap();
        fs::write(&t3_expired_no_client, r#"{"token":{"access_token":"old","refresh_token":"rt","expiry":"2020-01-01T00:00:00Z"}}"#).unwrap();
        let no_cli = fetch_antigravity_quota(&client, "ag:c".into(), "C".into(), &t3_expired_no_client, false).await;
        assert_eq!(no_cli.quota.status, "expired");
        assert!(!no_cli.network_hit);
        assert!(no_cli.quota.error.as_deref().unwrap_or("").contains("Antigravity"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn mock_http_caches_oauth_token_and_load_code_assist_and_handles_429_401() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let oauth_hits = Arc::new(AtomicUsize::new(0));
        let load_hits = Arc::new(AtomicUsize::new(0));
        let models_hits = Arc::new(AtomicUsize::new(0));
        let quota_hits = Arc::new(AtomicUsize::new(0));
        let mode = Arc::new(AtomicUsize::new(0)); // 0=ok, 1=429, 2=401

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (oh, lh, mh, qh, m_srv) = (
            oauth_hits.clone(),
            load_hits.clone(),
            models_hits.clone(),
            quota_hits.clone(),
            mode.clone(),
        );
        let srv = tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = listener.accept().await else { break };
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("");
                let cur_mode = m_srv.load(Ordering::SeqCst);
                let (status, extra_hdr, body) = if path == "/oauth/token" {
                    oh.fetch_add(1, Ordering::SeqCst);
                    ("200 OK", "", r#"{"access_token":"cached_tok_1","expires_in":3600}"#)
                } else if path.contains("loadCodeAssist") {
                    lh.fetch_add(1, Ordering::SeqCst);
                    (
                        "200 OK",
                        "",
                        r#"{"cloudaicompanionProject":"proj-123","paidTier":{"name":"Google AI Pro"}}"#,
                    )
                } else if path.contains("fetchAvailableModels") {
                    mh.fetch_add(1, Ordering::SeqCst);
                    if cur_mode == 1 {
                        ("429 Too Many Requests", "Retry-After: 300\r\n", r#"{"error":"RESOURCE_EXHAUSTED"}"#)
                    } else if cur_mode == 2 {
                        ("401 Unauthorized", "", r#"{"error":"UNAUTHENTICATED"}"#)
                    } else {
                        ("200 OK", "", "{}")
                    }
                } else if path.contains("retrieveUserQuotaSummary") {
                    qh.fetch_add(1, Ordering::SeqCst);
                    (
                        "200 OK",
                        "",
                        r#"{"groups":[{"displayName":"Gemini","buckets":[{"bucketId":"gemini-5h","remainingFraction":0.8},{"bucketId":"gemini-weekly","remainingFraction":0.9}]}]}"#,
                    )
                } else {
                    ("404 Not Found", "", "{}")
                };
                let resp = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{extra_hdr}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = s.write_all(resp.as_bytes()).await;
            }
        });

        let dir = tmp_dir("cache_mock");
        let tok_path = dir.join("acp_token.json");
        let base = format!("http://{addr}");
        fs::write(
            &tok_path,
            format!(
                r#"{{"client_id":"cid","client_secret":"csec","refresh_token":"rt_unique","token_uri":"{base}/oauth/token"}}"#
            ),
        )
        .unwrap();

        let id = format!("ag:mock_cache_{}", std::process::id());
        let client = Client::new();

        // 3 consecutive successful polls: oauth_token & loadCodeAssist must each run ONLY ONCE!
        for _ in 0..3 {
            let r = fetch_antigravity_quota_at(&client, id.clone(), "Mock".into(), &tok_path, false, &base).await;
            assert!(r.network_hit);
            assert_eq!(r.quota.status, "ok");
            assert_eq!(r.quota.effective_remaining, 80);
            assert_eq!(r.quota.plan.as_deref(), Some("Pro"));
        }
        assert_eq!(oauth_hits.load(Ordering::SeqCst), 1, "OAuth refresh must be cached in memory");
        assert_eq!(load_hits.load(Ordering::SeqCst), 1, "loadCodeAssist must be cached for 6h");
        assert_eq!(models_hits.load(Ordering::SeqCst), 3);
        assert_eq!(quota_hits.load(Ordering::SeqCst), 3);

        // 429 with Retry-After: 300 -> cooldown + retry_after_secs = Some(300)
        mode.store(1, Ordering::SeqCst);
        let r429 = fetch_antigravity_quota_at(&client, id.clone(), "Mock".into(), &tok_path, false, &base).await;
        assert_eq!(r429.quota.status, "cooldown");
        assert_eq!(r429.retry_after_secs, Some(300));

        // 401 -> expired and evicts token & meta caches so next recovery re-runs them
        mode.store(2, Ordering::SeqCst);
        let r401 = fetch_antigravity_quota_at(&client, id.clone(), "Mock".into(), &tok_path, false, &base).await;
        assert_eq!(r401.quota.status, "expired");

        mode.store(0, Ordering::SeqCst);
        let r_rec = fetch_antigravity_quota_at(&client, id.clone(), "Mock".into(), &tok_path, false, &base).await;
        assert_eq!(r_rec.quota.status, "ok");
        assert_eq!(oauth_hits.load(Ordering::SeqCst), 2, "evicted token cache must refresh after 401");
        assert_eq!(load_hits.load(Ordering::SeqCst), 2, "evicted meta cache must refresh after 401");

        srv.abort();
        let _ = fs::remove_dir_all(&dir);
    }
}
