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
    "use_before_reset_weekly",
    "use_before_reset_5h",
    "risk_first",
    "soonest_reset",
    "pinned",
];

/// Migrate legacy strategy identifiers cleanly.
pub fn normalize_strategy(raw: &str) -> &str {
    match raw {
        "use_before_reset" => "use_before_reset_weekly",
        s if STRATEGIES.contains(&s) => s,
        _ => "most_left",
    }
}

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
        || ((a.status == "expired" || a.status == "idle") && !a.primary_windows.is_empty())
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

const WEEKLY_IMMINENT_SECS: i64 = 48 * 3600;
const SHORT_IMMINENT_SECS: i64 = 90 * 60;
const WEEKLY_TIME_BUCKET_SECS: i64 = 12 * 3600;
const SHORT_TIME_BUCKET_SECS: i64 = 30 * 60;

#[derive(Debug, Clone, Copy)]
pub struct ResetWindowEval {
    pub has_window: bool,
    pub imminent: bool,
    pub urgency: f64,
    pub reset_at: Option<i64>,
    pub left_secs: i64,
    pub window_pct: i32,
    pub spendable_pct: i32,
}

/// Evaluates a specific window (`is_weekly = true` for weekly pool, `false` for 5h pool)
/// for reset-aware recommendation.
///
/// Only accounts genuinely close to reset (`<= 48h` weekly, `<= 90m` for 5h) with at least
/// 10% spendable quota are marked `imminent = true`. Otherwise they are ranked by soonest
/// reset bucket first (so a 4-day-left account beats a freshly-reset 7-day-left account).
pub fn eval_reset_window(acc: &AccountQuota, is_weekly: bool, now: i64) -> ResetWindowEval {
    let eff = acc.effective_remaining.clamp(0, 100);
    let Some(w) = find_main_window(acc, is_weekly) else {
        return ResetWindowEval {
            has_window: false,
            imminent: false,
            urgency: 0.0,
            reset_at: None,
            left_secs: i64::MAX,
            window_pct: eff,
            spendable_pct: 0,
        };
    };
    let Some(r) = w.reset_at.filter(|r| *r > now) else {
        return ResetWindowEval {
            has_window: false,
            imminent: false,
            urgency: 0.0,
            reset_at: None,
            left_secs: i64::MAX,
            window_pct: w.remaining_percent.clamp(0, 100),
            spendable_pct: 0,
        };
    };
    let left_secs = r - now;
    let window_pct = w.remaining_percent.clamp(0, 100);
    let spendable_pct = window_pct.min(eff);
    let imminent_cap = if is_weekly { WEEKLY_IMMINENT_SECS } else { SHORT_IMMINENT_SECS };
    let imminent = spendable_pct >= 10 && left_secs <= imminent_cap;
    let urgency = if imminent {
        (spendable_pct as f64) / ((left_secs as f64) / 3600.0).max(0.1)
    } else {
        0.0
    };
    ResetWindowEval {
        has_window: true,
        imminent,
        urgency,
        reset_at: Some(r),
        left_secs,
        window_pct,
        spendable_pct,
    }
}

