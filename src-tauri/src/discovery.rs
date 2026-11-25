//! Account discovery. Works without T3 Code:
//!
//! - Claude Code: `CLAUDE_CONFIG_DIR`, `~/.claude`, and sibling profile dirs such as
//!   `~/.claude-work` (the `CLAUDE_CONFIG_DIR` multi-account convention), each with a
//!   `.credentials.json`.
//! - Codex: `CODEX_HOME`, `~/.config/codex`, `~/.codex`, and `~/.codex-*` with `auth.json`.
//! - Antigravity: token files T3 Code keeps per instance; otherwise the official `agy`
//!   CLI's own sign-in, queried through `agy -p /usage` (see `antigravity_cli`).
//! - Extra folders listed in settings (`extraAccountDirs`), classified by their contents.
//!
//! T3 Code (`~/.t3/userdata/settings.json`) is just one more source: when present it
//! adds its instances and their display names. Nothing is written anywhere.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// How DeskCat discovered an account. Used by external consumers (via `quota_v1.json`)
/// so non-T3 setups (native CLIs, standalone desktop tools, extra dirs) are first-class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    T3,
    NativeCli,
    ExtraDir,
    Legacy,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::T3 => "t3",
            Self::NativeCli => "native_cli",
            Self::ExtraDir => "extra_dir",
            Self::Legacy => "legacy",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountOrigin {
    pub source_kind: SourceKind,
    pub t3_instance_id: Option<String>,
}

impl AccountOrigin {
    pub fn t3(instance_id: impl Into<String>) -> Self {
        Self {
            source_kind: SourceKind::T3,
            t3_instance_id: Some(instance_id.into()),
        }
    }
    pub fn native_cli() -> Self {
        Self {
            source_kind: SourceKind::NativeCli,
            t3_instance_id: None,
        }
    }
    pub fn extra_dir() -> Self {
        Self {
            source_kind: SourceKind::ExtraDir,
            t3_instance_id: None,
        }
    }
    pub fn legacy() -> Self {
        Self {
            source_kind: SourceKind::Legacy,
            t3_instance_id: None,
        }
    }
}

/// Recent activity window for auto-coexisting standalone `agy` CLI alongside T3 Antigravity.
const AGY_COEXIST_ACTIVITY_SECS: u64 = 7 * 24 * 3600;

#[derive(Debug, Clone)]
pub enum DiscoveredAccount {
    Claude {
        id: String,
        name: String,
        credentials_path: PathBuf,
        origin: AccountOrigin,
    },
    Antigravity {
        id: String,
        name: String,
        token_path: PathBuf,
        is_legacy_gemini: bool,
        origin: AccountOrigin,
    },
    /// The official `agy` CLI's own sign-in (kept in the OS keyring), read via `agy -p /usage`.
    AntigravityCli {
        id: String,
        name: String,
        exe: PathBuf,
        origin: AccountOrigin,
    },
    Codex {
        id: String,
        name: String,
        auth_path: PathBuf,
        origin: AccountOrigin,
    },
}

impl DiscoveredAccount {
    pub fn id(&self) -> &str {
        match self {
            Self::Claude { id, .. }
            | Self::Antigravity { id, .. }
            | Self::AntigravityCli { id, .. }
            | Self::Codex { id, .. } => id,
        }
    }

    pub fn origin(&self) -> &AccountOrigin {
        match self {
            Self::Claude { origin, .. }
            | Self::Antigravity { origin, .. }
            | Self::AntigravityCli { origin, .. }
            | Self::Codex { origin, .. } => origin,
        }
    }

    /// Underlying CLI/profile config directory (if file-backed).
    pub fn config_dir(&self) -> Option<PathBuf> {
        match self {
            Self::Claude { credentials_path: p, .. }
            | Self::Antigravity { token_path: p, .. }
            | Self::Codex { auth_path: p, .. } => p.parent().map(Path::to_path_buf),
            Self::AntigravityCli { .. } => None,
        }
    }

    /// CLI executable path when probed via a CLI command (e.g. `agy`).
    pub fn cli_executable(&self) -> Option<&Path> {
        match self {
            Self::AntigravityCli { exe, .. } => Some(exe.as_path()),
            _ => None,
        }
    }

