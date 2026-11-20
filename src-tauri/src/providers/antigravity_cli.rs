//! Antigravity quota from the official `agy` CLI, for machines without T3 Code.
//!
//! `agy -p /usage --output-format json` (non-interactive usage report, agy 1.1.11+)
//! prints the signed-in account's quota buckets. DeskCat never touches the sign-in
//! itself, which agy keeps in the OS keyring (Windows target `gemini:antigravity`).

use crate::models::{AccountQuota, ProviderKind};
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
#[cfg(windows)]
pub fn has_signin() -> bool {
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
pub fn has_signin() -> bool {
    // macOS / Linux keyrings are not probed; assume signed in when agy is installed.
    true
}

pub async fn fetch_antigravity_cli_quota(id: String, name: String, exe: &Path) -> AccountQuota {
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
        Err(_) => return error(id, name, now, "error", "agy 回應逾時".to_string()),
        Ok(Err(err)) => return error(id, name, now, "error", format!("無法執行 agy：{err}")),
        Ok(Ok(o)) => o,
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    match parse_report(&stdout) {
        Ok((primary, extra)) => {
            let effective = primary.iter().map(|w| w.remaining_percent).min().unwrap_or(0);
            AccountQuota {
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
            }
        }
        Err(msg) => {
            let lower = format!("{msg} {}", String::from_utf8_lossy(&output.stderr)).to_lowercase();
            let status = if lower.contains("sign in") || lower.contains("login") || lower.contains("auth") {
                "expired"
            } else {
                "error"
            };
            error(id, name, now, status, msg)
        }
    }
}

type Windows = (Vec<crate::models::QuotaWindow>, Vec<crate::models::QuotaWindow>);

fn parse_report(stdout: &str) -> Result<Windows, String> {
    let start = stdout.find('{').ok_or_else(|| "agy 沒有輸出用量報告".to_string())?;
    let v: Value = serde_json::from_str(stdout[start..].trim())
        .map_err(|e| format!("agy 用量報告格式無法解析：{e}"))?;
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
        .ok_or_else(|| "agy 用量報告缺少資料".to_string())?;
    let (primary, extra) = super::antigravity::parse_quota_groups(data);
    if primary.is_empty() && extra.is_empty() {
        return Err("agy 用量報告沒有可用的額度".to_string());
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
    fn reports_failure() {
        assert!(parse_report(r#"{"status":"ERROR","error":"not signed in"}"#).is_err());
        assert!(parse_report("").is_err());
    }
}
