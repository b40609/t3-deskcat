//! "At the current pace this limit runs out at 16:40, before it resets."
//!
//! Burn rate per limit window:
//! 1. recent pace from that window's own history (last ≤ 90 min since its
//!    latest reset), when it covers at least 15 minutes;
//! 2. otherwise the average pace since the window started
//!    (`reset_at - window length`).
//!
//! Only warnings are produced: a forecast exists when the limit would hit 0
//! before its reset.

use crate::models::{AccountQuota, Forecast};

const RECENT_LOOKBACK: i64 = 90 * 60;
const RECENT_MIN_SPAN: i64 = 15 * 60;
const AVG_MIN_ELAPSED: i64 = 10 * 60;

/// Window length in seconds from its label ("5h", "Wk", "Mo", "3h", "2d").
pub fn window_secs(label: &str) -> Option<i64> {
    match label {
        "Wk" | "週" => Some(7 * 86400),
        "Mo" => Some(30 * 86400),
        l if l.ends_with('h') => l[..l.len() - 1].parse::<i64>().ok().map(|h| h * 3600),
        l if l.ends_with('d') => l[..l.len() - 1].parse::<i64>().ok().map(|d| d * 86400),
        _ => None,
    }
}

/// Percent per second over the most recent monotonically-falling stretch.
fn recent_rate(history: &[(i64, i32)], now: i64, current: i32) -> Option<f64> {
    let mut pts: Vec<(i64, i32)> = history
        .iter()
        .copied()
        .filter(|(t, _)| *t >= now - RECENT_LOOKBACK && *t < now)
        .collect();
    pts.push((now, current));
    let mut i = pts.len() - 1;
    while i > 0 && pts[i - 1].1 >= pts[i].1 {
        i -= 1;
    }
    let (t0, v0) = pts[i];
    let span = now - t0;
    if span < RECENT_MIN_SPAN {
        return None;
    }
    Some((v0 - current).max(0) as f64 / span as f64)
}

/// History key of one limit window ("claude:x|5h"); the bare account id holds
/// the effective % for the sparkline.
pub fn window_key(account_id: &str, label: &str) -> String {
    format!("{account_id}|{label}")
}

/// Current pace of the account's shortest limit window, % per hour. Recent
/// history only: a window that has not moved for 15+ minutes reads as 0, so the
/// cat slows down when nobody is using the account.
pub fn burn_rate<'a>(
    acc: &AccountQuota,
    series: impl Fn(&str) -> Option<&'a [(i64, i32)]>,
    now: i64,
) -> Option<f64> {
    if acc.status != "ok" && acc.status != "stale" {
        return None;
    }
    let w = acc
        .primary_windows
        .iter()
        .filter(|w| !w.label.contains(' '))
        .filter_map(|w| window_secs(&w.label).map(|len| (len, w)))
        .min_by_key(|(len, _)| *len)?
        .1;
    let rate = recent_rate(series(&w.label)?, now, w.remaining_percent)?;
    Some((rate * 3600.0 * 10.0).round() / 10.0)
}

