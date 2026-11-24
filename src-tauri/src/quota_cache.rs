//! Last-known-good quota cache + unified per-account rate-limit & error backoff.
//!
//! Every provider (Claude, Antigravity, Codex) shares this cache so:
//! * every successful fetch is persisted to disk and shown immediately on restart;
//! * deliberate throttle skips (within the safe refresh interval, no error) return
//!   the cached numbers with `status = "ok"` and their true `updated_at`, never
//!   triggering false "Data may be out of date" warnings;
//! * rate-limit responses (HTTP 429 / 503) honor `Retry-After` and apply exponential
//!   backoff (2 -> 4 -> 8 -> 16 -> 30 min), showing `status = "stale"` with the
//!   remaining cooldown so neither background ticks nor rapid clicks keep tripping
//!   the server-side limit;
//! * transient network / 5xx errors apply a shorter backoff (1 -> 2 -> 5 min) for
//!   background polls while still allowing explicit manual retries;
//! * locally expired credentials keep their last-known numbers marked `"expired"`
//!   without burning network attempts or blocking instant recovery once refreshed.

use crate::models::AccountQuota;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const RATELIMIT_BASE_SECS: i64 = 120;
const RATELIMIT_MAX_SECS: i64 = 1800;
const ERROR_BASE_SECS: i64 = 60;
const ERROR_MAX_SECS: i64 = 300;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Backoff {
    pub next_allowed_at: i64,
    pub strikes: u32,
    /// True for HTTP 429 / 503 rate limits (strictly respected even on manual refresh).
    /// False for transient network / 5xx errors (skipped automatically, retryable manually).
    #[serde(default = "default_true")]
    pub is_rate_limit: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct QuotaCache {
    /// Last successful result per account id.
    pub last_good: HashMap<String, AccountQuota>,
    #[serde(default)]
    pub backoff: HashMap<String, Backoff>,
    #[serde(default)]
    pub last_attempt: HashMap<String, i64>,
    #[serde(default)]
    pub last_error: HashMap<String, String>,
    #[serde(default)]
    pub last_expired: HashMap<String, String>,
    #[serde(skip)]
    dirty: bool,
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

    pub fn save(&mut self) {
        if !self.dirty {
            return;
        }
        let Some(path) = cache_path() else { return };
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(body) = serde_json::to_string(self) {
            let tmp = path.with_extension("json.tmp");
            if fs::write(&tmp, body).is_ok() && fs::rename(&tmp, &path).is_ok() {
                self.dirty = false;
            }
        }
    }

    /// Remaining backoff seconds for diagnostics / UI, if currently active.
    pub fn backoff_remaining(&self, id: &str, now: i64) -> Option<(i64, bool)> {
        let b = self.backoff.get(id)?;
        (b.next_allowed_at > now).then_some((b.next_allowed_at - now, b.is_rate_limit))
    }

    /// Timestamp of the last successful fetch for this account, if any.
    pub fn last_good_updated_at(&self, id: &str) -> Option<i64> {
        self.last_good.get(id).map(|a| a.updated_at)
    }

    /// True if this account has a window < 100% whose reset timestamp has passed
    /// since the cached snapshot was fetched.
    pub fn has_passed_reset(&self, id: &str, now: i64) -> bool {
        let Some(cached) = self.last_good.get(id) else {
            return false;
        };
        cached
            .primary_windows
            .iter()
            .chain(cached.extra_windows.iter())
            .any(|w| {
                w.remaining_percent < 100
                    && w.reset_at.is_some_and(|r| r <= now && r > cached.updated_at)
            })
    }

    /// True when the account was last recorded as expired (no point re-hitting the
    /// network until the credential file actually changes or the user forces a refresh).
    pub fn is_known_expired(&self, id: &str) -> bool {
        self.last_expired.contains_key(id)
    }

    /// Clear local expired state (e.g. when a credential file's mtime changed).
    pub fn clear_expired(&mut self, id: &str) {
        if self.last_expired.remove(id).is_some() {
            self.dirty = true;
        }
    }

    /// Whether we are allowed to hit the network for this account right now.
    ///
    /// * Rate-limit backoffs (429 / 503) are always respected.
    /// * Non-rate-limit error backoffs can be bypassed when `allow_retry_errors` is true
    ///   (manual refresh).
    /// * `min_interval` applies to every account with a recorded `last_attempt`, even
    ///   when `last_good` is empty, preventing uncached error loops from hammering APIs.
    pub fn may_fetch(
        &self,
        id: &str,
        now: i64,
        min_interval: i64,
        allow_retry_errors: bool,
    ) -> bool {
        if let Some(b) = self.backoff.get(id) {
            if now < b.next_allowed_at {
                if b.is_rate_limit || !allow_retry_errors {
                    return false;
                }
            }
        }
        match self.last_attempt.get(id) {
            Some(last) => now - last >= min_interval,
            None => true,
        }
    }

    pub fn note_attempt(&mut self, id: &str, now: i64) {
        self.last_attempt.insert(id.to_string(), now);
        self.dirty = true;
    }

    /// Merge a fresh fetch result with the cache and return what should be displayed.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn reconcile(&mut self, fresh: AccountQuota, now: i64) -> AccountQuota {
        self.reconcile_outcome(fresh, None, now)
    }

    /// Merge a fresh fetch result with optional server `Retry-After` duration.
    pub fn reconcile_outcome(
        &mut self,
        fresh: AccountQuota,
        retry_after_secs: Option<i64>,
        now: i64,
    ) -> AccountQuota {
        self.dirty = true;
        match fresh.status.as_str() {
            "ok" => {
                self.backoff.remove(&fresh.id);
                self.last_error.remove(&fresh.id);
                self.last_expired.remove(&fresh.id);
                self.last_good.insert(fresh.id.clone(), fresh.clone());
                fresh
            }
            // Auth problem: keep showing the last-known numbers (marked as such)
            // instead of an empty row; the status stays "expired".
            "expired" => {
                self.backoff.remove(&fresh.id);
                self.last_error.remove(&fresh.id);
                let note = fresh.error.clone();
                if let Some(ref msg) = note {
                    self.last_expired.insert(fresh.id.clone(), msg.clone());
                } else {
                    self.last_expired.insert(fresh.id.clone(), crate::tr!("憑證已過期"));
                }
                match self.cached_view_with_status(&fresh, now, "expired", note) {
                    Some(last) => last,
                    None => fresh,
                }
            }
            "cooldown" => {
                self.last_expired.remove(&fresh.id);
                let b = self.backoff.entry(fresh.id.clone()).or_default();
                if !b.is_rate_limit {
                    b.strikes = 0;
                    b.is_rate_limit = true;
                }
                b.strikes = (b.strikes + 1).min(10);
                let exp_wait = (RATELIMIT_BASE_SECS << (b.strikes - 1).min(6)).min(RATELIMIT_MAX_SECS);
                let wait = retry_after_secs
                    .filter(|s| *s > 0)
                    .map(|s| s.max(exp_wait).min(RATELIMIT_MAX_SECS))
                    .unwrap_or(exp_wait);
                b.next_allowed_at = now + wait;
                let mins = (wait + 59) / 60;
                let note = Some(crate::tr!(
                    "429 請求受限冷卻中，約 {m} 分鐘後重試",
                    m = mins.max(1)
                ));
                if let Some(ref msg) = note {
                    self.last_error.insert(fresh.id.clone(), msg.clone());
                }
                let mut f = fresh;
                f.error = note.clone();
                self.cached_view_with_status(&f, now, "stale", note).unwrap_or(f)
            }
            _ => {
                self.last_expired.remove(&fresh.id);
                let b = self.backoff.entry(fresh.id.clone()).or_default();
                if b.is_rate_limit && b.next_allowed_at <= now {
                    b.strikes = 0;
                }
                b.is_rate_limit = false;
                b.strikes = (b.strikes + 1).min(6);
                let wait = (ERROR_BASE_SECS << (b.strikes - 1).min(4)).min(ERROR_MAX_SECS);
                b.next_allowed_at = now + wait;
                let note = fresh.error.clone();
                if let Some(ref msg) = note {
                    self.last_error.insert(fresh.id.clone(), msg.clone());
                }
                self.cached_view_with_status(&fresh, now, "stale", note)
                    .unwrap_or(fresh)
            }
        }
    }

    /// Result for an account we deliberately did not fetch this round.
    ///
    /// * If the account is in backoff (429 or transient error), returns `"stale"` with
    ///   an explicit reason and remaining wait time.
    /// * If the account is known-expired (credential unchanged), keeps `"expired"`.
    /// * If skipped purely due to the healthy refresh interval (no error, no backoff),
    ///   returns `"ok"` with the cached numbers and their true `updated_at` so UI
    ///   surfaces never cry "Data may be out of date" during normal throttling.
    pub fn skipped(&self, id: &str, fallback: AccountQuota, now: i64) -> AccountQuota {
        let mut f = fallback;
        f.id = id.to_string();

        if let Some(exp_msg) = self.last_expired.get(id) {
            let note = Some(exp_msg.clone());
            f.status = "expired".to_string();
            f.error = note.clone();
            return self
                .cached_view_with_status(&f, now, "expired", note)
                .unwrap_or(f);
        }

        if let Some(b) = self.backoff.get(id).filter(|b| b.next_allowed_at > now) {
            let mins = ((b.next_allowed_at - now) + 59) / 60;
            let note = if b.is_rate_limit {
                Some(crate::tr!(
                    "429 請求受限冷卻中，約 {m} 分鐘後重試",
                    m = mins.max(1)
                ))
            } else {
                self.last_error
                    .get(id)
                    .cloned()
                    .or_else(|| Some(crate::tr!("暫時連線失敗，約 {m} 分鐘後重試", m = mins.max(1))))
            };
            f.status = if b.is_rate_limit {
                "cooldown".to_string()
            } else {
                "error".to_string()
            };
            f.error = note.clone();
            return self
                .cached_view_with_status(&f, now, "stale", note)
                .unwrap_or(f);
        }

        if let Some(cached) = self.cached_view_with_status(&f, now, "ok", None) {
            return cached;
        }
        f
    }

    fn cached_view_with_status(
        &self,
        current: &AccountQuota,
        now: i64,
        status: &str,
        note: Option<String>,
    ) -> Option<AccountQuota> {
        let cached = self.last_good.get(&current.id)?;
        let mut acc = cached.clone();
        // Keep the live display name / plan if we have them.
        acc.name = current.name.clone();
        if current.plan.is_some() {
            acc.plan = current.plan.clone();
        }
        acc.status = status.to_string();
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
        if changed {
            // Recompute effective_remaining across all providers (excluding model-specific labels).
            let min = acc
                .primary_windows
                .iter()
                .filter(|w| !w.label.contains(' '))
                .map(|w| w.remaining_percent)
                .min()
                .or_else(|| acc.primary_windows.iter().map(|w| w.remaining_percent).min());
            if let Some(min) = min {
                acc.effective_remaining = min;
            }
        }
        Some(acc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ProviderKind, QuotaWindow};

    fn acc(status: &str, pct: i32, reset_at: Option<i64>) -> AccountQuota {
        AccountQuota {
            id: "claude:a".into(),
            provider: ProviderKind::Claude,
            name: "A".into(),
            plan: Some("Pro".into()),
            effective_remaining: pct,
            primary_windows: vec![QuotaWindow {
                label: "5h".into(),
                remaining_percent: pct,
                reset_at,
            }],
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
        assert!(b.error.is_some());
        assert_eq!(b.updated_at, 1000);
    }

    #[test]
    fn backoff_honors_retry_after_and_resets_on_success() {
        let mut c = QuotaCache::default();
        // retry_after=0 (Anthropic bug) still enforces base backoff of 120s
        c.reconcile_outcome(acc("cooldown", 0, None), Some(0), 0);
        assert_eq!(c.backoff["claude:a"].next_allowed_at, 120);
        assert!(c.backoff["claude:a"].is_rate_limit);
        assert!(!c.may_fetch("claude:a", 100, 0, true));

        // Larger server Retry-After (600s > 240s exp) is respected
        c.reconcile_outcome(acc("cooldown", 0, None), Some(600), 200);
        assert_eq!(c.backoff["claude:a"].next_allowed_at, 800);
        assert!(!c.may_fetch("claude:a", 799, 0, true));
        assert!(c.may_fetch("claude:a", 800, 0, false));

        c.reconcile_outcome(acc("ok", 50, None), None, 900);
        assert!(c.backoff.get("claude:a").is_none());
    }

    #[test]
    fn healthy_throttle_skip_returns_ok_not_stale() {
        let mut c = QuotaCache::default();
        c.note_attempt("claude:a", 1000);
        c.reconcile(acc("ok", 82, None), 1000);
        assert!(!c.may_fetch("claude:a", 1060, 180, false));
        let shown = c.skipped("claude:a", acc("error", 0, None), 1060);
        assert_eq!(shown.status, "ok");
        assert!(shown.error.is_none());
        assert_eq!(shown.effective_remaining, 82);
        assert_eq!(shown.updated_at, 1000);
    }

    #[test]
    fn uncached_account_still_respects_min_interval_and_error_backoff() {
        let mut c = QuotaCache::default();
        c.note_attempt("claude:new", 1000);
        assert!(!c.may_fetch("claude:new", 1010, 60, false));
        assert!(c.may_fetch("claude:new", 1060, 60, false));

        // Transient error backs off for background polls, but manual refresh may retry
        let mut err = acc("error", 0, None);
        err.id = "claude:new".into();
        err.error = Some("連線失敗".into());
        c.reconcile_outcome(err, None, 1060);
        assert!(!c.may_fetch("claude:new", 1090, 0, false));
        assert!(c.may_fetch("claude:new", 1090, 0, true));
    }

    #[test]
    fn passed_reset_window_shows_full_for_all_providers() {
        let mut c = QuotaCache::default();
        let mut ag = acc("ok", 10, Some(2000));
        ag.id = "ag:a".into();
        ag.provider = ProviderKind::Antigravity;
        c.reconcile(ag.clone(), 1000);
        assert!(c.has_passed_reset("ag:a", 2500));

        let mut err = ag;
        err.status = "error".into();
        err.effective_remaining = 0;
        let s = c.reconcile(err, 2500);
        assert_eq!(s.effective_remaining, 100);
    }

    #[test]
    fn expired_keeps_last_known_numbers_and_persists_through_skip() {
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

        // Skipping while still expired keeps status="expired", never downgrades to "ok"
        let sk = c.skipped("claude:a", acc("ok", 0, None), 1200);
        assert_eq!(sk.status, "expired");
        assert_eq!(sk.effective_remaining, 80);

        // Its window reset while the token was expired -> shown as full.
        assert_eq!(c.reconcile(fresh.clone(), 6000).effective_remaining, 100);

        // Never fetched successfully: nothing to fall back to.
        let mut other = fresh;
        other.id = "claude:b".into();
        assert!(c.reconcile(other, 1100).primary_windows.is_empty());
    }
}
