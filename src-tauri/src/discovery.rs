use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub enum DiscoveredAccount {
    Claude {
        id: String,
        name: String,
        credentials_path: PathBuf,
    },
    Antigravity {
        id: String,
        name: String,
        token_path: PathBuf,
        is_legacy_gemini: bool,
    },
    Codex {
        id: String,
        name: String,
        auth_path: PathBuf,
    },
}

/// Automatically discovers accounts configured in T3 Code (`~/.t3/userdata/settings.json`),
/// and falls back to standard local CLI directories (`~/.claude`, `~/.codex`, `~/.gemini`)
/// if no matching T3 entries are present. Zero user-specific paths or names are hardcoded.
pub fn discover_accounts() -> Vec<DiscoveredAccount> {
    let mut accounts = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return accounts;
    };

    let t3_userdata = home.join(".t3").join("userdata");
    let t3_settings_path = t3_userdata.join("settings.json");

    let mut seen_claude_paths: HashSet<PathBuf> = HashSet::new();
    let mut seen_ag_paths: HashSet<PathBuf> = HashSet::new();
    let mut seen_codex_paths: HashSet<PathBuf> = HashSet::new();

    if let Ok(raw) = fs::read_to_string(&t3_settings_path) {
        if let Ok(json) = serde_json::from_str::<Value>(&raw) {
            if let Some(instances) = json.get("providerInstances").and_then(Value::as_object) {
                for (instance_id, cfg) in instances {
                    let driver = cfg.get("driver").and_then(Value::as_str).unwrap_or("");
                    let enabled = cfg.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                    let display_name = cfg
                        .get("displayName")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(instance_id.as_str())
                        .to_string();

                    match driver {
                        "claudeAgent" => {
                            let home_path = cfg
                                .get("config")
                                .and_then(|c| c.get("homePath"))
                                .and_then(Value::as_str)
                                .map(|p| expand_tilde(&home, p))
                                .unwrap_or_else(|| home.join(".claude"));
                            let cred_path = home_path.join(".credentials.json");
                            if cred_path.exists() && seen_claude_paths.insert(cred_path.clone()) {
                                accounts.push(DiscoveredAccount::Claude {
                                    id: format!("claude:{instance_id}"),
                                    name: display_name,
                                    credentials_path: cred_path,
                                });
                            }
                        }
                        "antigravity" => {
                            let acp_dir = t3_userdata
                                .join("providers")
                                .join("antigravity")
                                .join(sha256_hex(instance_id))
                                .join("antigravity-acp");
                            // T3 0.1.11+ keeps the live token in `antigravity-oauth-token`;
                            // `acp_token.json` is the older file (no longer refreshed).
                            let new_path = acp_dir.join("antigravity-oauth-token");
                            let token_path = if new_path.exists() {
                                new_path
                            } else {
                                acp_dir.join("acp_token.json")
                            };
                            if token_path.exists() && seen_ag_paths.insert(token_path.clone()) {
                                accounts.push(DiscoveredAccount::Antigravity {
                                    id: format!("ag:{instance_id}"),
                                    name: display_name,
                                    token_path,
                                    is_legacy_gemini: false,
                                });
                            }
                        }
                        "codex" => {
                            // Even if Codex is disabled in T3 UI, include it if auth.json exists
                            let _ = enabled;
                            let auth_path = resolve_codex_auth_path(&home);
                            if let Some(path) = auth_path {
                                if seen_codex_paths.insert(path.clone()) {
                                    let label = if display_name == "codex" {
                                        "Codex".to_string()
                                    } else {
                                        display_name
                                    };
                                    accounts.push(DiscoveredAccount::Codex {
                                        id: format!("codex:{instance_id}"),
                                        name: label,
                                        auth_path: path,
                                    });
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    // Fallback: if default ~/.claude/.credentials.json wasn't in T3 settings, pick it up
    let default_claude = home.join(".claude").join(".credentials.json");
    if default_claude.exists() && seen_claude_paths.insert(default_claude.clone()) {
        accounts.push(DiscoveredAccount::Claude {
            id: "claude:default".to_string(),
            name: "Default".to_string(),
            credentials_path: default_claude,
        });
    }

    // Fallback: always pick up local ~/.codex/auth.json if not yet added
    if let Some(codex_path) = resolve_codex_auth_path(&home) {
        if seen_codex_paths.insert(codex_path.clone()) {
            accounts.push(DiscoveredAccount::Codex {
                id: "codex:default".to_string(),
                name: "Codex".to_string(),
                auth_path: codex_path,
            });
        }
    }

    // Fallback: if no T3 Antigravity tokens were found, check ~/.gemini/oauth_creds.json
    if seen_ag_paths.is_empty() {
        let legacy_ag = home.join(".gemini").join("oauth_creds.json");
        if legacy_ag.exists() {
            accounts.push(DiscoveredAccount::Antigravity {
                id: "ag:default".to_string(),
                name: "Default".to_string(),
                token_path: legacy_ag,
                is_legacy_gemini: true,
            });
        }
    }

    // Deterministic sort order: Claude -> Antigravity -> Codex, then by name
    accounts.sort_by_key(|acc| match acc {
        DiscoveredAccount::Claude { name, .. } => (0u8, name.to_lowercase()),
        DiscoveredAccount::Antigravity { name, .. } => (1u8, name.to_lowercase()),
        DiscoveredAccount::Codex { name, .. } => (2u8, name.to_lowercase()),
    });

    accounts
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

fn resolve_codex_auth_path(home: &Path) -> Option<PathBuf> {
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        let p = PathBuf::from(codex_home).join("auth.json");
        if p.exists() {
            return Some(p);
        }
    }
    let config_p = home.join(".config").join("codex").join("auth.json");
    if config_p.exists() {
        return Some(config_p);
    }
    let default_p = home.join(".codex").join("auth.json");
    if default_p.exists() {
        return Some(default_p);
    }
    None
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let result = hasher.finalize();
    result.iter().map(|b| format!("{b:02x}")).collect()
}