/// Compare two accounts for `use_before_reset_weekly` or `use_before_reset_5h`.
/// Returns Ordering for descending sort (better candidate first).
fn compare_reset_strategy(a: &AccountQuota, b: &AccountQuota, is_weekly: bool, now: i64) -> Ordering {
    let ea = eval_reset_window(a, is_weekly, now);
    let eb = eval_reset_window(b, is_weekly, now);
    let a_ok = ea.has_window && ea.spendable_pct >= 10;
    let b_ok = eb.has_window && eb.spendable_pct >= 10;
    b_ok.cmp(&a_ok)
        .then_with(|| eb.imminent.cmp(&ea.imminent))
        .then_with(|| {
            if ea.imminent && eb.imminent {
                eb.urgency.partial_cmp(&ea.urgency).unwrap_or(Ordering::Equal)
            } else if a_ok && b_ok {
                let bucket = if is_weekly { WEEKLY_TIME_BUCKET_SECS } else { SHORT_TIME_BUCKET_SECS };
                let ba = ea.left_secs / bucket;
                let bb = eb.left_secs / bucket;
                ba.cmp(&bb)
                    .then_with(|| eb.spendable_pct.cmp(&ea.spendable_pct))
                    .then_with(|| ea.left_secs.cmp(&eb.left_secs))
            } else {
                Ordering::Equal
            }
        })
        .then_with(|| compare_most_left(b, a))
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
    let note = match acc.status.as_str() {
        "expired" => Some(crate::tr!("最後已知額度（憑證已過期，重新使用一次即自動更新）")),
        // Unused accounts only change when a window resets, which the cache applies.
        "idle" => Some(crate::tr!("最後已知額度（閒置中，用一次即更新）")),
        _ => None,
    };

    let (tag, reason) = if is_active {
        (
            crate::tr!("使用中"),
            build_default_reason(acc),
        )
    } else {
        match normalize_strategy(strategy) {
            "use_before_reset_weekly" => {
                let ev = eval_reset_window(acc, true, now);
                if ev.has_window && ev.spendable_pct >= 10 {
                    reset_at = ev.reset_at;
                    let when = ev.reset_at.map(|r| format_countdown(r - now)).unwrap_or_default();
                    if ev.imminent {
                        use_before_reset = true;
                        (
                            crate::tr!("週將重設"),
                            crate::tr!("週額度剩 {p}%，{when}重設", p = ev.window_pct, when = when),
                        )
                    } else {
                        (
                            crate::tr!("較早重設"),
                            crate::tr!("週額度剩 {p}%，{when}重設", p = ev.window_pct, when = when),
                        )
                    }
                } else {
                    (crate::tr!("充裕"), build_default_reason(acc))
                }
            }
            "use_before_reset_5h" => {
                let ev = eval_reset_window(acc, false, now);
                if ev.has_window && ev.spendable_pct >= 10 {
                    reset_at = ev.reset_at;
                    let when = ev.reset_at.map(|r| format_countdown(r - now)).unwrap_or_default();
                    if ev.imminent {
                        use_before_reset = true;
                        (
                            crate::tr!("5h 將重設"),
                            crate::tr!("5 小時剩 {p}%，{when}重設", p = ev.window_pct, when = when),
                        )
                    } else {
                        (
                            crate::tr!("較早重設"),
                            crate::tr!("5 小時剩 {p}%，{when}重設", p = ev.window_pct, when = when),
                        )
                    }
                } else {
                    (crate::tr!("充裕"), build_default_reason(acc))
                }
            }
            "risk_first" => {
                if acc.status == "cooldown" {
                    (crate::tr!("受限"), crate::tr!("目前限流冷卻中，建議改用其他帳號"))
                } else if acc.status == "expired" {
                    (crate::tr!("過期"), crate::tr!("憑證已過期，重新使用一次即自動更新"))
                } else if acc.effective_remaining == 0 {
                    (crate::tr!("用盡"), crate::tr!("額度已用盡，請改用其他帳號"))
                } else if let Some(fc) = forecasts.get(&acc.id) {
                    let when = format_countdown((fc.exhaust_at - now).max(60));
                    (crate::tr!("偏低"), crate::tr!("依目前消耗速度，預計 {when} 用完", when = when))
                } else {
                    (crate::tr!("偏低"), crate::tr!("僅剩 {p}%，建議改用其他帳號", p = acc.effective_remaining))
                }
            }
            "soonest_reset" => {
                let soon = soonest_reset_ts(acc, now);
                reset_at = soon;
                let reason = match soon {
                    Some(r) => crate::tr!("{when}重設", when = format_countdown(r - now)),
                    None => build_default_reason(acc),
                };
                (crate::tr!("最快重設"), reason)
            }
            "pinned" => (crate::tr!("固定"), build_default_reason(acc)),
            _ => {
                // Default "most_left" (keeps 30-min imminent reset bonus when >= 10% left)
                let bind = binding_window(acc);
                let soon_30m = bind
                    .and_then(|w| w.reset_at)
                    .filter(|r| *r > now && (*r - now) <= 30 * 60 && acc.effective_remaining >= 10);
                if let Some(r) = soon_30m {
                    use_before_reset = true;
                    reset_at = Some(r);
                    let mins = ((r - now) + 59) / 60;
                    let is_weekly = bind
                        .and_then(|w| window_duration_secs(&w.label))
                        .is_some_and(|d| d >= 2 * 86400);
                    let tag = if is_weekly {
                        crate::tr!("週將重設")
                    } else {
                        crate::tr!("5h 將重設")
                    };
                    (
                        tag,
                        crate::tr!("{n} 分鐘後重設，建議優先使用", n = mins.max(1)),
                    )
                } else {
                    (crate::tr!("充裕"), build_default_reason(acc))
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
    match normalize_strategy(strategy) {
        "use_before_reset_weekly" => {
            list.sort_by(|a, b| compare_reset_strategy(a, b, true, now));
        }
        "use_before_reset_5h" => {
            list.sort_by(|a, b| compare_reset_strategy(a, b, false, now));
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

    let eff_strategy = {
        let s = normalize_strategy(cfg.strategy);
        if s == "pinned" { "most_left" } else { s }
    };

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
            let pool = if matches!(
                eff_strategy,
                "most_left" | "use_before_reset_weekly" | "use_before_reset_5h"
            ) {
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
        let pool = if matches!(
            eff_strategy,
            "most_left" | "use_before_reset_weekly" | "use_before_reset_5h"
        ) {
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
    fn weekly_and_5h_reset_strategies_rank_their_own_windows_independently() {
        let now = 1_000_000;
        // A: 70% weekly left, resets in 20h; 5h resets in 4h
        let a = mk("ag:a", ProviderKind::Antigravity, "A", 90, Some(now + 4 * 3600), 70, Some(now + 20 * 3600));
        // B: 95% weekly left, resets in 6 days; 5h resets in 4h
        let b = mk("ag:b", ProviderKind::Antigravity, "B", 100, Some(now + 4 * 3600), 95, Some(now + 6 * 86400));
        // C: 60% 5h left, resets in 40m; weekly resets in 6 days
        let c = mk("ag:c", ProviderKind::Antigravity, "C", 60, Some(now + 40 * 60), 80, Some(now + 6 * 86400));

        // Weekly mode: A wins (weekly pool expiring soonest with big balance)
        let cfg_wk = RankConfig {
            strategy: "use_before_reset_weekly",
            scope: "global",
            count: 3,
            pin_active: false,
            active_id: None,
            pinned_ids: &[],
        };
        let picks_wk = compute_ranked_picks(&[b.clone(), c.clone(), a.clone()], &HashMap::new(), &cfg_wk, now);
        assert_eq!(picks_wk[0].account_name, "A");
        assert!(picks_wk[0].use_before_reset);
        assert_eq!(picks_wk[0].tag, "週將重設");

        // 5h mode: C wins (5h pool resetting in 40m with 60% spendable)
        let cfg_5h = RankConfig {
            strategy: "use_before_reset_5h",
            scope: "global",
            count: 3,
            pin_active: false,
            active_id: None,
            pinned_ids: &[],
        };
        let picks_5h = compute_ranked_picks(&[b, c, a], &HashMap::new(), &cfg_5h, now);
        assert_eq!(picks_5h[0].account_name, "C");
        assert!(picks_5h[0].use_before_reset);
        assert_eq!(picks_5h[0].tag, "5h 將重設");
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

    #[test]
    fn weekly_strategy_prefers_sooner_reset_over_fresh_full_account_and_reports_true_weekly_pct() {
        let now = 1_000_000;
        // Kai: 29% weekly left, resets in 91h (~3.8d) -> earliest reset
        let kai = mk("c:kai", ProviderKind::Claude, "Kai", 91, Some(now + 4 * 3600), 29, Some(now + 91 * 3600));
        // km0529: 52% weekly left, resets in 126h (~5.3d)
        let km = mk("ag:km", ProviderKind::Antigravity, "km0529", 100, Some(now + 5 * 3600), 52, Some(now + 126 * 3600));
        // Itri: 88% weekly left, resets in 145h (~6d)
        let itri = mk("ag:itri", ProviderKind::Antigravity, "Itri", 100, Some(now + 5 * 3600), 88, Some(now + 145 * 3600));
        // retis: 5h=95%, weekly=98%, resets in 161h (~6.7d) -> freshly reset
        let retis = mk("c:retis", ProviderKind::Claude, "retis", 95, Some(now + 4 * 3600), 98, Some(now + 161 * 3600));

        let cfg = RankConfig {
            strategy: "use_before_reset_weekly",
            scope: "global",
            count: 4,
            pin_active: false,
            active_id: None,
            pinned_ids: &[],
        };
        let picks = compute_ranked_picks(&[retis, itri, km, kai], &HashMap::new(), &cfg, now);
        let names: Vec<&str> = picks.iter().map(|p| p.account_name.as_str()).collect();
        assert_eq!(names, vec!["Kai", "km0529", "Itri", "retis"]);
        // None are within 48h -> must NOT be tagged "週將重設" or flagged use_before_reset
        for p in &picks {
            assert!(!p.use_before_reset);
            assert_eq!(p.tag, "較早重設");
        }
        // retis reason must reflect its actual 98% weekly pool, not 5h 95%
        assert!(picks[3].reason.contains("98%"), "reason was: {}", picks[3].reason);
    }
}
