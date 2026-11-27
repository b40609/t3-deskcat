//! Antigravity quota via the official `agy` CLI (`agy -p /usage --output-format json`).
//!
//! Used in two modes:
//! 1. `AgyProbeMode::Standalone`: queries the standalone `agy` CLI's own sign-in
//!    (kept in the OS keyring or `~/.gemini/antigravity-cli/*-oauth-token`).
//!    Note: zero-background-refresh guarantees apply to the T3 isolated path below;
//!    standalone mode delegates directly to the user's own `agy` CLI sign-in.
//! 2. `AgyProbeMode::IsolatedHome(fake_home)`: queries a single T3 Code Antigravity
//!    instance inside a clean temporary home directory with file-only token storage
//!    (`AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` + `SSH_CONNECTION`), redirected `APPDATA`/
//!    `LOCALAPPDATA`/`XDG_*`, and a fail-closed canary self-check so it never falls
//!    back to the shared OS keyring, user hooks/MCP config, or Google's internal HTTP APIs.

use crate::models::{AccountQuota, ProviderKind};
use crate::providers::FetchOutcome;
use chrono::Utc;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_OUTPUT_BYTES: usize = 512 * 1024;

/// Before agy 1.1.11, `/usage` in print mode ran as a billed model turn.
pub(crate) const MIN_STANDALONE_VERSION: (u64, u64, u64) = (1, 1, 11);
/// `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` (verified keyring isolation on Windows/macOS/Linux)
/// requires agy >= 1.5.16.
pub(crate) const MIN_ISOLATED_VERSION: (u64, u64, u64) = (1, 5, 16);

const INTERACTIVE_SIGN_IN_MARKERS: &[&str] = &[
    "authentication required",
    "please visit the url",
    "accounts.google.com/o/oauth2",
];

const SIGNED_OUT_PHRASES: &[&str] = &[
    "not logged into antigravity",
    "not logged in",
    "not signed in",
    "not authenticated",
    "not-authenticated",
    "unauthenticated",
    "run agy login",
    "please sign in",
    "please log in",
    "sign in to antigravity",
    "no credentials",
    "authentication required",
];

/// Environment keys stripped before launching `agy` in isolated mode so ambient
/// API keys, proxy/project overrides, hooks, ADC paths, or other profiles cannot leak in.
const ISOLATED_STRIPPED_KEYS: &[&str] = &[
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GCLOUD_PROJECT",
    "CLOUDSDK_CORE_PROJECT",
    "GEMINI_HOME",
    "BROWSER",
    "ELECTRON_RUN_AS_NODE",
    "CHROME_CRASHPAD_PIPE_NAME",
    "SSH_CONNECTION",
    "SSH_CLIENT",
    "SSH_TTY",
    "SSH_AUTH_SOCK",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
];

/// Probe execution mode for `agy -p /usage`.
#[derive(Debug, Clone)]
pub(crate) enum AgyProbeMode {
    /// Standalone `agy` CLI using the user's normal environment / OS keyring.
    Standalone,
    /// Fully isolated fake home directory (for T3 multi-account instances).
    /// Forces file-only token storage and strips ambient credentials/hooks/MCPs.
    IsolatedHome(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct ExeFingerprint {
    path: PathBuf,
    mtime_secs: u64,
    size: u64,
}

pub(crate) fn exe_fingerprint(exe: &Path) -> ExeFingerprint {
    let canonical = fs::canonicalize(exe).unwrap_or_else(|_| exe.to_path_buf());
    let meta = fs::metadata(&canonical).ok();
    let mtime_secs = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    ExeFingerprint {
        path: canonical,
        mtime_secs,
        size,
    }
}

fn version_cache() -> &'static Mutex<HashMap<ExeFingerprint, (u64, u64, u64)>> {
    static CACHE: OnceLock<Mutex<HashMap<ExeFingerprint, (u64, u64, u64)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn latched_model_turn_exes() -> &'static Mutex<HashSet<ExeFingerprint>> {
    static LATCH: OnceLock<Mutex<HashSet<ExeFingerprint>>> = OnceLock::new();
    LATCH.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Fail-closed isolation self-check cache per binary fingerprint:
/// `Some(true)` = canary failed auth as expected (isolated);
/// `Some(false)` = canary unexpectedly returned SUCCESS (leaked keyring/other creds -> locked out).
fn isolation_canary_cache() -> &'static Mutex<HashMap<ExeFingerprint, bool>> {
    static CANARY: OnceLock<Mutex<HashMap<ExeFingerprint, bool>>> = OnceLock::new();
    CANARY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_latched_model_turn(fp: &ExeFingerprint) -> bool {
    latched_model_turn_exes()
        .lock()
        .map(|set| set.contains(fp))
        .unwrap_or(false)
}

fn latch_model_turn(fp: ExeFingerprint) {
    if let Ok(mut set) = latched_model_turn_exes().lock() {
        set.insert(fp);
    }
}

/// `ANTIGRAVITY_CLI_PATH`, the default install folder, or `agy` on PATH.
pub fn find_agy() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("ANTIGRAVITY_CLI_PATH") {
        let p = PathBuf::from(p.trim());
        // An explicit override is authoritative, even when it is wrong or empty.
        return p.is_file().then_some(p);
    }
    find_agy_installed_or_path()
}

/// Locates `agy` for T3 Code instances:
/// 1. `ANTIGRAVITY_CLI_PATH` (explicit override, authoritative even if invalid/empty)
/// 2. T3 Code's managed `agy` runtime (`~/.t3/tools/antigravity-acp/<platform>/...`)
/// 3. Custom `binaryPath` configured in T3 Code `userdata/settings.json`
/// 4. Standalone install folder (`%LOCALAPPDATA%\agy\bin\agy.exe`) or `PATH`
pub fn find_agy_for_t3() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("ANTIGRAVITY_CLI_PATH") {
        let p = PathBuf::from(p.trim());
        return p.is_file().then_some(p);
    }
    if let Some(home) = dirs::home_dir() {
        let t3_home = resolve_t3_home(&home);
        if let Some(managed) = find_t3_managed_agy_in(&t3_home) {
            return Some(managed);
        }
        if let Some(custom) = find_t3_settings_agy_in(&home, &t3_home) {
            return Some(custom);
        }
    }
    find_agy_installed_or_path()
}