    /// Non-secret classification of how credentials are read for this account.
    pub fn credential_kind(&self) -> &'static str {
        match self {
            Self::Claude { .. } => "claude_credentials_json",
            Self::Codex { .. } => "codex_auth_json",
            Self::AntigravityCli { .. } => "agy_cli_probe",
            Self::Antigravity { token_path, is_legacy_gemini, .. } => {
                if *is_legacy_gemini {
                    "gemini_legacy_oauth"
                } else if token_path.file_name().and_then(|n| n.to_str()) == Some("acp_token.json") {
                    "antigravity_acp_token"
                } else {
                    "antigravity_oauth_token"
                }
            }
        }
    }

    /// Source-independent stable identifier derived from the canonical credential folder.
    /// The same `~/.claude` or `~/.codex` profile yields the exact same `canonical_id`
    /// whether discovered via T3 Code or standalone CLI.
    pub fn canonical_id(&self) -> String {
        match self {
            Self::AntigravityCli { .. } => "antigravity:cli:agy".to_string(),
            Self::Claude { credentials_path: p, .. } => canonical_path_id("claude", p),
            Self::Codex { auth_path: p, .. } => canonical_path_id("codex", p),
            Self::Antigravity { token_path: p, .. } => canonical_path_id("antigravity", p),
        }
    }

    /// Where the account came from, for the diagnostics log.
    pub fn source(&self) -> String {
        match self {
            Self::Claude { credentials_path: p, .. }
            | Self::Antigravity { token_path: p, .. }
            | Self::Codex { auth_path: p, .. } => p.display().to_string(),
            Self::AntigravityCli { exe, .. } => format!("{} -p /usage", exe.display()),
        }
    }
}

fn canonical_path_id(provider: &str, file_path: &Path) -> String {
    let dir = file_path.parent().unwrap_or(file_path);
    let canon = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    // Strip Windows extended-length prefix and normalize separators/case for stability.
    let norm = canon
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('\\', "/");
    let key = if cfg!(windows) {
        norm.to_ascii_lowercase()
    } else {
        norm
    };
    let hash = sha256_hex(&key);
    format!("{provider}:path:{}", &hash[..12])
}

#[derive(Default)]
struct Seen {
    paths: HashSet<PathBuf>,
    ids: HashSet<String>,
}

impl Seen {
    /// True the first time this credential file (and id) shows up.
    fn first(&mut self, path: &Path, id: &str) -> bool {
        let key = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        !self.ids.contains(id) && self.paths.insert(key) && self.ids.insert(id.to_string())
    }
}

pub fn discover_accounts(extra_dirs: &[String]) -> Vec<DiscoveredAccount> {
    let mut accounts = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return accounts;
    };
    let mut seen = Seen::default();

    // 1. T3 Code instances first, so their display names win.
    discover_t3(&home, &mut seen, &mut accounts);

    // 2. Claude Code profile dirs.
    let mut claude_dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = env_dir("CLAUDE_CONFIG_DIR") {
        claude_dirs.push(dir);
    }
    claude_dirs.push(home.join(".claude"));
    claude_dirs.extend(sibling_dirs(&home, ".claude"));
    for dir in claude_dirs {
        add_claude(&home, &dir, AccountOrigin::native_cli(), &mut seen, &mut accounts);
    }

    // 3. Codex homes.
    let mut codex_dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = env_dir("CODEX_HOME") {
        codex_dirs.push(dir);
    }
    codex_dirs.push(home.join(".config").join("codex"));
    codex_dirs.push(home.join(".codex"));
    codex_dirs.extend(sibling_dirs(&home, ".codex"));
    for dir in codex_dirs {
        add_codex(&home, &dir, AccountOrigin::native_cli(), &mut seen, &mut accounts);
    }

    // 4. Folders the user added by hand.
    for raw in extra_dirs {
        let dir = expand_tilde(&home, raw);
        add_claude(&home, &dir, AccountOrigin::extra_dir(), &mut seen, &mut accounts);
        add_codex(&home, &dir, AccountOrigin::extra_dir(), &mut seen, &mut accounts);
        add_antigravity_dir(&dir, AccountOrigin::extra_dir(), &mut seen, &mut accounts);
    }

    // 5. Antigravity via official `agy` CLI:
    //    - Always probed when no live (non-legacy) Antigravity token file was found (non-T3 setups).
    //    - Also coexists alongside T3 Antigravity when the user explicitly opts in via env var,
    //      adds `~/.gemini/antigravity*` in `extra_dirs`, or has recent standalone `agy` CLI
    //      activity in `~/.gemini/antigravity-cli/brain`.
    if should_include_agy(&accounts, extra_dirs, &home, env_include_agy()) {
        if let Some(exe) = crate::providers::antigravity_cli::find_agy() {
            if crate::providers::antigravity_cli::has_signin() {
                accounts.push(DiscoveredAccount::AntigravityCli {
                    id: "ag:agy".to_string(),
                    name: "Antigravity".to_string(),
                    exe,
                    origin: AccountOrigin::native_cli(),
                });
            }
        }
    }
    let has_ag = accounts.iter().any(|a| {
        matches!(
            a,
            DiscoveredAccount::Antigravity { .. } | DiscoveredAccount::AntigravityCli { .. }
        )
    });
    if !has_ag {
        // Legacy Gemini CLI sign-in (Google ended Gemini CLI OAuth for consumer plans in 2026,
        // so this mostly finds nothing now).
        let legacy = home.join(".gemini").join("oauth_creds.json");
        if legacy.exists() && seen.first(&legacy, "ag:default") {
            accounts.push(DiscoveredAccount::Antigravity {
                id: "ag:default".to_string(),
                name: "Gemini".to_string(),
                token_path: legacy,
                is_legacy_gemini: true,
                origin: AccountOrigin::legacy(),
            });
        }
    }

    // Deterministic order: Claude -> Antigravity -> Codex, then by name
    accounts.sort_by_key(|acc| match acc {
        DiscoveredAccount::Claude { name, .. } => (0u8, name.to_lowercase()),
        DiscoveredAccount::Antigravity { name, .. }
        | DiscoveredAccount::AntigravityCli { name, .. } => (1u8, name.to_lowercase()),
        DiscoveredAccount::Codex { name, .. } => (2u8, name.to_lowercase()),
    });

    accounts
}

