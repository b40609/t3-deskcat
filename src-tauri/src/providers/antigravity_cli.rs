//! Antigravity quota from the official `agy` CLI, for machines without T3 Code.
//!
//! `agy -p /usage --output-format json` (non-interactive usage report, agy 1.1.11+)
//! prints the signed-in account's quota buckets. DeskCat never touches the sign-in
//! itself, which agy keeps in the OS keyring (Windows target `gemini:antigravity`).

use crate::models::{AccountQuota, ProviderKind};
use crate::providers::FetchOutcome;
use chrono::Utc;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(90);

/// `ANTIGRAVITY_CLI_PATH`, the default install folder, or `agy` on PATH.
pub fn find_agy() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("ANTIGRAVITY_CLI_PATH") {
        let p = PathBuf::from(p.trim());
        // An explicit override is authoritative, even when it is wrong.
        return p.is_file().then_some(p);
    }
    let exe = if cfg!(windows) { "agy.exe" } else { "agy" };
    if let Some(local) = dirs::data_local_dir() {
        let p = local.join("agy").join("bin").join(exe);
        if p.is_file() {
            return Some(p);
        }
    }
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|d| d.join(exe))
            .find(|p| p.is_file())
    })
}

/// Whether agy has a stored sign-in. Checked first so a signed-out agy is never
/// started in the background (it would try to open a browser to sign in).
///
/// With `AGY_CLI_FORCE_FILE_TOKEN_STORAGE` set (inherited by the agy we spawn), agy reads
/// only its file token store and ignores the keyring, so a leftover keyring entry must not
/// count: otherwise every probe reports "not logged in" and starts an OAuth flow.
pub fn has_signin() -> bool {
    if force_file_token_storage(std::env::var("AGY_CLI_FORCE_FILE_TOKEN_STORAGE").ok().as_deref()) {
        return dirs::home_dir().is_some_and(|home| has_file_token(&home));
    }
    has_keyring_signin()
}

fn force_file_token_storage(raw: Option<&str>) -> bool {
    raw.map(|v| v.trim().to_ascii_lowercase())
        .is_some_and(|v| !v.is_empty() && !matches!(v.as_str(), "0" | "false" | "no" | "off"))
}

/// agy's file token store lives in `~/.gemini/antigravity-cli/` as `*-oauth-token`.
/// Only file names are checked; contents are never read.
fn has_file_token(home: &Path) -> bool {
    let dir = home.join(".gemini").join("antigravity-cli");
    std::fs::read_dir(dir).is_ok_and(|rd| {
        rd.flatten().any(|e| {
            e.file_type().is_ok_and(|t| t.is_file())
                && e.file_name().to_string_lossy().ends_with("-oauth-token")
        })
    })
}

#[cfg(windows)]
fn has_keyring_signin() -> bool {
    use windows_sys::Win32::Security::Credentials::{CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC};
    let target: Vec<u16> = "gemini:antigravity".encode_utf16().chain(Some(0)).collect();
    let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
    // Only the existence of the entry is used; its contents are not read.
    let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) } != 0;
    if ok && !cred.is_null() {
        unsafe { CredFree(cred as *const _) };
    }
    ok
}

#[cfg(not(windows))]
fn has_keyring_signin() -> bool {
    // macOS / Linux keyrings are not probed; assume signed in when agy is installed.
    true
}