fn find_agy_installed_or_path() -> Option<PathBuf> {
    let exe = agy_exe_name();
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

fn agy_exe_name() -> &'static str {
    if cfg!(windows) {
        "agy.exe"
    } else {
        "agy"
    }
}

fn t3_platform_dir() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "win32-x64"
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        "win32-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-arm64"
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    {
        "unknown"
    }
}

fn expand_tilde(home: &Path, raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        return home.join(rest);
    }
    PathBuf::from(trimmed)
}

fn resolve_t3_home(home: &Path) -> PathBuf {
    std::env::var("T3CODE_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| expand_tilde(home, &s))
        .unwrap_or_else(|| home.join(".t3"))
}

fn find_t3_managed_agy_in(t3_home: &Path) -> Option<PathBuf> {
    let base = t3_home
        .join("tools")
        .join("antigravity-acp")
        .join(t3_platform_dir());
    let exe_name = agy_exe_name();
    let versions_dir = base.join("versions");

    // 1. Prefer the active release pointed to by active.json.
    if let Ok(raw) = fs::read_to_string(base.join("active.json")) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            if let Some(rel) = v
                .get("releaseId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty() && !s.contains(['/', '\\']) && *s != "." && *s != "..")
            {
                let candidate = versions_dir.join(rel).join(exe_name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    // 2. Fallback: newest completed version under versions/.
    let mut best: Option<(SystemTime, PathBuf)> = None;
    if let Ok(rd) = fs::read_dir(&versions_dir) {
        for ent in rd.flatten() {
            let dir = ent.path();
            if !dir.is_dir() || !dir.join(".install-complete.json").is_file() {
                continue;
            }
            let candidate = dir.join(exe_name);
            if !candidate.is_file() {
                continue;
            }
            let mtime = fs::metadata(&candidate)
                .and_then(|m| m.modified())
                .unwrap_or(UNIX_EPOCH);
            if best.as_ref().is_none_or(|(prev, _)| mtime > *prev) {
                best = Some((mtime, candidate));
            }
        }
    }
    best.map(|(_, p)| p)
}

fn find_t3_settings_agy_in(home: &Path, t3_home: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(t3_home.join("userdata").join("settings.json")).ok()?;
    let json: Value = serde_json::from_str(&raw).ok()?;
    let instances = json.get("providerInstances")?.as_object()?;
    for cfg in instances.values() {
        if cfg.get("driver").and_then(Value::as_str) != Some("antigravity") {
            continue;
        }
        if let Some(bin) = cfg
            .get("config")
            .and_then(|c| c.get("binaryPath"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let p = expand_tilde(home, bin);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Whether agy has a stored sign-in. Checked first so a signed-out agy is never
/// started in the background (it would try to open a browser to sign in).
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
    fs::read_dir(dir).is_ok_and(|rd| {
        rd.flatten().any(|e| {
            e.file_type().is_ok_and(|t| t.is_file())
                && e.file_name().to_string_lossy().ends_with("-oauth-token")
        })
    })
}

#[cfg(windows)]
fn has_keyring_signin() -> bool {
    use windows_sys::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };
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

/// Extracts the first `major.minor.patch` semver triple from `agy --version` output.
pub(crate) fn parse_semver(raw: &str) -> Option<(u64, u64, u64)> {
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() && (i == 0 || !bytes[i - 1].is_ascii_digit()) {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b'.' {
                let maj_end = i;
                i += 1;
                let min_start = i;
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                if i > min_start && i < bytes.len() && bytes[i] == b'.' {
                    let min_end = i;
                    i += 1;
                    let pat_start = i;
                    while i < bytes.len() && bytes[i].is_ascii_digit() {
                        i += 1;
                    }
                    if i > pat_start && (i == bytes.len() || !bytes[i].is_ascii_digit()) {
                        let major = raw[start..maj_end].parse::<u64>().ok()?;
                        let minor = raw[min_start..min_end].parse::<u64>().ok()?;
                        let patch = raw[pat_start..i].parse::<u64>().ok()?;
                        return Some((major, minor, patch));
                    }
                }
            }
            continue;
        }
        i += 1;
    }
    None
}

fn should_strip_isolated_env_key(upper: &str) -> bool {
    ISOLATED_STRIPPED_KEYS.contains(&upper)
        || upper.starts_with("ANTIGRAVITY_")
        || upper.starts_with("AGY_")
}

/// Builds the sanitized environment map for an isolated fake-home probe.
/// Redirects `USERPROFILE`/`HOME`, `HOMEDRIVE`/`HOMEPATH`, `APPDATA`/`LOCALAPPDATA`,
/// and `XDG_*` into `fake_home`, preventing leakage of keyring, hooks, MCPs, or gcloud ADC.
pub(crate) fn build_isolated_env(
    base_env: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
    fake_home: &Path,
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let mut env: Vec<(std::ffi::OsString, std::ffi::OsString)> = base_env
        .into_iter()
        .filter(|(k, _)| {
            let upper = k.to_string_lossy().to_ascii_uppercase();
            !should_strip_isolated_env_key(&upper)
        })
        .collect();

    let clean_home_str = {
        let s = fake_home.to_string_lossy();
        s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
    };
    let clean_home = PathBuf::from(&clean_home_str);

    env.push(("USERPROFILE".into(), clean_home_str.clone().into()));
    env.push(("HOME".into(), clean_home_str.clone().into()));
    env.push(("XDG_CONFIG_HOME".into(), clean_home.join(".config").into_os_string()));
    env.push((
        "XDG_DATA_HOME".into(),
        clean_home.join(".local").join("share").into_os_string(),
    ));
    env.push(("XDG_CACHE_HOME".into(), clean_home.join(".cache").into_os_string()));
    env.push((
        "XDG_STATE_HOME".into(),
        clean_home.join(".local").join("state").into_os_string(),
    ));
    env.push((
        "APPDATA".into(),
        clean_home.join("AppData").join("Roaming").into_os_string(),
    ));
    env.push((
        "LOCALAPPDATA".into(),
        clean_home.join("AppData").join("Local").into_os_string(),
    ));

    #[cfg(windows)]
    {
        let bytes = clean_home_str.as_bytes();
        if bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/')
        {
            env.push(("HOMEDRIVE".into(), clean_home_str[..2].into()));
            env.push(("HOMEPATH".into(), clean_home_str[2..].into()));
        }
    }

    // Force file-only token storage (agy >= 1.5.16) and suppress interactive browser pops.
    env.push(("AGY_CLI_FORCE_FILE_TOKEN_STORAGE".into(), "1".into()));
    env.push(("SSH_CONNECTION".into(), "127.0.0.1 0 127.0.0.1 0".into()));
    // Lowercase "true" is required to suppress background self-updates.
    env.push(("AGY_CLI_DISABLE_AUTO_UPDATE".into(), "true".into()));
    env
}

fn configure_command_env(cmd: &mut tokio::process::Command, mode: &AgyProbeMode) {
    match mode {
        AgyProbeMode::Standalone => {
            // Keep the user's normal home / keyring env, but suppress auto-updates and browsers.
            cmd.env_remove("BROWSER")
                .env_remove("ELECTRON_RUN_AS_NODE")
                .env("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
        }
        AgyProbeMode::IsolatedHome(fake_home) => {
            cmd.env_clear();
            for (k, v) in build_isolated_env(std::env::vars_os(), fake_home) {
                cmd.env(k, v);
            }
        }
    }
}

/// Best-effort process-tree kill so grandchild language-server helpers do not linger
/// or keep directory/pipe handles open after timeout or early auth-abort.
async fn terminate_child_tree(child: &mut tokio::process::Child) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut tk = tokio::process::Command::new("taskkill");
        tk.args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        let _ = tokio::time::timeout(Duration::from_secs(2), tk.status()).await;
    }
    let _ = child.kill().await;
}

async fn check_agy_version(
    exe: &Path,
    fp: &ExeFingerprint,
    mode: &AgyProbeMode,
    work_dir: &Path,
) -> Result<(u64, u64, u64), String> {
    if let Ok(cache) = version_cache().lock() {
        if let Some(&ver) = cache.get(fp) {
            return Ok(ver);
        }
    }

    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("--version")
        .current_dir(work_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_command_env(&mut cmd, mode);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = tokio::time::timeout(VERSION_TIMEOUT, cmd.output())
        .await
        .map_err(|_| crate::tr!("無法確認 agy CLI 版本，請稍後重試"))?
        .map_err(|err| crate::tr!("無法執行 agy：{err}", err = err))?;

    if !output.status.success() {
        return Err(crate::tr!("無法確認 agy CLI 版本，請稍後重試"));
    }
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let ver = parse_semver(&combined)
        .ok_or_else(|| crate::tr!("無法確認 agy CLI 版本，請稍後重試"))?;

    if let Ok(mut cache) = version_cache().lock() {
        cache.insert(fp.clone(), ver);
    }
    Ok(ver)
}

struct SubprocessRun {
    stdout: String,
    stderr: String,
    auth_hit: bool,
    timed_out: bool,
}

async fn spawn_usage_subprocess(
    exe: &Path,
    mode: &AgyProbeMode,
    work_dir: &Path,
) -> Result<SubprocessRun, String> {
    let mut cmd = tokio::process::Command::new(exe);
    match mode {
        AgyProbeMode::Standalone => {
            // Standalone supports agy >= 1.1.11; avoid flags only verified on 1.5.16+.
            cmd.args(["-p", "/usage", "--output-format", "json"]);
        }
        AgyProbeMode::IsolatedHome(_) => {
            let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
            cmd.args([
                "-p",
                "/usage",
                "--output-format",
                "json",
                "--print-timeout",
                "20s",
                "--log-file",
                null_device,
            ]);
        }
    }
    cmd.current_dir(work_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_command_env(&mut cmd, mode);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|err| crate::tr!("無法執行 agy：{err}", err = err))?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let auth_hit = Arc::new(AtomicBool::new(false));
    let kill_notify = Arc::new(Notify::new());

    let stdout_task = tokio::spawn(async move {
        match stdout_pipe {
            Some(r) => read_capped_stream(r, MAX_OUTPUT_BYTES, None).await,
            None => String::new(),
        }
    });
    let stderr_task = {
        let hit = auth_hit.clone();
        let notify = kill_notify.clone();
        tokio::spawn(async move {
            match stderr_pipe {
                Some(r) => read_capped_stream(r, MAX_OUTPUT_BYTES, Some((hit, notify))).await,
                None => String::new(),
            }
        })
    };

    let mut timed_out = false;
    let wait_res = tokio::time::timeout(PROBE_TIMEOUT, async {
        tokio::select! {
            _ = child.wait() => {}
            _ = kill_notify.notified() => {
                terminate_child_tree(&mut child).await;
            }
        }
    })
    .await;

    if wait_res.is_err() {
        timed_out = true;
        terminate_child_tree(&mut child).await;
    }

    let stdout = tokio::time::timeout(PIPE_DRAIN_TIMEOUT, stdout_task)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    let stderr = tokio::time::timeout(PIPE_DRAIN_TIMEOUT, stderr_task)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();

    Ok(SubprocessRun {
        stdout,
        stderr,
        auth_hit: auth_hit.load(Ordering::SeqCst),
        timed_out,
    })
}

/// Pre-flight checks executed BEFORE staging any real account token on disk:
/// 1. Model-turn billing latch check.
/// 2. Version check (`>= 1.5.16`).
/// 3. One-time fail-closed isolation canary check per binary fingerprint:
///    stages a synthetic expired token (no `refresh_token`) in a clean fake home and
///    verifies `agy -p /usage` does NOT return `SUCCESS` (which would prove it ignored
///    `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` and leaked the OS keyring).
pub(crate) async fn ensure_isolated_probe_ready(exe: &Path) -> Result<(), String> {
    let fp = exe_fingerprint(exe);
    if is_latched_model_turn(&fp) {
        return Err(crate::tr!(
            "agy CLI 未將 /usage 視為額度查詢，已停用背景輪詢以避免扣費"
        ));
    }

    // Fast path if this exact binary already passed/failed the canary self-check.
    if let Ok(map) = isolation_canary_cache().lock() {
        if let Some(&passed) = map.get(&fp) {
            return if passed {
                Ok(())
            } else {
                Err(crate::tr!(
                    "agy 隔離自檢失敗：可能讀到系統金鑰圈，已停用隔離探測"
                ))
            };
        }
    }

    // Stage an isolated fake home with ONLY a synthetic expired canary token (no real secrets).
    let canary_json = r#"{"token":{"access_token":"deskcat-isolation-canary","token_type":"Bearer","expiry":"2020-01-01T00:00:00Z"},"auth_method":"oauth-personal"}"#;
    let canary_dir = super::antigravity::TempProbeDir::create(canary_json, None)?;
    let mode = AgyProbeMode::IsolatedHome(canary_dir.home.clone());

    let ver_res = check_agy_version(exe, &fp, &mode, &canary_dir.work).await;
    let ver = match ver_res {
        Ok(v) => v,
        Err(msg) => {
            canary_dir.cleanup().await;
            return Err(msg);
        }
    };
    if ver < MIN_ISOLATED_VERSION {
        canary_dir.cleanup().await;
        let min_str = format!(
            "{}.{}.{}",
            MIN_ISOLATED_VERSION.0, MIN_ISOLATED_VERSION.1, MIN_ISOLATED_VERSION.2
        );
        return Err(crate::tr!(
            "agy CLI 版本過舊（需要 {min} 以上），無法安全讀取額度",
            min = min_str
        ));
    }

    let run = match spawn_usage_subprocess(exe, &mode, &canary_dir.work).await {
        Ok(r) => r,
        Err(msg) => {
            canary_dir.cleanup().await;
            return Err(msg);
        }
    };
    canary_dir.cleanup().await;

    if output_shows_model_turn(&run.stdout) {
        latch_model_turn(fp);
        return Err(crate::tr!(
            "agy CLI 未將 /usage 視為額度查詢，已停用背景輪詢以避免扣費"
        ));
    }

    // Strict 3-state fail-closed verdict:
    // 1. Canary unexpectedly produced SUCCESS -> leaked OS keyring / external creds -> lock out permanently.
    // 2. Canary produced explicit auth rejection (not timeout) -> isolation verified -> cache true.
    // 3. Anything else (timeout, silent exit, transient error) -> do NOT cache; fail closed and retry later.
    if parse_report_at(&run.stdout, None).is_ok() {
        if let Ok(mut map) = isolation_canary_cache().lock() {
            map.insert(fp, false);
        }
        return Err(crate::tr!(
            "agy 隔離自檢失敗：可能讀到系統金鑰圈，已停用隔離探測"
        ));
    }

    let explicitly_rejected = !run.timed_out
        && (run.auth_hit
            || output_looks_signed_out(&run.stdout)
            || output_looks_signed_out(&run.stderr));
    if !explicitly_rejected {
        return Err(crate::tr!(
            "agy 隔離自檢未確認拒絕（可能逾時或無回應），稍後重試"
        ));
    }

    if let Ok(mut map) = isolation_canary_cache().lock() {
        map.insert(fp, true);
    }
    Ok(())
}

async fn read_capped_stream<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    max_bytes: usize,
    auth_hit: Option<(Arc<AtomicBool>, Arc<Notify>)>,
) -> String {
    let mut collected = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                if collected.len() < max_bytes {
                    let take = n.min(max_bytes - collected.len());
                    collected.extend_from_slice(&chunk[..take]);
                }
                if let Some((ref hit, ref notify)) = auth_hit {
                    if !hit.load(Ordering::Relaxed) {
                        let text = String::from_utf8_lossy(&collected);
                        if contains_interactive_signin(&text) {
                            hit.store(true, Ordering::SeqCst);
                            notify.notify_one();
                        }
                    }
                }
            }
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&collected).into_owned()
}

fn contains_interactive_signin(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    INTERACTIVE_SIGN_IN_MARKERS.iter().any(|m| lower.contains(m))
}

fn output_looks_signed_out(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    if SIGNED_OUT_PHRASES.iter().any(|p| lower.contains(p)) {
        return true;
    }
    for line in text.lines() {
        if let Some(idx) = line.find("AGY_ERROR:") {
            let tail = line[idx + "AGY_ERROR:".len()..].trim();
            if let Ok(v) = serde_json::from_str::<Value>(tail) {
                let status_unauth = v
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.eq_ignore_ascii_case("UNAUTHENTICATED"));
                let code_401 = v.get("error_code").and_then(Value::as_i64) == Some(401);
                if status_unauth || code_401 {
                    return true;
                }
            }
        }
    }
    false
}

/// Parses all JSON objects from stdout (supporting both NDJSON lines and a single JSON blob).
fn extract_json_objects(stdout: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('{') {
            if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                if v.is_object() {
                    out.push(v);
                }
            }
        }
    }
    if out.is_empty() {
        if let Some(start) = stdout.find('{') {
            if let Ok(v) = serde_json::from_str::<Value>(stdout[start..].trim()) {
                if v.is_object() {
                    out.push(v);
                }
            }
        }
    }
    out
}

