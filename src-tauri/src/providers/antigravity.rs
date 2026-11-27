//! Antigravity quota for T3 Code instances via the official `agy -p /usage` CLI.
//!
//! Zero direct HTTP calls to Google's internal `cloudcode-pa` APIs and zero background
//! OAuth refreshes for T3 accounts. Protected by two hard guardrails:
//!
//! 1. **Active-only expiry gate + strict whitelist token reconstruction**:
//!    Only unexpired T3 `antigravity-oauth-token` files (`expiry > now + 360s`, matching
//!    `agy`'s 5-minute internal `expiryDelta` + 60s safety margin) invoke `agy`. Lapsed
//!    tokens short-circuit locally as `"idle"` (0 subprocesses, 0 network).
//!    When an active token is staged for probing, a brand-new JSON object is built from
//!    an explicit allowlist (`token.{access_token, token_type, expiry, expires_in}`,
//!    `auth_method`, `id_token_email`) and verified to contain no `refresh` fields before
//!    writing, making background OAuth refresh physically impossible.
//! 2. **Isolated disposable fake home directory + fail-closed canary self-check**:
//!    Before staging any real token, each `agy` binary fingerprint must pass a version
//!    check (`>= 1.5.16`) and a fail-closed isolation canary check (expired synthetic
//!    credential must NOT succeed). Each real probe runs in a fresh restricted temp
//!    folder with `USERPROFILE`/`HOME`/`APPDATA`/`LOCALAPPDATA`/`XDG_*` redirected,
//!    copies the instance's non-secret `installation_id` to preserve its device
//!    fingerprint, and deletes the staged token file immediately on exit.

use crate::models::{AccountQuota, ProviderKind, QuotaWindow};
use crate::providers::antigravity_cli::{
    ensure_isolated_probe_ready, fetch_antigravity_cli_quota_with_mode, find_agy_for_t3,
    AgyProbeMode,
};
use crate::providers::FetchOutcome;
use chrono::Utc;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// `agy` internally treats tokens within 5 minutes (300s) of expiry as expired and attempts
/// an OAuth refresh (verified live on agy 1.5.18: 290s -> auth required, 320s -> ok).
/// Use a 360s (6-minute) local guard (300s + 60s startup/clock-skew buffer) so active probes
/// never hit `agy`'s internal expiry window.
const EXPIRY_GUARD_SECS: i64 = 360;
/// Epoch-zero (`1970-01-01T00:00:00Z`) and pre-2000 values are sentinel timestamps for full pools.
const MIN_VALID_RESET_TS: i64 = 946_684_800; // 2000-01-01T00:00:00Z
const PROBE_DIR_PREFIX: &str = "t3-deskcat-agy-";
const STALE_PROBE_AGE_SECS: u64 = 300;
const PRUNE_INTERVAL_SECS: i64 = 600;
const MAX_INSTALLATION_ID_BYTES: u64 = 256;

static PROBE_SEQ: AtomicU64 = AtomicU64::new(1);
static LAST_PRUNE_TS: AtomicI64 = AtomicI64::new(0);

/// RAII handle for a disposable isolated probe directory.
/// Immediately unlinks the staged token file on cleanup/drop so secrets never linger.
pub(crate) struct TempProbeDir {
    root: PathBuf,
    pub(crate) home: PathBuf,
    pub(crate) work: PathBuf,
    token_dst: PathBuf,
}

impl TempProbeDir {
    pub(crate) fn create(
        sanitized_token_json: &str,
        installation_id_src: Option<&Path>,
    ) -> Result<Self, String> {
        let seq = PROBE_SEQ.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        // Mix pid, monotonic seq, and nanos into a non-sequential hex suffix.
        let nonce = ((nanos as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)) ^ (seq.rotate_left(17));
        let root = std::env::temp_dir().join(format!(
            "{PROBE_DIR_PREFIX}{}-{seq}-{nonce:016x}",
            std::process::id()
        ));
        let home = root.join("home");
        let cli_dir = home.join(".gemini").join("antigravity-cli");
        let work = root.join("work");
        let token_dst = cli_dir.join("antigravity-oauth-token");

        create_restricted_dir(&root)
            .and_then(|_| fs::create_dir_all(&cli_dir))
            .and_then(|_| fs::create_dir_all(&work))
            .and_then(|_| fs::create_dir_all(home.join("AppData").join("Roaming")))
            .and_then(|_| fs::create_dir_all(home.join("AppData").join("Local")))
            .map_err(|err| {
                let _ = fs::remove_dir_all(&root);
                crate::tr!("無法建立隔離暫存目錄：{err}", err = err)
            })?;

        write_restricted_file(&token_dst, sanitized_token_json.as_bytes()).map_err(|err| {
            let _ = fs::remove_dir_all(&root);
            crate::tr!("無法寫入隔離暫存憑證：{err}", err = err)
        })?;

        // Preserve the instance's non-secret `installation_id` (36-byte UUID) so agy does
        // not register a brand-new installation fingerprint on every poll.
        if let Some(src) = installation_id_src {
            if let Ok(meta) = fs::symlink_metadata(src) {
                if meta.file_type().is_file() && meta.len() > 0 && meta.len() <= MAX_INSTALLATION_ID_BYTES {
                    let _ = fs::copy(src, cli_dir.join("installation_id"));
                }
            }
        }

        Ok(Self {
            root,
            home,
            work,
            token_dst,
        })
    }

