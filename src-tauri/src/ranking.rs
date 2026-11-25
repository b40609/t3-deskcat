//! Multi-dimensional account ranking & recommendation engine.
//!
//! Shared by:
//! - Main panel's recommendation section (`SmartPick` list)
//! - Public contract `quota_v1.json` (so external orchestrators like OmniKit can
//!   consume the exact same transparent rankings)
//!
//! Supported strategies:
//! - `most_left`: highest effective remaining quota (default)
//! - `use_before_reset`: anti-waste pressure (weekly quota protected with 3x weight
//!   over 5h so large weekly pools about to reset without being spent come first)
//! - `risk_first`: risk radar (forecasted early exhaustion, cooldown/expired, lowest remaining)
//! - `soonest_reset`: shortest countdown to next reset (recovery watch)
//! - `pinned`: user-chosen fixed account list

use crate::models::{AccountQuota, Forecast, ProviderKind, QuotaWindow, SmartPick};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

pub const STRATEGIES: &[&str] = &[
    "most_left",
    "use_before_reset",
    "risk_first",
    "soonest_reset",
    "pinned",
];

pub const SCOPES: &[&str] = &["per_provider", "global"];

#[derive(Debug, Clone)]
pub struct RankConfig<'a> {
    pub strategy: &'a str,
    pub scope: &'a str,
    pub count: usize,
    pub pin_active: bool,
    pub active_id: Option<&'a str>,
    pub pinned_ids: &'a [String],
}

pub fn is_usable(a: &AccountQuota) -> bool {
    a.status == "ok"
        || a.status == "stale"
        || (a.status == "expired" && !a.primary_windows.is_empty())
}

pub fn binding_window(acc: &AccountQuota) -> Option<&QuotaWindow> {
    acc.primary_windows
        .iter()
        .filter(|w| !w.label.contains(' '))
        .min_by_key(|w| w.remaining_percent)
        .or_else(|| acc.primary_windows.iter().min_by_key(|w| w.remaining_percent))
}

fn window_duration_secs(label: &str) -> Option<i64> {
    if label == "5h" || label.ends_with(" 5h") {
        return Some(5 * 3600);
    }
    if label == "Wk" || label.ends_with(" Wk") {
        return Some(7 * 86400);
    }
    if label == "Mo" || label.ends_with(" Mo") {
        return Some(30 * 86400);
    }
    let last = label.split_whitespace().last().unwrap_or(label);
    if let Some(h) = last.strip_suffix('h').and_then(|n| n.parse::<i64>().ok()) {
        return Some(h * 3600);
    }
    if let Some(d) = last.strip_suffix('d').and_then(|n| n.parse::<i64>().ok()) {
        return Some(d * 86400);
    }
    None
}

fn find_main_window<'a>(acc: &'a AccountQuota, is_weekly: bool) -> Option<&'a QuotaWindow> {
    acc.primary_windows
        .iter()
        .filter(|w| !w.label.contains(' '))
        .find(|w| {
            window_duration_secs(&w.label)
                .map(|d| if is_weekly { d >= 2 * 86400 } else { d < 2 * 86400 })
                .unwrap_or(false)
        })
}

fn window_percent(acc: &AccountQuota, label: &str) -> i32 {
    acc.primary_windows
        .iter()
        .find(|w| w.label == label)
        .map(|w| w.remaining_percent)
        .unwrap_or(acc.effective_remaining)
}

pub fn compare_most_left(a: &AccountQuota, b: &AccountQuota) -> Ordering {
    a.effective_remaining
        .cmp(&b.effective_remaining)
        .then_with(|| window_percent(a, "5h").cmp(&window_percent(b, "5h")))
        .then_with(|| window_percent(a, "Wk").cmp(&window_percent(b, "Wk")))
        .then_with(|| b.name.to_lowercase().cmp(&a.name.to_lowercase()))
}

