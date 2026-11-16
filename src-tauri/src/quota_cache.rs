//! Last-known-good quota cache + per-account rate-limit backoff.
//!
//! Anthropic's `/api/oauth/usage` endpoint rate-limits each OAuth token
//! independently (HTTP 429, often with `retry-after: 0`). A transient 429 or
//! network failure must never wipe an account's numbers to 0%, so:
//!
//! * every successful fetch is stored here and persisted to disk, so the data
//!   survives restarts;
//! * a failed fetch (429 / network / 5xx) falls back to the cached data, shown
//!   as `status = "stale"` with the time it was fetched;
//! * an account that got 429 is not polled again until its backoff expires
//!   (2 → 4 → 8 → 16 → 30 min), which lets the server-side limit clear instead
//!   of keeping it tripped.

use crate::models::{AccountQuota, ProviderKind};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const BACKOFF_BASE_SECS: i64 = 120;
const BACKOFF_MAX_SECS: i64 = 1800;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Backoff {
    pub next_allowed_at: i64,
    pub strikes: u32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct QuotaCache {
    /// Last successful result per account id.
    pub last_good: HashMap<String, AccountQuota>,
    #[serde(default)]
    pub backoff: HashMap<String, Backoff>,
    #[serde(default)]
    pub last_attempt: HashMap<String, i64>,
}

fn cache_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("t3-deskcat").join("quota_cache.json"))
}

impl QuotaCache {
    pub fn load() -> Self {
        cache_path()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) {
        let Some(path) = cache_path() else { return };
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(body) = serde_json::to_string(self) {
            let tmp = path.with_extension("json.tmp");
            if fs::write(&tmp, body).is_ok() {
                let _ = fs::rename(&tmp, &path);
            }
        }
    }

    /// Whether we are allowed to hit the network for this account right now.
    pub fn may_fetch(&self, id: &str, now: i64, min_interval: i64) -> bool {
        if let Some(b) = self.backoff.get(id) {
            if now < b.next_allowed_at {
                return false;
            }
        }
        match self.last_attempt.get(id) {
            Some(last) if self.last_good.contains_key(id) => now - last >= min_interval,
            _ => true,
        }
    }

    pub fn note_attempt(&mut self, id: &str, now: i64) {
        self.last_attempt.insert(id.to_string(), now);
    }

    /// Merge a fresh fetch result with the cache and return what should be displayed.
    pub fn reconcile(&mut self, fresh: AccountQuota, now: i64) -> AccountQuota {
        match fresh.status.as_str() {
            "ok" => {
                self.backoff.remove(&fresh.id);
                self.last_good.insert(fresh.id.clone(), fresh.clone());
                fresh
            }
            // Auth problem: keep showing the last-known numbers (marked as such)
            // instead of an empty row; the status stays "expired".
            "expired" => {
                let note = fresh.error.clone();
                match self.stale_view(&fresh, now, note) {
                    Some(mut last) => {
                        last.status = "expired".to_string();
                        last
                    }
                    None => fresh,
                }
            }
            status => {
                if status == "cooldown" {
                    let b = self.backoff.entry(fresh.id.clone()).or_default();
                    b.strikes = (b.strikes + 1).min(10);
                    let wait = (BACKOFF_BASE_SECS << (b.strikes - 1).min(6)).min(BACKOFF_MAX_SECS);
                    b.next_allowed_at = now + wait;
                }
                let note = fresh.error.clone();
                self.stale_or(fresh, now, note)
            }
        }
    }

    /// Result for an account we deliberately did not fetch this round.
    pub fn skipped(&self, id: &str, fallback: AccountQuota, now: i64) -> AccountQuota {
        let mut f = fallback;
        f.id = id.to_string();
        let note = self
            .backoff
            .get(id)
            .filter(|b| b.next_allowed_at > now)
            .map(|b| format!("已暫停查詢，{} 分鐘後重試", ((b.next_allowed_at - now) + 59) / 60));
        self.stale_view(&f, now, note).unwrap_or(f)
    }

    fn stale_or(&self, fresh: AccountQuota, now: i64, note: Option<String>) -> AccountQuota {
        self.stale_view(&fresh, now, note).unwrap_or(fresh)
    }