    pub(crate) async fn cleanup(self) {
        // Delete the token file immediately (verified 0ms unlink on Windows).
        let _ = fs::remove_file(&self.token_dst);
        for attempt in 0..5 {
            if fs::remove_dir_all(&self.root).is_ok() || !self.root.exists() {
                return;
            }
            if attempt < 4 {
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
        }
    }
}

impl Drop for TempProbeDir {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.token_dst);
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[cfg(unix)]
fn create_restricted_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(path)
}

#[cfg(not(unix))]
fn create_restricted_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir(path)
}

#[cfg(unix)]
fn write_restricted_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)
}

#[cfg(not(unix))]
fn write_restricted_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    fs::write(path, bytes)
}

/// Opportunistically removes leftover `t3-deskcat-agy-*` temp folders older than 5 minutes
/// (e.g. if a previous run was killed mid-probe or Windows antivirus briefly held a lock).
fn maybe_prune_stale_probe_dirs(now: i64) {
    let prev = LAST_PRUNE_TS.load(Ordering::Relaxed);
    if now - prev < PRUNE_INTERVAL_SECS {
        return;
    }
    if LAST_PRUNE_TS
        .compare_exchange(prev, now, Ordering::SeqCst, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    let tmp = std::env::temp_dir();
    let Ok(rd) = fs::read_dir(&tmp) else { return };
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(STALE_PROBE_AGE_SECS))
        .unwrap_or(UNIX_EPOCH);
    for ent in rd.flatten() {
        let name = ent.file_name();
        if !name.to_string_lossy().starts_with(PROBE_DIR_PREFIX) {
            continue;
        }
        let path = ent.path();
        let mtime = fs::metadata(&path)
            .and_then(|m| m.modified())
            .unwrap_or(UNIX_EPOCH);
        if mtime < cutoff {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

/// Builds a strict allowlist-only read-only token JSON string for the isolated `agy` probe.
/// Only `token.{access_token, token_type, expiry, expires_in}` and top-level
/// `{auth_method, id_token_email}` survive; any `refresh_token`, `refreshToken`,
/// `client_id`, `client_secret`, or unknown keys are dropped, and the serialized JSON is
/// checked to contain no `refresh` key before returning.
pub(crate) fn build_readonly_token_json(parsed: &Value) -> Result<String, String> {
    let tok_src = parsed
        .get("token")
        .and_then(Value::as_object)
        .ok_or_else(|| crate::tr!("憑證 JSON 錯誤: {err}", err = "missing token object"))?;

    let mut tok = Map::new();
    for key in ["access_token", "token_type", "expiry", "expires_in"] {
        if let Some(v) = tok_src.get(key) {
            tok.insert(key.to_string(), v.clone());
        }
    }

    let mut root = Map::new();
    root.insert("token".to_string(), Value::Object(tok));
    for key in ["auth_method", "id_token_email"] {
        if let Some(v) = parsed.get(key) {
            root.insert(key.to_string(), v.clone());
        }
    }

    let serialized = serde_json::to_string(&Value::Object(root))
        .map_err(|err| crate::tr!("憑證 JSON 錯誤: {err}", err = err))?;

    // Defense in depth: guarantee no key named *refresh* can ever be staged on disk.
    let key_has_refresh = serde_json::from_str::<Value>(&serialized)
        .ok()
        .is_some_and(|v| json_has_refresh_key(&v));
    if key_has_refresh {
        return Err(crate::tr!("隔離憑證安全檢查失敗：偵測到殘留 refresh 欄位"));
    }
    Ok(serialized)
}

fn json_has_refresh_key(v: &Value) -> bool {
    match v {
        Value::Object(map) => map.iter().any(|(k, val)| {
            k.to_ascii_lowercase().contains("refresh") || json_has_refresh_key(val)
        }),
        Value::Array(arr) => arr.iter().any(json_has_refresh_key),
        _ => false,
    }
}

/// Fetches Antigravity quota for a T3 Code instance through the official `agy -p /usage`
/// CLI inside an isolated temporary home directory, with active-only expiry gating,
/// allowlist-only read-only token staging, and a fail-closed isolation canary check.
/// Never calls Google's internal `cloudcode-pa` HTTP APIs.
pub async fn fetch_antigravity_quota(
    id: String,
    name: String,
    token_path: &Path,
    is_legacy_gemini: bool,
) -> FetchOutcome {
    fetch_antigravity_quota_with_exe(
        id,
        name,
        token_path,
        is_legacy_gemini,
        None,
        Utc::now().timestamp(),
    )
    .await
}

pub(crate) async fn fetch_antigravity_quota_with_exe(
    id: String,
    name: String,
    token_path: &Path,
    is_legacy_gemini: bool,
    exe_override: Option<&Path>,
    now: i64,
) -> FetchOutcome {
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

    // Only T3 0.1.11+ / agy 1.5+ `antigravity-oauth-token` files (`{"token":{...}}`) are
    // supported via isolated `agy -p /usage`. Legacy `acp_token.json` and `~/.gemini/oauth_creds.json`
    // are never sent to Google's internal HTTP APIs.
    let Some(t3_token) = (!is_legacy_gemini)
        .then(|| parsed.get("token").filter(|v| v.is_object()))
        .flatten()
    else {
        return FetchOutcome::local(error_account(
            id,
            name,
            now,
            "expired",
            crate::tr!("舊版憑證格式已停用直連查詢，請改用新版 T3 Code 或 agy CLI 登入"),
        ));
    };

    let refresh_token = t3_token
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let has_refresh_token = !refresh_token.is_empty();

    let access_token = t3_token
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let expiry = t3_token
        .get("expiry")
        .and_then(Value::as_str)
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp())
        .unwrap_or(0);

    // Guardrail 1: active-only expiry gate (6-minute safety margin over agy's 5-min expiryDelta).
    // Lapsed accounts stay local ("idle") with 0 subprocesses and 0 network calls.
    if access_token.is_empty() || expiry <= now + EXPIRY_GUARD_SECS {
        let (status, msg) = if has_refresh_token {
            (
                "idle",
                crate::tr!("閒置超過 1 小時：用這個帳號跑一次對話就會恢復即時額度"),
            )
        } else {
            ("expired", crate::tr!("缺少 Refresh Token"))
        };
        return FetchOutcome::local(error_account(id, name, now, status, msg));
    }

    let exe = match exe_override {
        Some(p) => p.to_path_buf(),
        None => match find_agy_for_t3() {
            Some(p) => p,
            None => {
                return FetchOutcome::local(error_account(
                    id,
                    name,
                    now,
                    "error",
                    crate::tr!("找不到 agy CLI，無法透過官方 CLI 讀取 Antigravity 額度"),
                ));
            }
        },
    };

    maybe_prune_stale_probe_dirs(now);

    // Pre-flight BEFORE staging any real account token: verify latch, version >= 1.5.16,
    // and fail-closed isolation canary check.
    if let Err(msg) = ensure_isolated_probe_ready(&exe).await {
        return FetchOutcome::local(error_account(id, name, now, "error", msg));
    }

    // Guardrail 1b: strict allowlist reconstruction so refresh_token can never be written.
    let sanitized_json = match build_readonly_token_json(&parsed) {
        Ok(s) => s,
        Err(msg) => return FetchOutcome::local(error_account(id, name, now, "error", msg)),
    };

    // Guardrail 2: stage into a clean disposable fake home directory, keeping installation_id.
    let inst_id_path = token_path.parent().map(|d| d.join("installation_id"));
    let probe_dir = match TempProbeDir::create(&sanitized_json, inst_id_path.as_deref()) {
        Ok(d) => d,
        Err(msg) => return FetchOutcome::local(error_account(id, name, now, "error", msg)),
    };

    let mut outcome = fetch_antigravity_cli_quota_with_mode(
        id,
        name,
        &exe,
        AgyProbeMode::IsolatedHome(probe_dir.home.clone()),
        &probe_dir.work,
        now,
    )
    .await;

    probe_dir.cleanup().await;

    // This token passed Guardrail 1 (>360s left on disk), so an auth rejection from `agy`
    // must surface visibly as `"error"` instead of silently masking a broken isolation/format
    // change as `"idle"`. `"idle"` is reserved strictly for the local expiry gate above.
    if outcome.quota.status == "expired" {
        outcome.quota.status = "error".to_string();
        outcome.quota.error = Some(crate::tr!(
            "憑證未過期但 agy 未接受暫存憑證（可能為格式或隔離變更）"
        ));
    }

    outcome
}

/// Accepts both the `agy -p /usage` report (`name`, `id`, `remaining_fraction`, `reset_time`)
/// and camelCase equivalents (`displayName`, `bucketId`, `remainingFraction`, `resetTime`).
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn parse_quota_groups(raw: &Value) -> (Vec<QuotaWindow>, Vec<QuotaWindow>) {
    parse_quota_groups_at(raw, None)
}

pub(crate) fn parse_quota_groups_at(
    raw: &Value,
    now: Option<i64>,
) -> (Vec<QuotaWindow>, Vec<QuotaWindow>) {
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

            let window_secs = if is_weekly { 7 * 86_400 } else { 5 * 3_600 };
            let reset_at = field(bucket, "resetTime", "reset_time")
                .and_then(Value::as_str)
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.timestamp())
                .filter(|&ts| ts >= MIN_VALID_RESET_TS)
                .filter(|&ts| {
                    // Omit rolling full-window sentinel timestamps on untouched 100% pools.
                    if remaining == 100 {
                        if let Some(cur) = now {
                            if (ts - cur - window_secs).abs() <= 60 {
                                return false;
                            }
                        }
                    }
                    true
                });

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
    use serde_json::json;

    fn tmp_dir(tag: &str) -> PathBuf {
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

    /// Creates a mock `agy` executable script for deterministic local integration tests.
    fn write_mock_agy(dir: &Path, name: &str, body_win: &str, body_unix: &str) -> PathBuf {
        #[cfg(windows)]
        {
            let _ = body_unix;
            let p = dir.join(format!("{name}.cmd"));
            fs::write(&p, format!("@echo off\r\n{body_win}\r\n")).unwrap();
            p
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = body_win;
            let p = dir.join(name);
            fs::write(&p, format!("#!/bin/sh\n{body_unix}\n")).unwrap();
            let mut perms = fs::metadata(&p).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&p, perms).unwrap();
            p
        }
    }

    #[test]
    fn allowlist_reconstruction_drops_all_refresh_client_and_unknown_fields() {
        let raw = json!({
            "token": {
                "access_token": "tok_live",
                "token_type": "Bearer",
                "refresh_token": "1//secret_rt",
                "refreshToken": "camel_rt",
                "expiry": "2099-01-01T00:00:00Z",
                "expires_in": 3599,
                "extra_secret": "drop_me"
            },
            "auth_method": "oauth-personal",
            "id_token_email": "u@example.com",
            "refresh_token": "top_rt",
            "client_id": "cid",
            "client_secret": "csec",
            "unexpected": "drop_me"
        });
        let s = build_readonly_token_json(&raw).unwrap();
        assert!(!s.to_ascii_lowercase().contains("refresh"));
        assert!(!s.contains("1//secret_rt"));
        assert!(!s.contains("camel_rt"));
        assert!(!s.contains("client_id"));
        assert!(!s.contains("client_secret"));
        assert!(!s.contains("drop_me"));
        let parsed: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed["token"]["access_token"], "tok_live");
        assert_eq!(parsed["auth_method"], "oauth-personal");
        assert_eq!(parsed["id_token_email"], "u@example.com");
    }

    #[test]
    fn parse_quota_groups_supports_agy_shapes_and_filters_sentinels() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-27T02:36:39Z")
            .unwrap()
            .timestamp();
        let agy = json!({
            "groups": [
                {
                    "name": "Gemini Models",
                    "buckets": [
                        { "id": "gemini-5h", "window": "5h", "remaining_fraction": 0.924, "reset_time": "2026-11-27T05:00:00Z" },
                        { "id": "gemini-weekly", "window": "weekly", "remaining_fraction": 1.0, "reset_time": "2026-12-04T02:36:39Z" }
                    ]
                },
                {
                    "name": "Argon",
                    "buckets": [
                        { "id": "gemini-argon-5h", "window": "5h", "remaining_fraction": 1.0, "reset_time": "1970-01-01T00:00:00Z" },
                        { "id": "gemini-argon-weekly", "window": "weekly", "remaining_fraction": "0.55" }
                    ]
                },
                {
                    "name": "Claude and GPT models",
                    "buckets": [
                        { "id": "3p-5h", "window": "5h", "remaining_fraction": 0.9, "disabled": true },
                        { "id": "3p-weekly", "window": "weekly", "remaining_fraction": 0.41, "reset_time": "2026-12-02T07:11:09Z" }
                    ]
                }
            ]
        });
        let (primary, extra) = parse_quota_groups_at(&agy, Some(now));
        assert_eq!(primary.len(), 2);
        assert_eq!((primary[0].label.as_str(), primary[0].remaining_percent), ("5h", 92));
        assert!(primary[0].reset_at.is_some());
        assert_eq!((primary[1].label.as_str(), primary[1].remaining_percent), ("Wk", 100));
        assert_eq!(primary[1].reset_at, None);

        assert_eq!(extra.len(), 4);
        assert_eq!((extra[0].label.as_str(), extra[0].remaining_percent, extra[0].reset_at), ("Argon 5h", 100, None));
        assert_eq!((extra[1].label.as_str(), extra[1].remaining_percent), ("Argon Wk", 55));
        assert_eq!((extra[2].label.as_str(), extra[2].remaining_percent), ("3P 5h", 0));
        assert_eq!((extra[3].label.as_str(), extra[3].remaining_percent), ("3P Wk", 41));
        assert!(extra[3].reset_at.is_some());

        let (p3, e3) = parse_quota_groups(&json!({}));
        assert!(p3.is_empty() && e3.is_empty());
    }

    #[tokio::test]
    async fn guardrail1_short_circuits_missing_invalid_legacy_and_expiring_tokens_without_spawning() {
        let dir = tmp_dir("guard1");
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-27T10:00:00Z")
            .unwrap()
            .timestamp();
        let poison_exe = dir.join("must_not_spawn.exe");

        let missing = fetch_antigravity_quota_with_exe(
            "ag:m".into(),
            "M".into(),
            &dir.join("missing.json"),
            false,
            Some(&poison_exe),
            now,
        )
        .await;
        assert_eq!(missing.quota.status, "error");
        assert!(!missing.network_hit);

        let bad_json = dir.join("bad.json");
        fs::write(&bad_json, "{not-json").unwrap();
        let bad = fetch_antigravity_quota_with_exe(
            "ag:b".into(),
            "B".into(),
            &bad_json,
            false,
            Some(&poison_exe),
            now,
        )
        .await;
        assert_eq!(bad.quota.status, "error");
        assert!(!bad.network_hit);

        let legacy_acp = dir.join("acp_token.json");
        fs::write(&legacy_acp, r#"{"client_id":"c","refresh_token":"rt"}"#).unwrap();
        let leg = fetch_antigravity_quota_with_exe(
            "ag:leg".into(),
            "Legacy".into(),
            &legacy_acp,
            false,
            Some(&poison_exe),
            now,
        )
        .await;
        assert_eq!(leg.quota.status, "expired");
        assert!(!leg.network_hit);

        let soon = dir.join("soon-token");
        fs::write(
            &soon,
            r#"{"token":{"access_token":"tok","refresh_token":"rt","expiry":"2026-11-27T10:04:50Z"}}"#,
        )
        .unwrap();
        let idle_soon = fetch_antigravity_quota_with_exe(
            "ag:soon".into(),
            "Soon".into(),
            &soon,
            false,
            Some(&poison_exe),
            now,
        )
        .await;
        assert_eq!(idle_soon.quota.status, "idle");
        assert!(!idle_soon.network_hit);

        let no_rt = dir.join("no-rt");
        fs::write(
            &no_rt,
            r#"{"token":{"access_token":"","expiry":"2020-01-01T00:00:00Z"}}"#,
        )
        .unwrap();
        let exp = fetch_antigravity_quota_with_exe(
            "ag:nort".into(),
            "NoRT".into(),
            &no_rt,
            false,
            Some(&poison_exe),
            now,
        )
        .await;
        assert_eq!(exp.quota.status, "expired");
        assert!(!exp.network_hit);

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn guardrail2_isolated_mock_cli_verifies_canary_env_inst_id_benign_stderr_and_cleanup() {
        let dir = tmp_dir("guard2_ok");
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-27T10:00:00Z")
            .unwrap()
            .timestamp();
        let captured_home_file = dir.join("captured_home.txt");
        let captured_tok_file = dir.join("captured_tok.txt");
        let captured_env_file = dir.join("captured_env.txt");
        let captured_inst_file = dir.join("captured_inst.txt");

        // Mock agy 1.5.18: rejects the expired canary token (proving isolation) and succeeds
        // for the live token even while emitting benign "unauthenticated" plugin noise on stderr.
        let mock_exe = write_mock_agy(
            &dir,
            "mock_agy_ok",
            &format!(
                r#"if "%~1"=="--version" (
  echo 1.5.18
  exit /b 0
)
findstr /C:"deskcat-isolation-canary" "%USERPROFILE%\.gemini\antigravity-cli\antigravity-oauth-token" >nul 2>&1
if not errorlevel 1 (
  echo Authentication required. Please visit the URL to log in: 1>&2
  exit /b 1
)
> "{home}" echo %USERPROFILE%
> "{envf}" echo %AGY_CLI_FORCE_FILE_TOKEN_STORAGE%,%AGY_CLI_DISABLE_AUTO_UPDATE%,%SSH_CONNECTION%,%APPDATA%
type "%USERPROFILE%\.gemini\antigravity-cli\antigravity-oauth-token" > "{tok}"
type "%USERPROFILE%\.gemini\antigravity-cli\installation_id" > "{inst}"
echo W1127 plugin_auth: unauthenticated optional plugin ignored 1>&2
echo {{"conversation_id":"","status":"SUCCESS","num_turns":0,"command":{{"name":"usage","data":{{"groups":[{{"name":"Gemini Models","buckets":[{{"id":"gemini-5h","window":"5h","remaining_fraction":0.82,"reset_time":"2026-11-27T14:00:00Z"}},{{"id":"gemini-weekly","window":"weekly","remaining_fraction":0.64,"reset_time":"2026-12-03T10:00:00Z"}}]}},{{"name":"Claude and GPT models","buckets":[{{"id":"3p-5h","window":"5h","remaining_fraction":0.5,"reset_time":"2026-11-27T14:00:00Z"}}]}}]}}}}}}"#,
                home = captured_home_file.display(),
                envf = captured_env_file.display(),
                tok = captured_tok_file.display(),
                inst = captured_inst_file.display(),
            ),
            &format!(
                r#"if [ "$1" = "--version" ]; then echo "1.5.18"; exit 0; fi
if grep -q "deskcat-isolation-canary" "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"; then
  echo "Authentication required. Please visit the URL to log in:" >&2
  exit 1
fi
printf '%s' "$HOME" > "{home}"
printf '%s,%s,%s,%s' "$AGY_CLI_FORCE_FILE_TOKEN_STORAGE" "$AGY_CLI_DISABLE_AUTO_UPDATE" "$SSH_CONNECTION" "$APPDATA" > "{envf}"
cat "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" > "{tok}"
cat "$HOME/.gemini/antigravity-cli/installation_id" > "{inst}"
echo "W1127 plugin_auth: unauthenticated optional plugin ignored" >&2
printf '%s\n' '{{"conversation_id":"","status":"SUCCESS","num_turns":0,"command":{{"name":"usage","data":{{"groups":[{{"name":"Gemini Models","buckets":[{{"id":"gemini-5h","window":"5h","remaining_fraction":0.82,"reset_time":"2026-11-27T14:00:00Z"}},{{"id":"gemini-weekly","window":"weekly","remaining_fraction":0.64,"reset_time":"2026-12-03T10:00:00Z"}}]}},{{"name":"Claude and GPT models","buckets":[{{"id":"3p-5h","window":"5h","remaining_fraction":0.5,"reset_time":"2026-11-27T14:00:00Z"}}]}}]}}}}}}'"#,
                home = captured_home_file.display(),
                envf = captured_env_file.display(),
                tok = captured_tok_file.display(),
                inst = captured_inst_file.display(),
            ),
        );

        let acp_dir = dir.join("antigravity-acp");
        fs::create_dir_all(&acp_dir).unwrap();
        let tok_path = acp_dir.join("antigravity-oauth-token");
        fs::write(
            &tok_path,
            r#"{"token":{"access_token":"live_abc","refresh_token":"1//must_be_stripped","expiry":"2026-11-27T11:00:00Z"},"auth_method":"oauth-personal"}"#,
        )
        .unwrap();
        fs::write(acp_dir.join("installation_id"), "11111111-2222-3333-4444-555555555555").unwrap();

        let out = fetch_antigravity_quota_with_exe(
            "ag:test".into(),
            "TestAcc".into(),
            &tok_path,
            false,
            Some(&mock_exe),
            now,
        )
        .await;

        assert!(out.network_hit);
        assert_eq!(out.quota.status, "ok", "err={:?}", out.quota.error);
        assert_eq!(out.quota.effective_remaining, 64);
        assert_eq!(out.quota.primary_windows.len(), 2);
        assert_eq!(out.quota.extra_windows.len(), 1);

        let staged = fs::read_to_string(&captured_tok_file).unwrap();
        assert!(staged.contains("live_abc"));
        assert!(!staged.to_ascii_lowercase().contains("refresh"));
        assert!(!staged.contains("must_be_stripped"));

        let staged_inst = fs::read_to_string(&captured_inst_file).unwrap();
        assert_eq!(staged_inst.trim(), "11111111-2222-3333-4444-555555555555");

        let cap_home = PathBuf::from(fs::read_to_string(&captured_home_file).unwrap().trim());
        let env_line = fs::read_to_string(&captured_env_file).unwrap();
        assert!(env_line.trim().starts_with("1,true,127.0.0.1 0 127.0.0.1 0,"), "env={env_line}");
        assert!(env_line.contains("AppData"), "APPDATA must redirect into fake home: {env_line}");

        assert!(
            !cap_home.join(".gemini").join("antigravity-cli").join("antigravity-oauth-token").exists(),
            "staged token file must be deleted after probe"
        );
        assert!(
            !cap_home.parent().unwrap().exists(),
            "temp probe directory should be cleaned up"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn fails_closed_on_canary_leak_old_version_interactive_abort_and_model_turn() {
        let dir = tmp_dir("guard2_edge");
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-27T10:00:00Z")
            .unwrap()
            .timestamp();
        let tok_path = dir.join("antigravity-oauth-token");
        fs::write(
            &tok_path,
            r#"{"token":{"access_token":"live_abc","refresh_token":"rt","expiry":"2026-11-27T11:00:00Z"}}"#,
        )
        .unwrap();

        // 1. Old agy (< 1.5.16, e.g. 1.5.15) must be rejected without running /usage
        let old_exe = write_mock_agy(
            &dir,
            "mock_agy_old15",
            r#"if "%~1"=="--version" (echo 1.5.15 & exit /b 0)
exit /b 99"#,
            r#"if [ "$1" = "--version" ]; then echo "1.5.15"; exit 0; fi
exit 99"#,
        );
        let r_old = fetch_antigravity_quota_with_exe(
            "ag:old".into(),
            "Old".into(),
            &tok_path,
            false,
            Some(&old_exe),
            now,
        )
        .await;
        assert_eq!(r_old.quota.status, "error");
        assert!(!r_old.network_hit);

        // 2. Leaky agy that returns SUCCESS even for the expired canary token -> locked out
        //    permanently without ever staging or probing the real account token!
        let leak_exe = write_mock_agy(
            &dir,
            "mock_agy_leak",
            r#"if "%~1"=="--version" (echo 1.5.18 & exit /b 0)
echo {"conversation_id":"","status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-5h","window":"5h","remaining_fraction":0.9}]}]}}}"#,
            r#"if [ "$1" = "--version" ]; then echo "1.5.18"; exit 0; fi
