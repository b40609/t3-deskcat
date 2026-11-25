//! Versioned public quota contract (`quota_v1.json`) for external consumers
//! (OmniKit, CLI scripts, desktop/IDE agents, or future MCP bridges).
//!
//! Design goals:
//! - Strictly read-only & zero-secret (never writes tokens, cookies, or keys).
//! - Provider-agnostic string identifiers (`"claude"`, `"antigravity"`, `"codex"`,
//!   and open to future providers like `"deepseek"` / DSH without schema breaks).
//! - Decouples account identity (`canonicalId`) from discovery source (`bindings`),
//!   so pure CLI users, multi-tool mixes, and T3 Code users share one contract.
//! - Preserves machine-readable `windows[].id` and bucket `family` (e.g. Antigravity
//!   `gemini-*`, `gemini-argon-*`, `3p-*`) without fragile display-label parsing.

use crate::discovery::DiscoveredAccount;
use crate::models::{AccountQuota, ProviderKind, QuotaWindow};
use crate::quota_cache::QuotaCache;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone)]
pub struct AccountBindingMeta {
    pub canonical_id: String,
    pub source_kind: &'static str,
    pub t3_instance_id: Option<String>,
    pub config_dir: Option<String>,
    pub cli_executable: Option<String>,
    pub credential_kind: &'static str,
}