fn discover_t3(home: &Path, seen: &mut Seen, accounts: &mut Vec<DiscoveredAccount>) {
    let t3_userdata = std::env::var("T3CODE_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| expand_tilde(home, &s).join("userdata"))
        .unwrap_or_else(|| home.join(".t3").join("userdata"));
    let Ok(raw) = fs::read_to_string(t3_userdata.join("settings.json")) else {
        return;
    };
    let Ok(json) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    let Some(instances) = json.get("providerInstances").and_then(Value::as_object) else {
        return;
    };

    for (instance_id, cfg) in instances {
        let driver = cfg.get("driver").and_then(Value::as_str).unwrap_or("");
        let display_name = cfg
            .get("displayName")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(instance_id.as_str())
            .to_string();
        let home_path = cfg
            .get("config")
            .and_then(|c| c.get("homePath"))
            .and_then(Value::as_str)
            .map(|p| expand_tilde(home, p));

        match driver {
            "claudeAgent" => {
                let dir = home_path.unwrap_or_else(|| home.join(".claude"));
                let cred = dir.join(".credentials.json");
                let id = format!("claude:{instance_id}");
                if cred.exists() && seen.first(&cred, &id) {
                    accounts.push(DiscoveredAccount::Claude {
                        id,
                        name: display_name,
                        credentials_path: cred,
                        origin: AccountOrigin::t3(instance_id),
                    });
                }
            }
            "antigravity" => {
                let acp_dir = t3_userdata
                    .join("providers")
                    .join("antigravity")
                    .join(sha256_hex(instance_id))
                    .join("antigravity-acp");
                if let Some(token_path) = antigravity_token_in(&acp_dir) {
                    let id = format!("ag:{instance_id}");
                    if seen.first(&token_path, &id) {
                        accounts.push(DiscoveredAccount::Antigravity {
                            id,
                            name: display_name,
                            token_path,
                            is_legacy_gemini: false,
                            origin: AccountOrigin::t3(instance_id),
                        });
                    }
                }
            }
            "codex" => {
                // Included even when disabled in T3, as long as it is signed in.
                let auth = home_path
                    .map(|d| d.join("auth.json"))
                    .filter(|p| p.exists())
                    .or_else(|| default_codex_auth(home));
                if let Some(path) = auth {
                    let id = format!("codex:{instance_id}");
                    let name = if display_name == "codex" { "Codex".to_string() } else { display_name };
                    if seen.first(&path, &id) {
                        accounts.push(DiscoveredAccount::Codex {
                            id,
                            name,
                            auth_path: path,
                            origin: AccountOrigin::t3(instance_id),
                        });
                    }
                }
            }
            _ => {}
        }
    }
}

fn add_claude(
    home: &Path,
    dir: &Path,
    origin: AccountOrigin,
    seen: &mut Seen,
    accounts: &mut Vec<DiscoveredAccount>,
) {
    let cred = dir.join(".credentials.json");
    if !cred.exists() {
        return;
    }
    let (id, name) = id_and_name(home, dir, "claude", ".claude", "Claude");
    if seen.first(&cred, &id) {
        accounts.push(DiscoveredAccount::Claude {
            id,
            name,
            credentials_path: cred,
            origin,
        });
    }
}

fn add_codex(
    home: &Path,
    dir: &Path,
    origin: AccountOrigin,
    seen: &mut Seen,
    accounts: &mut Vec<DiscoveredAccount>,
) {
    let auth = dir.join("auth.json");
    if !auth.exists() {
        return;
    }
    let (id, name) = id_and_name(home, dir, "codex", ".codex", "Codex");
    if seen.first(&auth, &id) {
        accounts.push(DiscoveredAccount::Codex {
            id,
            name,
            auth_path: auth,
            origin,
        });
    }
}

fn add_antigravity_dir(
    dir: &Path,
    origin: AccountOrigin,
    seen: &mut Seen,
    accounts: &mut Vec<DiscoveredAccount>,
) {
    let token = antigravity_token_in(dir).or_else(|| antigravity_token_in(&dir.join("antigravity-acp")));
    let Some(token_path) = token else { return };
    let label = dir_label(dir);
    let id = format!("ag:dir:{}", label.to_lowercase());
    if seen.first(&token_path, &id) {
        accounts.push(DiscoveredAccount::Antigravity {
            id,
            name: label,
            token_path,
            is_legacy_gemini: false,
            origin,
        });
    }
}

fn env_include_agy() -> Option<bool> {
    for var in ["DESKCAT_INCLUDE_AGY", "T3_DESKCAT_INCLUDE_AGY"] {
        if let Ok(raw) = std::env::var(var) {
            match raw.trim().to_ascii_lowercase().as_str() {
                "1" | "true" | "yes" | "on" => return Some(true),
                "0" | "false" | "no" | "off" => return Some(false),
                _ => {}
            }
        }
    }
    None
}

fn should_include_agy(
    accounts: &[DiscoveredAccount],
    extra_dirs: &[String],
    home: &Path,
    env_override: Option<bool>,
) -> bool {
    if let Some(flag) = env_override {
        return flag;
    }
    let has_live_ag = accounts.iter().any(|a| {
        matches!(a, DiscoveredAccount::Antigravity { is_legacy_gemini: false, .. })
    });
    if !has_live_ag {
        return true;
    }
    // User explicitly pointed an extra folder at standalone agy / Antigravity IDE.
    if extra_dirs.iter().any(|raw| {
        let p = expand_tilde(home, raw)
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase();
        p.contains(".gemini/antigravity")
    }) {
        return true;
    }
    // User actively uses standalone `agy` CLI alongside T3 (separate brain dir from T3's ACP dir).
    has_recent_agy_cli_activity(home)
}

fn has_recent_agy_cli_activity(home: &Path) -> bool {
    let cli_brain = home.join(".gemini").join("antigravity-cli").join("brain");
    let Ok(rd) = fs::read_dir(&cli_brain) else {
        return false;
    };
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(AGY_COEXIST_ACTIVITY_SECS))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    for ent in rd.flatten() {
        let transcript = ent
            .path()
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        if fs::metadata(&transcript)
            .and_then(|m| m.modified())
            .is_ok_and(|t| t >= cutoff)
        {
            return true;
        }
    }
    false
}