echo '{"conversation_id":"","status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-5h","window":"5h","remaining_fraction":0.9}]}]}}}'"#,
        );
        let r_leak = fetch_antigravity_quota_with_exe(
            "ag:leak".into(),
            "Leak".into(),
            &tok_path,
            false,
            Some(&leak_exe),
            now,
        )
        .await;
        assert_eq!(r_leak.quota.status, "error");
        assert!(!r_leak.network_hit);

        // 3. Interactive sign-in on stderr for a valid non-expired token -> killed promptly
        //    and surfaced as `"error"` (NOT masked as `"idle"`).
        let auth_exe = write_mock_agy(
            &dir,
            "mock_agy_auth",
            r#"if "%~1"=="--version" (echo 1.5.18 & exit /b 0)
findstr /C:"deskcat-isolation-canary" "%USERPROFILE%\.gemini\antigravity-cli\antigravity-oauth-token" >nul 2>&1
if not errorlevel 1 (
  echo Authentication required. Please visit the URL to log in: 1>&2
  exit /b 1
)
echo Authentication required. Please visit the URL to log in: 1>&2
ping -n 15 127.0.0.1 > nul"#,
            r#"if [ "$1" = "--version" ]; then echo "1.5.18"; exit 0; fi
if grep -q "deskcat-isolation-canary" "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"; then
  echo "Authentication required. Please visit the URL to log in:" >&2
  exit 1
fi
echo "Authentication required. Please visit the URL to log in:" >&2
sleep 15"#,
        );
        let t0 = std::time::Instant::now();
        let r_auth = fetch_antigravity_quota_with_exe(
            "ag:auth".into(),
            "Auth".into(),
            &tok_path,
            false,
            Some(&auth_exe),
            now,
        )
        .await;
        assert_eq!(r_auth.quota.status, "error");
        assert!(
            t0.elapsed() < Duration::from_secs(6),
            "interactive sign-in must be killed immediately, took {:?}",
            t0.elapsed()
        );

        // 4. Model turn fallback (`num_turns: 1`) -> latches exe permanently so 2nd call does 0 network
        let turn_exe = write_mock_agy(
            &dir,
            "mock_agy_turn",
            r#"if "%~1"=="--version" (echo 1.5.18 & exit /b 0)
findstr /C:"deskcat-isolation-canary" "%USERPROFILE%\.gemini\antigravity-cli\antigravity-oauth-token" >nul 2>&1
if not errorlevel 1 (
  echo Authentication required. Please visit the URL to log in: 1>&2
  exit /b 1
)
echo {"conversation_id":"conv-1","num_turns":1,"status":"SUCCESS"}"#,
            r#"if [ "$1" = "--version" ]; then echo "1.5.18"; exit 0; fi
if grep -q "deskcat-isolation-canary" "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"; then
  echo "Authentication required. Please visit the URL to log in:" >&2
  exit 1
fi
echo '{"conversation_id":"conv-1","num_turns":1,"status":"SUCCESS"}'"#,
        );
        let r_t1 = fetch_antigravity_quota_with_exe(
            "ag:t1".into(),
            "Turn".into(),
            &tok_path,
            false,
            Some(&turn_exe),
            now,
        )
        .await;
        assert_eq!(r_t1.quota.status, "error");
        assert!(r_t1.network_hit);

        let r_t2 = fetch_antigravity_quota_with_exe(
            "ag:t1".into(),
            "Turn".into(),
            &tok_path,
            false,
            Some(&turn_exe),
            now,
        )
        .await;
        assert_eq!(r_t2.quota.status, "error");
        assert!(!r_t2.network_hit, "latched exe must short-circuit locally on subsequent calls");

        // 5. Silent-exit canary (no output, no explicit auth rejection) -> MUST fail closed
        //    and NOT cache pass, so real token is never staged/probed.
        let silent_canary_exe = write_mock_agy(
            &dir,
            "mock_agy_silent_canary",
            r#"if "%~1"=="--version" (echo 1.5.18 & exit /b 0)
findstr /C:"deskcat-isolation-canary" "%USERPROFILE%\.gemini\antigravity-cli\antigravity-oauth-token" >nul 2>&1
if not errorlevel 1 (
  exit /b 1
)
echo {"conversation_id":"","status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-5h","window":"5h","remaining_fraction":0.9}]}]}}}"#,
            r#"if [ "$1" = "--version" ]; then echo "1.5.18"; exit 0; fi
if grep -q "deskcat-isolation-canary" "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"; then
  exit 1
fi
echo '{"conversation_id":"","status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-5h","window":"5h","remaining_fraction":0.9}]}]}}}'"#,
        );
        let r_silent = fetch_antigravity_quota_with_exe(
            "ag:silent".into(),
            "Silent".into(),
            &tok_path,
            false,
            Some(&silent_canary_exe),
            now,
        )
        .await;
        assert_eq!(r_silent.quota.status, "error");
        assert!(!r_silent.network_hit, "unconfirmed canary must fail closed without probing real token");

        let _ = fs::remove_dir_all(&dir);
    }
}