/// Anti-waste score: measures how likely remaining quota will go unused before reset.
/// Weekly pools receive a 3x priority weight over 5h pools to protect larger allowances.
/// Returns `(score, dominant_is_weekly, dominant_window_reset_at, spendable_pct)`.
pub fn waste_pressure(acc: &AccountQuota, now: i64) -> (f64, bool, Option<i64>, i32) {
    let eff = acc.effective_remaining.clamp(0, 100);
    if eff < 10 {
        return (0.0, false, None, eff);
    }

    let mut best_score = 0.0f64;
    let mut best_weekly = false;
    let mut best_reset: Option<i64> = None;
    let mut best_pct = eff;

    // 1. Weekly window (3x weight: protecting weekly allowance from expiring unused)
    if let Some(w) = find_main_window(acc, true) {
        if let Some(r) = w.reset_at.filter(|r| *r > now) {
            let dur = window_duration_secs(&w.label).unwrap_or(7 * 86400) as f64;
            let left = (r - now) as f64;
            let time_left_ratio = (left / dur).clamp(0.01, 1.0);
            let spendable_pct = w.remaining_percent.min(eff);
            if spendable_pct >= 10 {
                let score = ((spendable_pct as f64) / 100.0) / time_left_ratio * 3.0;
                if score > best_score {
                    best_score = score;
                    best_weekly = true;
                    best_reset = Some(r);
                    best_pct = spendable_pct;
                }
            }
        }
    }

    // 2. Short 5h window (1x weight, only meaningful when resetting within 2h and >= 15% left)
    if let Some(w) = find_main_window(acc, false) {
        if let Some(r) = w.reset_at.filter(|r| *r > now && (*r - now) <= 2 * 3600) {
            let dur = window_duration_secs(&w.label).unwrap_or(5 * 3600) as f64;
            let left = (r - now) as f64;
            let time_left_ratio = (left / dur).clamp(0.02, 1.0);
            let spendable_pct = w.remaining_percent.min(eff);
            if spendable_pct >= 15 {
                let score = ((spendable_pct as f64) / 100.0) / time_left_ratio;
                if score > best_score {
                    best_score = score;
                    best_weekly = false;
                    best_reset = Some(r);
                    best_pct = spendable_pct;
                }
            }
        }
    }

    (best_score, best_weekly, best_reset, best_pct)
}

/// Risk severity tuple (higher = needs attention sooner):
/// (exhausted_or_error_tier, forecast_imminent, inverted_remaining).
fn risk_key(acc: &AccountQuota, forecasts: &HashMap<String, Forecast>, now: i64) -> (u8, i64, i32) {
    let status_tier = match acc.status.as_str() {
        "cooldown" | "error" => 4,
        "expired" => 3,
        _ if acc.effective_remaining == 0 => 4,
        _ if forecasts.contains_key(&acc.id) => 2,
        _ if acc.status == "stale" => 1,
        _ => 0,
    };
    let exhaust_urgency = forecasts
        .get(&acc.id)
        .map(|f| (i64::MAX / 2) - (f.exhaust_at - now).max(0))
        .unwrap_or(0);
    let low_score = 100 - acc.effective_remaining.clamp(0, 100);
    (status_tier, exhaust_urgency, low_score)
}

fn soonest_reset_ts(acc: &AccountQuota, now: i64) -> Option<i64> {
    acc.primary_windows
        .iter()
        .filter(|w| !w.label.contains(' '))
        .filter_map(|w| w.reset_at.filter(|r| *r > now))
        .min()
}

fn format_countdown(secs: i64) -> String {
    let s = secs.max(60);
    if s < 3600 {
        let mins = (s + 59) / 60;
        crate::tr!("{n} 分鐘後", n = mins)
    } else if s < 48 * 3600 {
        let hrs = (s + 1800) / 3600;
        crate::tr!("{n} 小時後", n = hrs)
    } else {
        let days = (s + 43200) / 86400;
        crate::tr!("{n} 天後", n = days)
    }
}

