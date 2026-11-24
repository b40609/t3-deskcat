pub mod antigravity;
pub mod antigravity_cli;
pub mod claude;
pub mod codex;

use crate::models::AccountQuota;
use chrono::DateTime;
use reqwest::header::{HeaderMap, RETRY_AFTER};

/// Result of a single provider fetch attempt, carrying metadata for cache & rate-limit control.
#[derive(Debug, Clone)]
pub struct FetchOutcome {
    pub quota: AccountQuota,
    /// True if a network request (or external CLI invocation) actually happened.
    /// False for local short-circuits (e.g. local expiry check or local session-log read).
    pub network_hit: bool,
    /// Server-requested wait duration in seconds from HTTP `Retry-After`, if present.
    pub retry_after_secs: Option<i64>,
}

impl FetchOutcome {
    pub fn local(quota: AccountQuota) -> Self {
        Self { quota, network_hit: false, retry_after_secs: None }
    }

    pub fn network(quota: AccountQuota) -> Self {
        Self { quota, network_hit: true, retry_after_secs: None }
    }

    pub fn rate_limited(quota: AccountQuota, retry_after_secs: Option<i64>) -> Self {
        Self { quota, network_hit: true, retry_after_secs }
    }
}

/// Parses HTTP `Retry-After` header (delta-seconds or RFC 2822 HTTP-date).
pub fn parse_retry_after(headers: &HeaderMap, now: i64) -> Option<i64> {
    let raw = headers.get(RETRY_AFTER)?.to_str().ok()?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(secs) = raw.parse::<i64>() {
        return Some(secs.max(0));
    }
    if let Ok(dt) = DateTime::parse_from_rfc2822(raw) {
        return Some((dt.timestamp() - now).max(0));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    #[test]
    fn parses_retry_after_seconds_and_http_date() {
        let mut h = HeaderMap::new();
        h.insert(RETRY_AFTER, HeaderValue::from_static("180"));
        assert_eq!(parse_retry_after(&h, 1_000), Some(180));

        h.insert(RETRY_AFTER, HeaderValue::from_static("0"));
        assert_eq!(parse_retry_after(&h, 1_000), Some(0));

        // RFC 2822 HTTP-date
        let base = DateTime::parse_from_rfc2822("Tue, 24 Nov 2026 06:00:00 GMT")
            .unwrap()
            .timestamp();
        h.insert(
            RETRY_AFTER,
            HeaderValue::from_static("Tue, 24 Nov 2026 06:05:30 GMT"),
        );
        assert_eq!(parse_retry_after(&h, base), Some(330));

        h.insert(RETRY_AFTER, HeaderValue::from_static("nonsense"));
        assert_eq!(parse_retry_after(&h, base), None);
    }
}