impl AccountBindingMeta {
    pub fn from_discovered(acc: &DiscoveredAccount) -> Self {
        let origin = acc.origin();
        Self {
            canonical_id: acc.canonical_id(),
            source_kind: origin.source_kind.as_str(),
            t3_instance_id: origin.t3_instance_id.clone(),
            config_dir: acc.config_dir().map(|p| p.display().to_string()),
            cli_executable: acc.cli_executable().map(|p| p.display().to_string()),
            credential_kind: acc.credential_kind(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaContractV1 {
    pub schema_version: u32,
    pub producer: String,
    pub producer_version: String,
    pub generated_at: i64,
    pub accounts: Vec<ContractAccount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractAccount {
    /// DeskCat's current account key (kept for backward compatibility with existing configs).
    pub account_id: String,
    /// Stable source-independent key derived from the underlying credential profile.
    pub canonical_id: String,
    /// Provider slug: "claude" | "antigravity" | "codex" | future providers (e.g. "deepseek").
    pub provider: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// "t3" | "native_cli" | "extra_dir" | "legacy" | "unknown"
    pub source_kind: String,
    pub bindings: ContractBindings,
    /// "ok" | "stale" | "cooldown" | "expired" | "error"
    pub status: String,
    /// True when numeric windows represent usable quota (not empty error/expired without data).
    pub usable: bool,
    /// True when numbers are last-known cached values (cooldown/error/expired).
    pub stale: bool,
    pub effective_remaining: i32,
    pub updated_at: i64,
    pub age_seconds: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backoff_until: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub windows: Vec<ContractWindow>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractBindings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub t3_instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli_executable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractWindow {
    /// Stable bucket/window identifier (e.g. "5h", "weekly", "gemini-5h", "3p-weekly").
    pub id: String,
    /// Normalized bucket family (e.g. "primary", "gemini", "argon", "3p", "sonnet", "opus").
    pub family: String,
    /// Normalized window duration ("5h" | "weekly" | "monthly" | custom span).
    pub span: String,
    /// Human-readable short label as displayed in DeskCat UI.
    pub label: String,
    pub remaining_percent: i32,
    pub used_percent: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
    pub is_primary: bool,
}

pub fn contract_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("t3-deskcat").join("quota_v1.json"))
}

pub fn build_contract(
    accounts: &[AccountQuota],
    bindings_map: &HashMap<String, AccountBindingMeta>,
    cache: &QuotaCache,
    now: i64,
) -> QuotaContractV1 {
    let items = accounts
        .iter()
        .map(|acc| build_account(acc, bindings_map.get(&acc.id), cache, now))
        .collect();

    QuotaContractV1 {
        schema_version: SCHEMA_VERSION,
        producer: "deskcat".to_string(),
        producer_version: env!("CARGO_PKG_VERSION").to_string(),
        generated_at: now,
        accounts: items,
    }
}

pub fn write_contract(contract: &QuotaContractV1) {
    let Some(path) = contract_path() else { return };
    let _ = write_contract_to(&path, contract);
}

pub fn write_contract_to(path: &Path, contract: &QuotaContractV1) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(contract)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn build_account(
    acc: &AccountQuota,
    meta: Option<&AccountBindingMeta>,
    cache: &QuotaCache,
    now: i64,
) -> ContractAccount {
    let mut windows = Vec::with_capacity(acc.primary_windows.len() + acc.extra_windows.len());
    for w in &acc.primary_windows {
        windows.push(to_contract_window(acc.provider, w, true));
    }
    for w in &acc.extra_windows {
        windows.push(to_contract_window(acc.provider, w, false));
    }

    let has_numbers = !windows.is_empty();
    let usable = has_numbers && matches!(acc.status.as_str(), "ok" | "stale");
    let stale = acc.status != "ok";
    let age_seconds = if acc.updated_at > 0 {
        (now - acc.updated_at).max(0)
    } else {
        0
    };
    let backoff_until = cache
        .backoff_remaining(&acc.id, now)
        .map(|(rem, _)| now + rem);

    let (canonical_id, source_kind, bindings) = match meta {
        Some(m) => (
            m.canonical_id.clone(),
            m.source_kind.to_string(),
            ContractBindings {
                t3_instance_id: m.t3_instance_id.clone(),
                config_dir: m.config_dir.clone(),
                cli_executable: m.cli_executable.clone(),
                credential_kind: Some(m.credential_kind.to_string()),
            },
        ),
        None => (
            acc.id.clone(),
            "unknown".to_string(),
            ContractBindings::default(),
        ),
    };

    ContractAccount {
        account_id: acc.id.clone(),
        canonical_id,
        provider: acc.provider.as_str().to_string(),
        display_name: acc.name.clone(),
        plan: acc.plan.clone(),
        source_kind,
        bindings,
        status: acc.status.clone(),
        usable,
        stale,
        effective_remaining: acc.effective_remaining,
        updated_at: acc.updated_at,
        age_seconds,
        backoff_until,
        error: acc.error.clone(),
        windows,
    }
}

fn to_contract_window(provider: ProviderKind, w: &QuotaWindow, is_primary: bool) -> ContractWindow {
    let remaining = w.remaining_percent.clamp(0, 100);
    let used = (100 - remaining).clamp(0, 100);
    let span = infer_span(w.id.as_deref(), &w.label);
    let family = infer_family(provider, w.id.as_deref(), &w.label);
    let id = w
        .id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| fallback_window_id(provider, &family, &span, &w.label));

    ContractWindow {
        id,
        family,
        span,
        label: w.label.clone(),
        remaining_percent: remaining,
        used_percent: used,
        resets_at: w.reset_at,
        is_primary,
    }
}

fn infer_span(id: Option<&str>, label: &str) -> String {
    let id_l = id.unwrap_or("").to_ascii_lowercase();
    let label_l = label.to_ascii_lowercase();
    if id_l.ends_with("weekly") || id_l.starts_with("weekly") || label_l.contains("wk") {
        "weekly".to_string()
    } else if id_l.ends_with("5h") || id_l.starts_with("5h") || label_l.contains("5h") {
        "5h".to_string()
    } else if id_l.ends_with("monthly") || id_l.starts_with("monthly") || label_l.contains("mo") {
        "monthly".to_string()
    } else {
        label_l.replace(' ', "-")
    }
}

fn infer_family(provider: ProviderKind, id: Option<&str>, label: &str) -> String {
    let id_l = id.unwrap_or("").to_ascii_lowercase();
    let label_l = label.to_ascii_lowercase();
    match provider {
        ProviderKind::Antigravity => {
            if id_l.contains("argon") || label_l.contains("argon") {
                "argon".to_string()
            } else if id_l.contains("carbon") || label_l.contains("carbon") {
                "carbon".to_string()
            } else if id_l.starts_with("3p") || label_l.contains("3p") {
                "3p".to_string()
            } else {
                "gemini".to_string()
            }
        }
        ProviderKind::Claude => {
            if let Some((_, rest)) = label.split_once(' ') {
                let slug = rest.trim().to_ascii_lowercase().replace(' ', "-");
                if !slug.is_empty() {
                    return slug;
                }
            }
            "primary".to_string()
        }
        ProviderKind::Codex => "primary".to_string(),
    }
}

fn fallback_window_id(provider: ProviderKind, family: &str, span: &str, label: &str) -> String {
    match provider {
        ProviderKind::Antigravity => match family {
            "argon" => format!("gemini-argon-{span}"),
            "3p" => format!("3p-{span}"),
            "carbon" => format!("gemini-carbon-{span}"),
            _ => format!("gemini-{span}"),
        },
        ProviderKind::Claude => {
            if family == "primary" {
                span.to_string()
            } else {
                format!("{span}-{family}")
            }
        }
        ProviderKind::Codex => {
            if !span.is_empty() {
                span.to_string()
            } else {
                label.to_ascii_lowercase()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::AccountOrigin;

    #[test]
    fn builds_source_agnostic_contract_with_bucket_families_and_no_secrets() {
        let now = 1_800_000_000;
        let tmp = std::env::temp_dir().join(format!("dc-contract-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();

        let claude_cred = tmp.join(".credentials.json");
        fs::write(&claude_cred, r#"{"claudeAiOauth":{"accessToken":"SECRET_SHOULD_NEVER_LEAK"}}"#).unwrap();

        let disc_t3 = DiscoveredAccount::Claude {
            id: "claude:claudeAgent".into(),
            name: "Ryan".into(),
            credentials_path: claude_cred.clone(),
            origin: AccountOrigin::t3("claudeAgent"),
        };
        let disc_native = DiscoveredAccount::Claude {
            id: "claude:default".into(),
            name: "Claude".into(),
            credentials_path: claude_cred,
            origin: AccountOrigin::native_cli(),
        };
        // Same underlying credential folder MUST yield the same canonicalId with or without T3.
        assert_eq!(disc_t3.canonical_id(), disc_native.canonical_id());

        let disc_ag = DiscoveredAccount::AntigravityCli {
            id: "ag:agy".into(),
            name: "Antigravity".into(),
            exe: PathBuf::from(r"C:\bin\agy.exe"),
            origin: AccountOrigin::native_cli(),
        };

        let mut bindings = HashMap::new();
        bindings.insert(disc_t3.id().to_string(), AccountBindingMeta::from_discovered(&disc_t3));
        bindings.insert(disc_ag.id().to_string(), AccountBindingMeta::from_discovered(&disc_ag));

        let accounts = vec![
            AccountQuota {
                id: "claude:claudeAgent".into(),
                provider: ProviderKind::Claude,
                name: "Ryan".into(),
                plan: Some("Team".into()),
                effective_remaining: 87,
                primary_windows: vec![
                    QuotaWindow { id: Some("5h".into()), label: "5h".into(), remaining_percent: 87, reset_at: Some(now + 3600) },
                    QuotaWindow { id: Some("weekly".into()), label: "Wk".into(), remaining_percent: 94, reset_at: Some(now + 86400) },
                    QuotaWindow { id: Some("weekly-sonnet".into()), label: "Wk Sonnet".into(), remaining_percent: 99, reset_at: None },
                ],
                extra_windows: vec![],
                status: "ok".into(),
                error: None,
                updated_at: now - 120,
            },
            AccountQuota {
                id: "ag:agy".into(),
                provider: ProviderKind::Antigravity,
                name: "Antigravity".into(),
                plan: None,
                effective_remaining: 69,
                primary_windows: vec![
                    QuotaWindow { id: Some("gemini-5h".into()), label: "5h".into(), remaining_percent: 90, reset_at: Some(now + 1800) },
                    QuotaWindow { id: Some("gemini-weekly".into()), label: "Wk".into(), remaining_percent: 69, reset_at: Some(now + 100_000) },
                ],
                extra_windows: vec![
                    QuotaWindow { id: Some("gemini-argon-weekly".into()), label: "Argon Wk".into(), remaining_percent: 50, reset_at: None },
                    QuotaWindow { id: Some("3p-weekly".into()), label: "3P Wk".into(), remaining_percent: 80, reset_at: None },
                ],
                status: "ok".into(),
                error: None,
                updated_at: now - 30,
            },
        ];

        let cache = QuotaCache::default();
        let contract = build_contract(&accounts, &bindings, &cache, now);
        assert_eq!(contract.schema_version, 1);
        assert_eq!(contract.producer, "deskcat");
        assert_eq!(contract.accounts.len(), 2);

        let claude = &contract.accounts[0];
        assert_eq!(claude.provider, "claude");
        assert_eq!(claude.source_kind, "t3");
        assert_eq!(claude.bindings.t3_instance_id.as_deref(), Some("claudeAgent"));
        assert!(claude.usable && !claude.stale);
        assert_eq!(claude.age_seconds, 120);
        assert_eq!(claude.windows[0].used_percent, 13);
        assert_eq!(claude.windows[2].family, "sonnet");

        let ag = &contract.accounts[1];
        assert_eq!(ag.provider, "antigravity");
        assert_eq!(ag.canonical_id, "antigravity:cli:agy");
        assert_eq!(ag.source_kind, "native_cli");
        assert!(ag.bindings.t3_instance_id.is_none());
        assert_eq!(ag.windows.len(), 4);
        assert_eq!((ag.windows[0].id.as_str(), ag.windows[0].family.as_str()), ("gemini-5h", "gemini"));
        assert_eq!((ag.windows[2].id.as_str(), ag.windows[2].family.as_str()), ("gemini-argon-weekly", "argon"));
        assert_eq!((ag.windows[3].id.as_str(), ag.windows[3].family.as_str()), ("3p-weekly", "3p"));

        let out_path = tmp.join("quota_v1.json");
        write_contract_to(&out_path, &contract).unwrap();
        let raw = fs::read_to_string(&out_path).unwrap();
        assert!(!raw.contains("SECRET_SHOULD_NEVER_LEAK"));
        let roundtrip: QuotaContractV1 = serde_json::from_str(&raw).unwrap();
        assert_eq!(roundtrip.accounts.len(), 2);

        let _ = fs::remove_dir_all(&tmp);
    }
}