/// True if stdout indicates `agy` executed `/usage` as an LLM model turn rather than a
/// local quota command (`num_turns > 0` or a non-empty `conversation_id`).
pub(crate) fn output_shows_model_turn(stdout: &str) -> bool {
    for v in extract_json_objects(stdout) {
        if v.get("num_turns")
            .and_then(|n| n.as_f64())
            .is_some_and(|n| n > 0.0)
        {
            return true;
        }
        if v.get("conversation_id")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
        {
            return true;
        }
    }
    false
}

pub async fn fetch_antigravity_cli_quota(id: String, name: String, exe: &Path) -> FetchOutcome {
    let work = dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("t3-deskcat")
        .join("agy-probe");
    let _ = fs::create_dir_all(&work);
    fetch_antigravity_cli_quota_with_mode(
        id,
        name,
        exe,
        AgyProbeMode::Standalone,
        &work,
        Utc::now().timestamp(),
    )
    .await
}

pub(crate) async fn fetch_antigravity_cli_quota_with_mode(
    id: String,
    name: String,
    exe: &Path,
    mode: AgyProbeMode,
    work_dir: &Path,
    now: i64,
) -> FetchOutcome {
    let fp = exe_fingerprint(exe);
    if is_latched_model_turn(&fp) {
        return FetchOutcome::local(error(
            id,
            name,
            now,
            "error",
            crate::tr!("agy CLI 未將 /usage 視為額度查詢，已停用背景輪詢以避免扣費"),
        ));
    }

    let min_ver = match mode {
        AgyProbeMode::Standalone => MIN_STANDALONE_VERSION,
        AgyProbeMode::IsolatedHome(_) => MIN_ISOLATED_VERSION,
    };

    let ver = match check_agy_version(exe, &fp, &mode, work_dir).await {
        Ok(v) => v,
        Err(msg) => return FetchOutcome::local(error(id, name, now, "error", msg)),
    };
    if ver < min_ver {
        let min_str = format!("{}.{}.{}", min_ver.0, min_ver.1, min_ver.2);
        return FetchOutcome::local(error(
            id,
            name,
            now,
            "error",
            crate::tr!(
                "agy CLI 版本過舊（需要 {min} 以上），無法安全讀取額度",
                min = min_str
            ),
        ));
    }

    let run = match spawn_usage_subprocess(exe, &mode, work_dir).await {
        Ok(r) => r,
        Err(msg) => return FetchOutcome::network(error(id, name, now, "error", msg)),
    };

    if output_shows_model_turn(&run.stdout) {
        latch_model_turn(fp);
        return FetchOutcome::network(error(
            id,
            name,
            now,
            "error",
            crate::tr!("agy CLI 未將 /usage 視為額度查詢，已停用背景輪詢以避免扣費"),
        ));
    }

    if run.auth_hit {
        return FetchOutcome::network(error(
            id,
            name,
            now,
            "expired",
            crate::tr!("憑證已過期：開啟 Antigravity（或 T3 Code）會自動刷新"),
        ));
    }

    if run.timed_out {
        return FetchOutcome::network(error(id, name, now, "error", crate::tr!("agy 回應逾時")));
    }

    // Parse SUCCESS first so benign stderr warnings (e.g. plugin auth noise) never override a valid report.
    match parse_report_at(&run.stdout, Some(now)) {
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
            // Only classify errors when no valid SUCCESS report was produced.
            if output_looks_signed_out(&msg)
                || output_looks_signed_out(&run.stdout)
                || output_looks_signed_out(&run.stderr)
            {
                return FetchOutcome::network(error(
                    id,
                    name,
                    now,
                    "expired",
                    crate::tr!("憑證已過期：開啟 Antigravity（或 T3 Code）會自動刷新"),
                ));
            }
            let lower_msg = msg.to_ascii_lowercase();
            if lower_msg.contains("429")
                || lower_msg.contains("rate limit")
                || lower_msg.contains("resource_exhausted")
            {
                FetchOutcome::rate_limited(error(id, name, now, "cooldown", msg), None)
            } else {
                FetchOutcome::network(error(id, name, now, "error", msg))
            }
        }
    }
}