fn build_pick(
    acc: &AccountQuota,
    strategy: &str,
    is_active: bool,
    forecasts: &HashMap<String, Forecast>,
    now: i64,
) -> SmartPick {
    let mut reset_at = binding_window(acc).and_then(|w| w.reset_at).filter(|r| *r > now);
    let mut use_before_reset = false;
    let note = (acc.status == "expired")
        .then(|| crate::tr!("最後已知額度（憑證過期，切換過去用一次就會更新）"));

    let (tag, reason) = if is_active {
        (
            crate::tr!("使用中"),
            build_default_reason(acc),
        )
    } else {
        match strategy {
            "use_before_reset" => {
                let (score, is_weekly, dom_reset, pct) = waste_pressure(acc, now);
                if score > 0.0 {
                    use_before_reset = true;
                    reset_at = dom_reset;
                    let when = dom_reset.map(|r| format_countdown(r - now)).unwrap_or_default();
                    let reason = if is_weekly {
                        crate::tr!("週額度剩 {p}%，{when}重設", p = pct, when = when)
                    } else {
                        crate::tr!("5 小時剩 {p}%，{when}重設", p = pct, when = when)
                    };
                    (crate::tr!("防浪費"), reason)
                } else {
                    (crate::tr!("最充裕"), build_default_reason(acc))
                }
            }
            "risk_first" => {
                let reason = if acc.status == "cooldown" {
                    crate::tr!("請求受限冷卻中，暫時避開")
                } else if acc.status == "expired" {
                    crate::tr!("憑證已過期，需重新開啟更新")
                } else if acc.effective_remaining == 0 {
                    crate::tr!("額度已見底，請暫時避開")
                } else if let Some(fc) = forecasts.get(&acc.id) {
                    let when = format_countdown((fc.exhaust_at - now).max(60));
                    crate::tr!("依目前速度預計 {when} 用完", when = when)
                } else {
                    crate::tr!("剩餘僅 {p}%，留意避開", p = acc.effective_remaining)
                };
                (crate::tr!("警戒"), reason)
            }
            "soonest_reset" => {
                let soon = soonest_reset_ts(acc, now);
                reset_at = soon;
                let reason = match soon {
                    Some(r) => crate::tr!("{when}重設恢復", when = format_countdown(r - now)),
                    None => build_default_reason(acc),
                };
                (crate::tr!("快回血"), reason)
            }
            "pinned" => (crate::tr!("已釘選"), build_default_reason(acc)),
            _ => {
                // Default "most_left" (keeps 30-min imminent reset bonus when >= 10% left)
                let soon_30m = binding_window(acc)
                    .and_then(|w| w.reset_at)
                    .filter(|r| *r > now && (*r - now) <= 30 * 60 && acc.effective_remaining >= 10);
                if let Some(r) = soon_30m {
                    use_before_reset = true;
                    reset_at = Some(r);
                    let mins = ((r - now) + 59) / 60;
                    (
                        crate::tr!("即將重設"),
                        crate::tr!("{n} 分鐘後重設，建議優先使用", n = mins.max(1)),
                    )
                } else {
                    (crate::tr!("最充裕"), build_default_reason(acc))
                }
            }
        }
    };

    SmartPick {
        provider: acc.provider,
        account_id: acc.id.clone(),
        account_name: acc.name.clone(),
        effective_remaining: acc.effective_remaining,
        reason,
        tag,
        reset_at,
        use_before_reset,
        note,
    }
}

fn build_default_reason(acc: &AccountQuota) -> String {
    if acc.primary_windows.is_empty() {
        return crate::tr!("剩餘 {p}%", p = acc.effective_remaining);
    }
    acc.primary_windows
        .iter()
        .filter(|w| !w.label.contains(' '))
        .map(|w| format!("{} {}%", w.label, w.remaining_percent))
        .collect::<Vec<_>>()
        .join(" / ")
}

fn rank_pool<'a>(
    pool: Vec<&'a AccountQuota>,
    strategy: &str,
    forecasts: &HashMap<String, Forecast>,
    now: i64,
) -> Vec<&'a AccountQuota> {
    let mut list = pool;
    match strategy {
        "use_before_reset" => {
            list.sort_by(|a, b| {
                let (sa, wa, _, _) = waste_pressure(a, now);
                let (sb, wb, _, _) = waste_pressure(b, now);
                sb.partial_cmp(&sa)
                    .unwrap_or(Ordering::Equal)
                    .then_with(|| wb.cmp(&wa))
                    .then_with(|| compare_most_left(b, a))
            });
        }
        "risk_first" => {
            list.sort_by(|a, b| {
                risk_key(b, forecasts, now)
                    .cmp(&risk_key(a, forecasts, now))
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });
        }
        "soonest_reset" => {
            list.sort_by(|a, b| {
                let ra = soonest_reset_ts(a, now).unwrap_or(i64::MAX);
                let rb = soonest_reset_ts(b, now).unwrap_or(i64::MAX);
                ra.cmp(&rb).then_with(|| compare_most_left(b, a))
            });
        }
        _ => {
            // "most_left"
            list.sort_by(|a, b| {
                let a_soon = binding_window(a)
                    .and_then(|w| w.reset_at)
                    .is_some_and(|r| r > now && r - now <= 30 * 60 && a.effective_remaining >= 10);
                let b_soon = binding_window(b)
                    .and_then(|w| w.reset_at)
                    .is_some_and(|r| r > now && r - now <= 30 * 60 && b.effective_remaining >= 10);
                b_soon.cmp(&a_soon).then_with(|| compare_most_left(b, a))
            });
        }
    }
    list
}