/// `series(label)` returns that window's samples, if any.
pub fn forecast<'a>(
    acc: &AccountQuota,
    series: impl Fn(&str) -> Option<&'a [(i64, i32)]>,
    now: i64,
) -> Option<Forecast> {
    if acc.status != "ok" && acc.status != "stale" {
        return None;
    }
    let mut best: Option<Forecast> = None;
    for w in &acc.primary_windows {
        // Model-specific windows ("Wk Sonnet") are informational only.
        if w.label.contains(' ') || w.remaining_percent <= 0 {
            continue;
        }
        let Some(len) = window_secs(&w.label) else { continue };
        if w.reset_at.is_some_and(|r| r <= now) {
            continue;
        }

        let recent = series(&w.label).and_then(|h| recent_rate(h, now, w.remaining_percent));
        let rate = recent.or_else(|| {
            let start = w.reset_at? - len;
            let elapsed = now - start;
            (elapsed >= AVG_MIN_ELAPSED && elapsed < len)
                .then(|| (100 - w.remaining_percent).max(0) as f64 / elapsed as f64)
        });
        let Some(rate) = rate.filter(|r| *r > 0.0) else { continue };

        let exhaust_at = now + (w.remaining_percent as f64 / rate).round() as i64;
        let before_reset = w.reset_at.map_or(exhaust_at - now <= len, |r| exhaust_at < r);
        if !before_reset {
            continue;
        }
        if best.as_ref().is_none_or(|b| exhaust_at < b.exhaust_at) {
            best = Some(Forecast {
                label: w.label.clone(),
                exhaust_at,
                reset_at: w.reset_at,
                rate_per_hour: (rate * 3600.0 * 10.0).round() / 10.0,
            });
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ProviderKind, QuotaWindow};

    const H: i64 = 3600;

    fn acc(windows: &[(&str, i32, Option<i64>)]) -> AccountQuota {
        let primary: Vec<QuotaWindow> = windows
            .iter()
            .map(|(l, p, r)| QuotaWindow { label: l.to_string(), remaining_percent: *p, reset_at: *r })
            .collect();
        let eff = primary.iter().filter(|w| !w.label.contains(' ')).map(|w| w.remaining_percent).min().unwrap();
        AccountQuota {
            id: "a".into(),
            provider: ProviderKind::Claude,
            name: "A".into(),
            plan: None,
            effective_remaining: eff,
            primary_windows: primary,
            extra_windows: vec![],
            status: "ok".into(),
            error: None,
            updated_at: 0,
        }
    }

    #[test]
    fn labels_to_lengths() {
        assert_eq!(window_secs("5h"), Some(5 * H));
        assert_eq!(window_secs("Wk"), Some(7 * 86400));
        assert_eq!(window_secs("2d"), Some(2 * 86400));
        assert_eq!(window_secs("Wk Sonnet"), None);
    }

    #[test]
    fn average_pace_warns_only_when_running_out_before_reset() {
        let now = 100 * H;
        // 3h into a 5h window, 70% used (23.3%/h): 30% left lasts ~1.3h < 2h to reset.
        let f = forecast(&acc(&[("5h", 30, Some(now + 2 * H))]), |_| None, now).unwrap();
        assert_eq!(f.label, "5h");
        assert!(f.exhaust_at > now + H && f.exhaust_at < now + 2 * H);
        assert_eq!(f.rate_per_hour, 23.3);
        // 3h in, 50% used: 50% left lasts 3h > 2h to reset -> fine.
        assert!(forecast(&acc(&[("5h", 50, Some(now + 2 * H))]), |_| None, now).is_none());
    }

    #[test]
    fn recent_history_beats_window_average() {
        let now = 100 * H;
        let a = acc(&[("5h", 30, Some(now + 2 * H))]);
        // Flat for the last 40 minutes: not burning now, so no warning.
        let flat = [(now - 40 * 60, 30), (now - 20 * 60, 30)];
        assert!(forecast(&a, |_| Some(&flat[..]), now).is_none());
        // 20% in the last 30 minutes = 40%/h: 30% left lasts 45 min.
        let fast = [(now - 30 * 60, 50), (now - 15 * 60, 40)];
        let f = forecast(&a, |_| Some(&fast[..]), now).unwrap();
        assert_eq!(f.exhaust_at, now + 45 * 60);
        // History from before the last reset (value went up) is ignored.
        let reset = [(now - 80 * 60, 5), (now - 30 * 60, 50)];
        assert_eq!(forecast(&a, |_| Some(&reset[..]), now).unwrap().exhaust_at, now + 45 * 60);
        // Each window is paced from its own series, not another window's.
        let b = acc(&[("5h", 30, Some(now + 4 * H + 30 * 60)), ("Wk", 40, Some(now + 3 * 86400))]);
        let five = [(now - 20 * 60, 70)]; // 40% in 20 min
        let wk = [(now - 60 * 60, 41)];
        let f = forecast(&b, |l| Some(if l == "5h" { &five[..] } else { &wk[..] }), now).unwrap();
        assert_eq!((f.label.as_str(), f.exhaust_at), ("5h", now + 15 * 60));
    }

    #[test]
    fn burn_rate_uses_the_shortest_window() {
        let now = 100 * H;
        let a = acc(&[("5h", 40, Some(now + 2 * H)), ("Wk", 70, Some(now + 3 * 86400))]);
        let five = [(now - 30 * 60, 50)]; // 10% in 30 min
        let wk = [(now - 60 * 60, 80)];
        let r = burn_rate(&a, |l| Some(if l == "5h" { &five[..] } else { &wk[..] }), now);
        assert_eq!(r, Some(20.0));
        // Flat for 20 minutes: idle.
        let flat = [(now - 20 * 60, 40)];
        assert_eq!(burn_rate(&a, |_| Some(&flat[..]), now), Some(0.0));
        assert_eq!(burn_rate(&a, |_| None, now), None);
    }

    #[test]
    fn picks_the_earliest_of_several_windows() {
        let now = 100 * H;
        // Weekly: 3 days in, 80% used (26.7%/day): 20% lasts ~18h < 4 days to reset.
        let a = acc(&[("5h", 90, Some(now + 4 * H)), ("Wk", 20, Some(now + 4 * 86400))]);
        let f = forecast(&a, |_| None, now).unwrap();
        assert_eq!(f.label, "Wk");
        let mut expired = a.clone();
        expired.status = "expired".into();
        assert!(forecast(&expired, |_| None, now).is_none());
    }
}