type Windows = (Vec<crate::models::QuotaWindow>, Vec<crate::models::QuotaWindow>);

#[cfg_attr(not(test), allow(dead_code))]
fn parse_report(stdout: &str) -> Result<Windows, String> {
    parse_report_at(stdout, None)
}

fn parse_report_at(stdout: &str, now: Option<i64>) -> Result<Windows, String> {
    let objs = extract_json_objects(stdout);
    if objs.is_empty() {
        return if stdout.contains('{') {
            Err(crate::tr!("agy 用量報告格式無法解析：{e}", e = "invalid JSON"))
        } else {
            Err(crate::tr!("agy 沒有輸出用量報告"))
        };
    }

    // Prefer a SUCCESS usage envelope if multiple JSON lines were emitted.
    let mut last_err: Option<String> = None;
    for v in &objs {
        if v.get("status").and_then(Value::as_str) == Some("SUCCESS") {
            let Some(data) = v.pointer("/command/data") else {
                last_err = Some(crate::tr!("agy 用量報告缺少資料"));
                continue;
            };
            let (primary, extra) = super::antigravity::parse_quota_groups_at(data, now);
            if primary.is_empty() && extra.is_empty() {
                last_err = Some(crate::tr!("agy 用量報告沒有可用的額度"));
                continue;
            }
            return Ok((primary, extra));
        }
        let detail = v
            .get("error")
            .or_else(|| v.get("response"))
            .and_then(Value::as_str)
            .unwrap_or("agy 回報失敗，請在終端機執行 agy 確認已登入");
        last_err = Some(detail.chars().take(200).collect());
    }

    Err(last_err.unwrap_or_else(|| crate::tr!("agy 沒有輸出用量報告")))
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
    use std::ffi::OsString;

    // Shape of `agy -p /usage --output-format json` from agy 1.5.13+ (2026-11).
    const SAMPLE: &str = r#"{"conversation_id":"","status":"SUCCESS","response":"...","num_turns":0,"command":{"name":"usage","data":{"groups":[
      {"name":"Gemini Models","buckets":[
        {"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.535,"reset_time":"2026-11-25T01:11:01Z"},
        {"id":"gemini-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":0.96,"reset_time":"2026-11-20T13:37:30Z"}]},
      {"name":"Claude and GPT models","buckets":[
        {"id":"3p-weekly","window":"weekly","remaining_fraction":1,"reset_time":"1970-01-01T00:00:00Z"},
        {"id":"3p-5h","window":"5h","remaining_fraction":1,"reset_time":"2026-11-20T14:32:17Z"}]}]}}}"#;

    #[test]
    fn parses_agy_usage_report_and_filters_epoch_zero_reset() {
        let (primary, extra) = parse_report(SAMPLE).unwrap();
        let p: Vec<(String, i32)> = primary
            .iter()
            .map(|w| (w.label.clone(), w.remaining_percent))
            .collect();
        assert_eq!(p, vec![("5h".into(), 96), ("Wk".into(), 54)]);
        assert_eq!(extra.len(), 2);
        assert!(extra.iter().all(|w| w.label.starts_with("3P ") && w.remaining_percent == 100));
        assert!(primary[0].reset_at.is_some());
        assert_eq!(extra[0].reset_at, None);
        assert!(extra[1].reset_at.is_some());
    }

    #[test]
    fn parses_semver_variants() {
        assert_eq!(parse_semver("1.5.18\n"), Some((1, 5, 18)));
        assert_eq!(parse_semver("v1.5.16"), Some((1, 5, 16)));
        assert_eq!(parse_semver("agy_acp_server_1.5.12-beta.1"), Some((1, 5, 12)));
        assert_eq!(parse_semver("Antigravity CLI 1.1.11"), Some((1, 1, 11)));
        assert_eq!(parse_semver("not a version"), None);
    }

    #[test]
    fn detects_model_turn_fallback() {
        assert!(!output_shows_model_turn(SAMPLE));
        assert!(output_shows_model_turn(
            r#"{"conversation_id":"abc-123","num_turns":0,"status":"SUCCESS"}"#
        ));
        assert!(output_shows_model_turn(
            r#"{"conversation_id":"","num_turns":1,"status":"SUCCESS"}"#
        ));
    }

    #[test]
    fn isolated_env_strips_ambient_and_redirects_home_appdata_and_xdg() {
        let base: Vec<(OsString, OsString)> = vec![
            ("PATH".into(), "/usr/bin".into()),
            ("GEMINI_API_KEY".into(), "secret".into()),
            ("gemini_home".into(), "/wrong".into()),
            ("AGY_ACP_FORCE_FILE_STORAGE".into(), "0".into()),
            ("antigravity_cli_path".into(), "/old".into()),
            ("BROWSER".into(), "chrome".into()),
            ("USERPROFILE".into(), r"C:\Users\real".into()),
            ("HOME".into(), "/home/real".into()),
            ("APPDATA".into(), r"C:\Users\real\AppData\Roaming".into()),
            ("LOCALAPPDATA".into(), r"C:\Users\real\AppData\Local".into()),
            ("XDG_CONFIG_HOME".into(), "/home/real/.config".into()),
        ];
        let fake_home = Path::new(if cfg!(windows) {
            r"C:\Temp\t3-deskcat-test\home"
        } else {
            "/tmp/t3-deskcat-test/home"
        });
        let built = build_isolated_env(base, fake_home);
        let map: HashMap<String, String> = built
            .into_iter()
            .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
            .collect();

        assert_eq!(map.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert!(!map.keys().any(|k| k.eq_ignore_ascii_case("GEMINI_API_KEY")));
        assert!(!map.keys().any(|k| k.eq_ignore_ascii_case("GEMINI_HOME")));
        assert!(!map.keys().any(|k| k.eq_ignore_ascii_case("BROWSER")));
        assert!(!map.keys().any(|k| k.eq_ignore_ascii_case("AGY_ACP_FORCE_FILE_STORAGE")));
        assert!(!map.keys().any(|k| k.eq_ignore_ascii_case("ANTIGRAVITY_CLI_PATH")));
        assert_eq!(map.get("AGY_CLI_FORCE_FILE_TOKEN_STORAGE").map(String::as_str), Some("1"));
        assert_eq!(map.get("AGY_CLI_DISABLE_AUTO_UPDATE").map(String::as_str), Some("true"));
        assert_eq!(map.get("SSH_CONNECTION").map(String::as_str), Some("127.0.0.1 0 127.0.0.1 0"));
        assert_eq!(map.get("USERPROFILE").map(String::as_str), Some(fake_home.to_string_lossy().as_ref()));
        assert_eq!(map.get("HOME").map(String::as_str), Some(fake_home.to_string_lossy().as_ref()));
        assert_eq!(
            map.get("APPDATA").map(String::as_str),
            Some(fake_home.join("AppData").join("Roaming").to_string_lossy().as_ref())
        );
        assert_eq!(
            map.get("LOCALAPPDATA").map(String::as_str),
            Some(fake_home.join("AppData").join("Local").to_string_lossy().as_ref())
        );
        assert_eq!(
            map.get("XDG_CONFIG_HOME").map(String::as_str),
            Some(fake_home.join(".config").to_string_lossy().as_ref())
        );
        #[cfg(windows)]
        {
            assert_eq!(map.get("HOMEDRIVE").map(String::as_str), Some("C:"));
            assert_eq!(map.get("HOMEPATH").map(String::as_str), Some(r"\Temp\t3-deskcat-test\home"));
        }
    }

    #[test]
    fn finds_t3_managed_agy_from_active_json() {
        let tmp = std::env::temp_dir().join(format!("dc-t3-agy-find-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let base = tmp
            .join("tools")
            .join("antigravity-acp")
            .join(t3_platform_dir());
        let ver_dir = base.join("versions").join("rel-123");
        fs::create_dir_all(&ver_dir).unwrap();
        let exe = ver_dir.join(agy_exe_name());
        fs::write(&exe, b"stub").unwrap();
        fs::write(base.join("active.json"), r#"{"releaseId":"rel-123"}"#).unwrap();

        assert_eq!(find_t3_managed_agy_in(&tmp), Some(exe));
        let _ = fs::remove_dir_all(&tmp);
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
        let _ = fs::remove_dir_all(&tmp);
        let dir = tmp.join(".gemini").join("antigravity-cli");
        fs::create_dir_all(dir.join("brain")).unwrap();
        fs::write(dir.join("settings.json"), "{}").unwrap();
        assert!(!has_file_token(&tmp));
        fs::write(dir.join("antigravity-oauth-token"), "{}").unwrap();
        assert!(has_file_token(&tmp));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn reports_failure() {
        assert!(parse_report(r#"{"status":"ERROR","error":"not signed in"}"#).is_err());
        assert!(parse_report("").is_err());
        assert!(output_looks_signed_out("Authentication required. Please visit the URL"));
        assert!(output_looks_signed_out(r#"AGY_ERROR: {"status":"UNAUTHENTICATED","error_code":401}"#));
    }
}