    fn stale_view(&self, current: &AccountQuota, now: i64, note: Option<String>) -> Option<AccountQuota> {
        let cached = self.last_good.get(&current.id)?;
        let mut acc = cached.clone();
        // Keep the live display name / plan if we have them.
        acc.name = current.name.clone();
        if current.plan.is_some() {
            acc.plan = current.plan.clone();
        }
        acc.status = "stale".to_string();
        acc.error = note;
        // updated_at stays at the time the cached data was actually fetched.

        // Any window whose reset time has passed is full again.
        let mut changed = false;
        for w in acc.primary_windows.iter_mut().chain(acc.extra_windows.iter_mut()) {
            if let Some(r) = w.reset_at {
                if r <= now {
                    w.remaining_percent = 100;
                    w.reset_at = None;
                    changed = true;
                }
            }
        }
        if changed && acc.provider == ProviderKind::Claude {
            // Model-specific windows ("Wk Sonnet") don't drive the effective value.
            if let Some(min) = acc
                .primary_windows
                .iter()
                .filter(|w| !w.label.contains(' '))
                .map(|w| w.remaining_percent)
                .min()
            {
                acc.effective_remaining = min;
            }
        }
        Some(acc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::QuotaWindow;

    fn acc(status: &str, pct: i32, reset_at: Option<i64>) -> AccountQuota {
        AccountQuota {
            id: "claude:a".into(),
            provider: ProviderKind::Claude,
            name: "A".into(),
            plan: Some("Pro".into()),
            effective_remaining: pct,
            primary_windows: vec![QuotaWindow { label: "5h".into(), remaining_percent: pct, reset_at }],
            extra_windows: vec![],
            status: status.into(),
            error: None,
            updated_at: 1000,
        }
    }

    #[test]
    fn rate_limit_keeps_last_good_numbers() {
        let mut c = QuotaCache::default();
        c.reconcile(acc("ok", 64, None), 1000);
        // two 429s in a row must still show 64%, not 0%
        let a = c.reconcile(acc("cooldown", 0, None), 1100);
        let b = c.reconcile(acc("cooldown", 0, None), 1400);
        assert_eq!(a.effective_remaining, 64);
        assert_eq!(b.effective_remaining, 64);
        assert_eq!(b.status, "stale");
        assert_eq!(b.updated_at, 1000);
    }

    #[test]
    fn backoff_grows_and_resets_on_success() {
        let mut c = QuotaCache::default();
        c.reconcile(acc("cooldown", 0, None), 0);
        assert_eq!(c.backoff["claude:a"].next_allowed_at, 120);
        assert!(!c.may_fetch("claude:a", 100, 0));
        c.reconcile(acc("cooldown", 0, None), 200);
        assert_eq!(c.backoff["claude:a"].next_allowed_at, 440);
        c.reconcile(acc("ok", 50, None), 500);
        assert!(c.backoff.get("claude:a").is_none());
    }

    #[test]
    fn passed_reset_window_shows_full() {
        let mut c = QuotaCache::default();
        c.reconcile(acc("ok", 10, Some(2000)), 1000);
        let s = c.reconcile(acc("error", 0, None), 2500);
        assert_eq!(s.effective_remaining, 100);
    }

    #[test]
    fn expired_keeps_last_known_numbers() {
        let mut c = QuotaCache::default();
        c.reconcile(acc("ok", 80, Some(5000)), 1000);
        let mut fresh = acc("expired", 0, None);
        fresh.primary_windows.clear();
        fresh.error = Some("憑證已過期".into());
        let e = c.reconcile(fresh.clone(), 1100);
        assert_eq!(e.status, "expired");
        assert_eq!(e.effective_remaining, 80);
        assert_eq!(e.updated_at, 1000);
        assert_eq!(e.error.as_deref(), Some("憑證已過期"));
        // Its window reset while the token was expired -> shown as full.
        assert_eq!(c.reconcile(fresh.clone(), 6000).effective_remaining, 100);
        // Never fetched successfully: nothing to fall back to.
        let mut other = fresh;
        other.id = "claude:b".into();
        assert!(c.reconcile(other, 1100).primary_windows.is_empty());
    }
}