/// Prefer the live `antigravity-oauth-token` (T3 0.1.11+ / agy 1.5) over the older
/// `acp_token.json`, which is no longer refreshed.
fn antigravity_token_in(dir: &Path) -> Option<PathBuf> {
    ["antigravity-oauth-token", "acp_token.json"]
        .iter()
        .map(|f| dir.join(f))
        .find(|p| p.is_file())
}

/// `~/.claude` -> ("claude:default", "Claude"); `~/.claude-work` -> ("claude:work", "work");
/// any other folder -> ("claude:dir:<name>", "<name>").
fn id_and_name(home: &Path, dir: &Path, kind: &str, base: &str, default_name: &str) -> (String, String) {
    if dir == home.join(base) || (kind == "codex" && dir == home.join(".config").join("codex")) {
        return (format!("{kind}:default"), default_name.to_string());
    }
    let file_name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if dir.parent() == Some(home) {
        if let Some(rest) = file_name
            .strip_prefix(base)
            .and_then(|r| r.strip_prefix(['-', '_', '.']))
            .filter(|r| !r.is_empty())
        {
            return (format!("{kind}:{}", rest.to_lowercase()), rest.to_string());
        }
    }
    let label = dir_label(dir);
    (format!("{kind}:dir:{}", label.to_lowercase()), label)
}

fn dir_label(dir: &Path) -> String {
    dir.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.trim_start_matches('.').to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| dir.display().to_string())
}