fn eligible_for_strategy(acc: &AccountQuota, strategy: &str) -> bool {
    match strategy {
        "risk_first" => true,
        "soonest_reset" => is_usable(acc) || acc.status == "cooldown",
        "pinned" => true,
        _ => is_usable(acc) && acc.effective_remaining > 0,
    }
}

pub fn compute_ranked_picks(
    accounts: &[AccountQuota],
    forecasts: &HashMap<String, Forecast>,
    cfg: &RankConfig<'_>,
    now: i64,
) -> Vec<SmartPick> {
    let limit = cfg.count.clamp(1, 6);
    let mut out: Vec<SmartPick> = Vec::new();
    let mut taken: HashSet<String> = HashSet::new();

    // Optional: pin active working account at slot 0.
    if cfg.pin_active {
        if let Some(aid) = cfg.active_id {
            if let Some(acc) = accounts.iter().find(|a| a.id == aid) {
                out.push(build_pick(acc, cfg.strategy, true, forecasts, now));
                taken.insert(acc.id.clone());
                if cfg.scope == "global" && out.len() >= limit {
                    return out;
                }
            }
        }
    }

    // Strategy: manual pinned list
    if cfg.strategy == "pinned" {
        for pid in cfg.pinned_ids {
            if taken.contains(pid) {
                continue;
            }
            if let Some(acc) = accounts.iter().find(|a| &a.id == pid) {
                out.push(build_pick(acc, "pinned", false, forecasts, now));
                taken.insert(acc.id.clone());
                if out.len() >= limit {
                    break;
                }
            }
        }
        if !out.is_empty() {
            return out;
        }
        // Fallback to most_left when user hasn't pinned any valid account yet.
    }

    let eff_strategy = if cfg.strategy == "pinned" { "most_left" } else { cfg.strategy };

    if cfg.scope == "per_provider" {
        for provider in [ProviderKind::Claude, ProviderKind::Antigravity, ProviderKind::Codex] {
            let all_elig: Vec<&AccountQuota> = accounts
                .iter()
                .filter(|a| {
                    a.provider == provider
                        && !taken.contains(&a.id)
                        && eligible_for_strategy(a, eff_strategy)
                })
                .collect();
            if all_elig.is_empty() {
                continue;
            }
            // For positive recommendation modes, prefer non-expired accounts when available.
            let pool = if matches!(eff_strategy, "most_left" | "use_before_reset") {
                let active: Vec<&AccountQuota> = all_elig
                    .iter()
                    .copied()
                    .filter(|a| a.status != "expired")
                    .collect();
                if active.is_empty() { all_elig } else { active }
            } else {
                all_elig
            };

            let ranked = rank_pool(pool, eff_strategy, forecasts, now);
            for acc in ranked.into_iter().take(limit) {
                out.push(build_pick(acc, eff_strategy, false, forecasts, now));
                taken.insert(acc.id.clone());
            }
        }
    } else {
        // Global cross-provider ranking, capped at `limit`.
        let all_elig: Vec<&AccountQuota> = accounts
            .iter()
            .filter(|a| !taken.contains(&a.id) && eligible_for_strategy(a, eff_strategy))
            .collect();
        let pool = if matches!(eff_strategy, "most_left" | "use_before_reset") {
            let active: Vec<&AccountQuota> = all_elig
                .iter()
                .copied()
                .filter(|a| a.status != "expired")
                .collect();
            if active.is_empty() { all_elig } else { active }
        } else {
            all_elig
        };
        let ranked = rank_pool(pool, eff_strategy, forecasts, now);
        for acc in ranked {
            if out.len() >= limit {
                break;
            }
            out.push(build_pick(acc, eff_strategy, false, forecasts, now));
            taken.insert(acc.id.clone());
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(id: &str, provider: ProviderKind, name: &str, p5h: i32, r5h: Option<i64>, pwk: i32, rwk: Option<i64>) -> AccountQuota {
        AccountQuota {
            id: id.into(),
            provider,
            name: name.into(),
            plan: Some("Pro".into()),
            effective_remaining: p5h.min(pwk),
            primary_windows: vec![
                QuotaWindow { id: Some("5h".into()), label: "5h".into(), remaining_percent: p5h, reset_at: r5h },
                QuotaWindow { id: Some("weekly".into()), label: "Wk".into(), remaining_percent: pwk, reset_at: rwk },
            ],
            extra_windows: vec![],
            status: "ok".into(),
            error: None,
            updated_at: 1_000_000,
        }
    }

    #[test]
    fn use_before_reset_protects_weekly_allowance_over_far_or_small_windows() {
        let now = 1_000_000;
        // A: 70% weekly left, resets in 20h -> huge weekly waste risk
        let a = mk("ag:a", ProviderKind::Antigravity, "A", 90, Some(now + 4 * 3600), 70, Some(now + 20 * 3600));
        // B: 95% weekly left, resets in 6 days -> plenty of time
        let b = mk("ag:b", ProviderKind::Antigravity, "B", 100, Some(now + 4 * 3600), 95, Some(now + 6 * 86400));
        // C: 50% 5h left, resets in 40m, but weekly resets in 6 days
        let c = mk("ag:c", ProviderKind::Antigravity, "C", 50, Some(now + 40 * 60), 80, Some(now + 6 * 86400));

        let cfg = RankConfig {
            strategy: "use_before_reset",
            scope: "global",
            count: 3,
            pin_active: false,
            active_id: None,
            pinned_ids: &[],
        };
        let picks = compute_ranked_picks(&[b, c, a], &HashMap::new(), &cfg, now);
        assert_eq!(picks[0].account_name, "A");
        assert!(picks[0].use_before_reset);
        assert_eq!(picks[1].account_name, "C");
        assert_eq!(picks[2].account_name, "B");
    }

    #[test]
    fn risk_first_surfaces_lowest_and_exhausted_accounts() {
        let now = 1_000_000;
        let ok_hi = mk("c:hi", ProviderKind::Claude, "Hi", 95, None, 90, None);
        let ok_lo = mk("c:lo", ProviderKind::Claude, "Lo", 15, None, 20, None);
        let mut cooled = mk("c:429", ProviderKind::Claude, "Cool", 50, None, 50, None);
        cooled.status = "cooldown".into();

        let cfg = RankConfig {
            strategy: "risk_first",
            scope: "global",
            count: 3,
            pin_active: false,
            active_id: None,
            pinned_ids: &[],
        };
        let picks = compute_ranked_picks(&[ok_hi, ok_lo, cooled], &HashMap::new(), &cfg, now);
        assert_eq!(picks[0].account_name, "Cool");
        assert_eq!(picks[1].account_name, "Lo");
        assert_eq!(picks[2].account_name, "Hi");
    }

    #[test]
    fn per_provider_includes_codex_and_respects_count_per_provider() {
        let now = 1_000_000;
        let c1 = mk("c:1", ProviderKind::Claude, "C1", 90, None, 90, None);
        let c2 = mk("c:2", ProviderKind::Claude, "C2", 70, None, 70, None);
        let a1 = mk("a:1", ProviderKind::Antigravity, "A1", 80, None, 80, None);
        let x1 = mk("x:1", ProviderKind::Codex, "X1", 60, None, 60, None);

        let cfg = RankConfig {
            strategy: "most_left",
            scope: "per_provider",
            count: 1,
            pin_active: false,
            active_id: None,
            pinned_ids: &[],
        };
        let picks = compute_ranked_picks(&[c1, c2, a1, x1], &HashMap::new(), &cfg, now);
        let names: Vec<&str> = picks.iter().map(|p| p.account_name.as_str()).collect();
        assert_eq!(names, vec!["C1", "A1", "X1"]);
    }

    #[test]
    fn pinned_and_pin_active_work_together() {
        let now = 1_000_000;
        let a = mk("c:a", ProviderKind::Claude, "A", 90, None, 90, None);
        let b = mk("c:b", ProviderKind::Claude, "B", 50, None, 50, None);
        let c = mk("c:c", ProviderKind::Claude, "C", 20, None, 20, None);

        let pinned = vec!["c:c".to_string(), "c:a".to_string()];
        let cfg = RankConfig {
            strategy: "pinned",
            scope: "global",
            count: 2,
            pin_active: true,
            active_id: Some("c:b"),
            pinned_ids: &pinned,
        };
        let picks = compute_ranked_picks(&[a, b, c], &HashMap::new(), &cfg, now);
        assert_eq!(picks.len(), 2);
        assert_eq!(picks[0].account_name, "B");
        assert_eq!(picks[1].account_name, "C");
    }
}