pub async fn fetch_antigravity_cli_quota(id: String, name: String, exe: &Path) -> FetchOutcome {
    let now = Utc::now().timestamp();
    // Run in a private empty folder so agy picks up no project rules or MCP config.
    let work = dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("t3-deskcat")
        .join("agy-probe");
    let _ = std::fs::create_dir_all(&work);

    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(["-p", "/usage", "--output-format", "json"])
        .current_dir(&work)
        // Background probes must not trigger CLI self-updates (lowercase "true" is required).
        .env("AGY_CLI_DISABLE_AUTO_UPDATE", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = match tokio::time::timeout(TIMEOUT, cmd.output()).await {
        Err(_) => return FetchOutcome::network(error(id, name, now, "error", crate::tr!("agy 回應逾時"))),
        Ok(Err(err)) => {
            return FetchOutcome::network(error(
                id,
                name,
                now,
                "error",
                crate::tr!("無法執行 agy：{err}", err = err),
            ))
        }
        Ok(Ok(o)) => o,
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    match parse_report(&stdout) {
        Ok((primary, extra)) => {
            let effective = primary.iter().map(|w| w.remaining_percent).min().unwrap_or(0);
            FetchOutcome::network(AccountQuota {
                id,
                provider: ProviderKind::Antigravity,
                name,
                plan: None,
                effective_remaining: effective,
                primary_windows: primary,
                extra_windows: extra,
                status: "ok".to_string(),
                error: None,
                updated_at: now,
            })
        }
        Err(msg) => {
            let lower = format!("{msg} {}", String::from_utf8_lossy(&output.stderr)).to_lowercase();
            let status = if lower.contains("sign in") || lower.contains("login") || lower.contains("auth") {
                "expired"
            } else if lower.contains("429") || lower.contains("rate limit") || lower.contains("resource_exhausted") {
                "cooldown"
            } else {
                "error"
            };
            FetchOutcome::network(error(id, name, now, status, msg))
        }
    }
}

type Windows = (Vec<crate::models::QuotaWindow>, Vec<crate::models::QuotaWindow>);

fn parse_report(stdout: &str) -> Result<Windows, String> {
    let start = stdout.find('{').ok_or_else(|| crate::tr!("agy 沒有輸出用量報告"))?;
    let v: Value = serde_json::from_str(stdout[start..].trim())
        .map_err(|e| crate::tr!("agy 用量報告格式無法解析：{e}", e = e))?;
    if v.get("status").and_then(Value::as_str) != Some("SUCCESS") {
        let detail = v
            .get("error")
            .or_else(|| v.get("response"))
            .and_then(Value::as_str)
            .unwrap_or("agy 回報失敗，請在終端機執行 agy 確認已登入");
        return Err(detail.chars().take(200).collect());
    }
    let data = v
        .pointer("/command/data")
        .ok_or_else(|| crate::tr!("agy 用量報告缺少資料"))?;
    let (primary, extra) = super::antigravity::parse_quota_groups(data);
    if primary.is_empty() && extra.is_empty() {
        return Err(crate::tr!("agy 用量報告沒有可用的額度"));
    }
    Ok((primary, extra))
}

fn error(id: String, name: String, now: i64, status: &str, msg: String) -> AccountQuota {
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

    // Shape of `agy -p /usage --output-format json` from agy 1.5.13 (2026-11-20).
    const SAMPLE: &str = r#"{"conversation_id":"","status":"SUCCESS","response":"...","command":{"name":"usage","data":{"groups":[
      {"name":"Gemini Models","buckets":[
        {"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.535,"reset_time":"2026-11-25T01:11:01Z"},
        {"id":"gemini-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":0.96,"reset_time":"2026-11-20T13:37:30Z"}]},
      {"name":"Claude and GPT models","buckets":[
        {"id":"3p-weekly","window":"weekly","remaining_fraction":1,"reset_time":"2026-11-27T09:32:17Z"},
        {"id":"3p-5h","window":"5h","remaining_fraction":1,"reset_time":"2026-11-20T14:32:17Z"}]}]}}}"#;

    #[test]
    fn parses_agy_usage_report() {
        let (primary, extra) = parse_report(SAMPLE).unwrap();
        let p: Vec<(String, i32)> = primary.iter().map(|w| (w.label.clone(), w.remaining_percent)).collect();
        assert_eq!(p, vec![("5h".into(), 96), ("Wk".into(), 54)]);
        assert_eq!(extra.len(), 2);
        assert!(extra.iter().all(|w| w.label.starts_with("3P ") && w.remaining_percent == 100));
        assert!(primary[0].reset_at.is_some());
    }

    #[test]
    fn file_token_storage_flag_and_detection() {
        assert!(force_file_token_storage(Some("1")));
        assert!(force_file_token_storage(Some("true")));
        assert!(!force_file_token_storage(Some("0")));
        assert!(!force_file_token_storage(Some(" false ")));
        assert!(!force_file_token_storage(Some("")));
        assert!(!force_file_token_storage(None));

        let tmp = std::env::temp_dir().join(format!("dc-agy-filetoken-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let dir = tmp.join(".gemini").join("antigravity-cli");
        std::fs::create_dir_all(dir.join("brain")).unwrap();
        std::fs::write(dir.join("settings.json"), "{}").unwrap();
        // Keyring-only sign-in leaves no file token: agy under the flag is signed out.
        assert!(!has_file_token(&tmp));
        std::fs::write(dir.join("antigravity-cli-oauth-token"), "{}").unwrap();
        assert!(has_file_token(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn reports_failure() {
        assert!(parse_report(r#"{"status":"ERROR","error":"not signed in"}"#).is_err());
        assert!(parse_report("").is_err());
    }
}