/// `~/.claude-*` / `~/.claude_*` style siblings of a CLI's home folder.
fn sibling_dirs(home: &Path, base: &str) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(home) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| {
            e.file_name()
                .to_str()
                .and_then(|n| n.strip_prefix(base))
                .is_some_and(|r| r.starts_with(['-', '_', '.']) && r.len() > 1)
        })
        .map(|e| e.path())
        .collect();
    out.sort();
    out
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var(var)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn default_codex_auth(home: &Path) -> Option<PathBuf> {
    env_dir("CODEX_HOME")
        .map(|d| d.join("auth.json"))
        .into_iter()
        .chain([
            home.join(".config").join("codex").join("auth.json"),
            home.join(".codex").join("auth.json"),
        ])
        .find(|p| p.exists())
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

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let result = hasher.finalize();
    result.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_from_profile_dirs() {
        let home = PathBuf::from("/h");
        assert_eq!(
            id_and_name(&home, &home.join(".claude"), "claude", ".claude", "Claude"),
            ("claude:default".into(), "Claude".into())
        );
        assert_eq!(
            id_and_name(&home, &home.join(".claude-Work"), "claude", ".claude", "Claude"),
            ("claude:work".into(), "Work".into())
        );
        assert_eq!(
            id_and_name(&home, &PathBuf::from("/x/acct2"), "codex", ".codex", "Codex"),
            ("codex:dir:acct2".into(), "acct2".into())
        );
    }

    #[test]
    fn finds_profile_siblings_only() {
        let tmp = std::env::temp_dir().join(format!("dc-disc-{}", std::process::id()));
        for d in [".claude", ".claude-kai", ".claude_x", ".claudette", ".codex-b"] {
            fs::create_dir_all(tmp.join(d)).unwrap();
        }
        let names: Vec<String> = sibling_dirs(&tmp, ".claude")
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![".claude-kai", ".claude_x"]);

        // a profile dir with credentials is discovered with its own id
        fs::write(tmp.join(".claude-kai").join(".credentials.json"), "{}").unwrap();
        let mut seen = Seen::default();
        let mut acc = Vec::new();
        add_claude(&tmp, &tmp.join(".claude-kai"), AccountOrigin::native_cli(), &mut seen, &mut acc);
        add_claude(&tmp, &tmp.join(".claude-kai"), AccountOrigin::native_cli(), &mut seen, &mut acc); // dedupe
        assert_eq!(acc.len(), 1);
        assert_eq!(acc[0].id(), "claude:kai");
        assert_eq!(acc[0].origin().source_kind, SourceKind::NativeCli);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn agy_coexists_when_active_or_explicitly_requested() {
        let tmp = std::env::temp_dir().join(format!("dc-agy-coexist-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let t3_ag = vec![DiscoveredAccount::Antigravity {
            id: "ag:antigravity_ryan".into(),
            name: "Ryan".into(),
            token_path: tmp.join("antigravity-oauth-token"),
            is_legacy_gemini: false,
            origin: AccountOrigin::t3("antigravity_ryan"),
        }];

        // No standalone activity & no override -> skip to avoid duplicate card with T3.
        assert!(!should_include_agy(&t3_ag, &[], &tmp, None));
        // Env override true/false takes precedence.
        assert!(should_include_agy(&t3_ag, &[], &tmp, Some(true)));
        assert!(!should_include_agy(&[], &[], &tmp, Some(false)));
        // No live T3 Antigravity -> always include standalone agy.
        assert!(should_include_agy(&[], &[], &tmp, None));
        // Explicit extra_dirs pointing to ~/.gemini/antigravity-cli -> coexist.
        assert!(should_include_agy(&t3_ag, &["~/.gemini/antigravity-cli".into()], &tmp, None));

        // Active standalone `agy` CLI transcript -> auto-coexist.
        let transcript_dir = tmp
            .join(".gemini")
            .join("antigravity-cli")
            .join("brain")
            .join("conv-1")
            .join(".system_generated")
            .join("logs");
        fs::create_dir_all(&transcript_dir).unwrap();
        fs::write(transcript_dir.join("transcript.jsonl"), "{}\n").unwrap();
        assert!(should_include_agy(&t3_ag, &[], &tmp, None));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn prefers_live_antigravity_token() {
        let tmp = std::env::temp_dir().join(format!("dc-ag-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("acp_token.json"), "{}").unwrap();
        assert_eq!(antigravity_token_in(&tmp), Some(tmp.join("acp_token.json")));
        fs::write(tmp.join("antigravity-oauth-token"), "{}").unwrap();
        assert_eq!(antigravity_token_in(&tmp), Some(tmp.join("antigravity-oauth-token")));
        let _ = fs::remove_dir_all(&tmp);
    }
}
