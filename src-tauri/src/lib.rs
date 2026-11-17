mod discovery;
mod forecast;
mod history;
mod mobile;
mod models;
mod notify_state;
mod providers;
mod quota_cache;
mod settings;
mod tray_icon;
mod usage_stats;

use crate::discovery::{discover_accounts, DiscoveredAccount};
use crate::models::{
    AccountQuota, AppSettings, CatMood, DashboardSnapshot, ProviderKind, QuotaWindow, ScoreMode,
    SmartPick,
};
use crate::providers::{
    antigravity::fetch_antigravity_quota, claude::fetch_claude_quota, codex::fetch_codex_quota,
};
use chrono::{Local, Timelike, Utc};
use reqwest::Client;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, Position, Size,
    WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_notification::NotificationExt;
use history::History;
use notify_state::NotifyState;
use quota_cache::QuotaCache;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

struct InnerState {
    settings: AppSettings,
    snapshot: Option<DashboardSnapshot>,
    /// Alert bookkeeping, persisted across restarts.
    notify: NotifyState,
    panel_pinned: bool,
    last_toggle: Instant,
    tray_id: String,
    cache: QuotaCache,
    history: History,
    hotkey_error: Option<String>,
    /// What the tray icon currently shows, to skip redundant redraws.
    tray_icon_key: String,
    /// Phone page: URL while serving, or why it isn't.
    mobile_status: MobileStatus,
}

#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileStatus {
    url: Option<String>,
    error: Option<String>,
}

#[tauri::command]
fn mobile_status(state: tauri::State<SharedState>) -> MobileStatus {
    state.0.lock().map(|g| g.mobile_status.clone()).unwrap_or_default()
}

/// Keep the phone page server matching the settings and the Tailscale address
/// (Tailscale may start after DeskCat, or its address may change).
fn spawn_mobile_supervisor(state: SharedState) {
    tauri::async_runtime::spawn(async move {
        let mut running: Option<(std::net::SocketAddr, tauri::async_runtime::JoinHandle<()>)> = None;
        loop {
            let (enabled, port) = state
                .0
                .lock()
                .map(|g| (g.settings.mobile_enabled, g.settings.mobile_port))
                .unwrap_or((false, 8765));
            let ip = if enabled { mobile::tailscale_ip() } else { None };
            let want = ip.map(|ip| std::net::SocketAddr::from((ip, port)));
            let finished = running.as_ref().is_some_and(|(_, h)| h.inner().is_finished());
            if running.as_ref().map(|(a, _)| *a) != want || finished {
                if let Some((_, h)) = running.take() {
                    h.abort();
                }
                let mut status = MobileStatus::default();
                if let Some(addr) = want {
                    let st = state.clone();
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    let handle = tauri::async_runtime::spawn(async move {
                        let snap = move || st.0.lock().ok().and_then(|g| g.snapshot.clone());
                        let res = mobile::serve(addr, snap).await;
                        let _ = tx.send(res.err().map(|e| e.to_string()));
                    });
                    // Give bind a moment so a port clash is reported right away.
                    match tokio::time::timeout(Duration::from_millis(500), rx).await {
                        Ok(Ok(Some(err))) => status.error = Some(format!("無法開啟連接埠 {port}：{err}")),
                        _ => {
                            status.url = Some(format!("http://{addr}"));
                            running = Some((addr, handle));
                        }
                    }
                } else if enabled {
                    status.error = Some("找不到 Tailscale：請在這台電腦開啟 Tailscale".to_string());
                }
                if let Ok(mut g) = state.0.lock() {
                    g.mobile_status = status;
                }
            }
            tokio::time::sleep(Duration::from_secs(if want.is_some() { 30 } else { 10 })).await;
        }
    });
}

#[derive(Clone)]
struct SharedState(Arc<Mutex<InnerState>>);

#[tauri::command]
fn get_snapshot(state: tauri::State<SharedState>) -> Option<DashboardSnapshot> {
    state.0.lock().ok().and_then(|s| s.snapshot.clone())
}

#[tauri::command]
fn get_settings(state: tauri::State<SharedState>) -> AppSettings {
    state
        .0
        .lock()
        .map(|s| s.settings.clone())
        .unwrap_or_default()
}

#[tauri::command]
async fn refresh_now(
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<DashboardSnapshot, String> {
    Ok(run_refresh(&app, &state).await)
}

#[tauri::command]
fn update_settings(
    app: AppHandle,
    state: tauri::State<SharedState>,
    new_settings: AppSettings,
) -> Result<DashboardSnapshot, String> {
    let old_startup;
    let old_hotkey;
    let updated_snapshot;
    {
        let mut guard = state.0.lock().map_err(|_| "State poisoned".to_string())?;
        old_startup = guard.settings.launch_at_startup;
        old_hotkey = guard.settings.hotkey.clone();
        let mut clean = new_settings;
        settings::sanitize(&mut clean);

        // Preserve saved pet coordinates if caller passed None
        if clean.pet_x.is_none() {
            clean.pet_x = guard.settings.pet_x;
        }
        if clean.pet_y.is_none() {
            clean.pet_y = guard.settings.pet_y;
        }
        if clean.custom_image_working.is_none() {
            clean.custom_image_working = guard.settings.custom_image_working.clone();
        }
        if clean.custom_image_sweating.is_none() {
            clean.custom_image_sweating = guard.settings.custom_image_sweating.clone();
        }
        if clean.custom_image_sleeping.is_none() {
            clean.custom_image_sleeping = guard.settings.custom_image_sleeping.clone();
        }

        settings::save_settings(&clean)?;
        guard.settings = clean.clone();

        if let Some(pet) = app.get_webview_window("pet") {
            let _ = pet.set_size(Size::Logical(LogicalSize::new(
                clean.pet_size as f64,
                clean.pet_size as f64,
            )));
        }

        if let Some(ref mut snap) = guard.snapshot {
            recompute_snapshot_metrics(snap, &clean);
            updated_snapshot = Some(snap.clone());
        } else {
            updated_snapshot = None;
        }
    }

    if old_startup != state.0.lock().map(|g| g.settings.launch_at_startup).unwrap_or(false) {
        let enabled = state
            .0
            .lock()
            .map(|g| g.settings.launch_at_startup)
            .unwrap_or(false);
        let autostart = app.autolaunch();
        let _ = if enabled {
            autostart.enable()
        } else {
            autostart.disable()
        };
    }

    let new_hotkey = state.0.lock().map(|g| g.settings.hotkey.clone()).unwrap_or_default();
    if new_hotkey != old_hotkey {
        let err = apply_hotkey(&app, &new_hotkey);
        if let Ok(mut g) = state.0.lock() {
            g.hotkey_error = err;
        }
    }

    if let Some(snap) = updated_snapshot {
        sync_tray(&app, &state, &snap);
        let _ = app.emit("snapshot-updated", &snap);
        return Ok(snap);
    }

    Err("Snapshot not initialized yet".to_string())
}

#[tauri::command]
fn toggle_panel(app: AppHandle) -> Result<bool, String> {
    toggle_panel_window(&app).ok_or_else(|| "Panel window missing".to_string())
}

/// Show (positioned per settings) or hide the panel. Returns the new visibility.
fn toggle_panel_window(app: &AppHandle) -> Option<bool> {
    if let Some(state) = app.try_state::<SharedState>() {
        if let Ok(mut guard) = state.0.lock() {
            if guard.last_toggle.elapsed() < Duration::from_millis(160) {
                return Some(false);
            }
            guard.last_toggle = Instant::now();
        }
    }
    let panel = app.get_webview_window("panel")?;
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        Some(false)
    } else {
        position_panel(app, &panel);
        let _ = panel.show();
        let _ = panel.set_focus();
        Some(true)
    }
}

/// (Re)register the global shortcut. Returns a user-facing error, if any.
fn apply_hotkey(app: &AppHandle, combo: &str) -> Option<String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if combo.trim().is_empty() {
        return None;
    }
    match combo.parse::<Shortcut>() {
        Ok(sc) => gs
            .register(sc)
            .err()
            .map(|_| format!("{combo} 無法註冊，可能已被其他程式佔用")),
        Err(_) => Some(format!("{combo} 不是有效的快捷鍵")),
    }
}

#[tauri::command]
fn hotkey_status(state: tauri::State<SharedState>) -> Option<String> {
    state.0.lock().ok().and_then(|g| g.hotkey_error.clone())
}

#[tauri::command]
fn get_history(state: tauri::State<SharedState>) -> HashMap<String, Vec<(i64, i32)>> {
    state
        .0
        .lock()
        .map(|g| {
            // Sparklines only need the per-account series.
            g.history
                .samples
                .iter()
                .filter(|(k, _)| !k.contains('|'))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
fn hide_panel(app: AppHandle, state: tauri::State<SharedState>) {
    let pinned = state.0.lock().map(|g| g.panel_pinned).unwrap_or(false);
    if pinned {
        return;
    }
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.hide();
    }
}

#[tauri::command]
fn set_panel_pinned(state: tauri::State<SharedState>, pinned: bool) {
    if let Ok(mut guard) = state.0.lock() {
        guard.panel_pinned = pinned;
    }
}

#[tauri::command]
fn save_pet_position(app: AppHandle, state: tauri::State<SharedState>) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let Ok(mut pos) = pet.outer_position() else {
        return;
    };
    let snap = state.0.lock().map(|g| g.settings.pet_snap_edge).unwrap_or(false);
    if snap {
        if let (Ok(Some(mon)), Ok(size)) = (pet.current_monitor(), pet.outer_size()) {
            let wa = mon.work_area();
            let th = (28.0 * mon.scale_factor()).round() as i32;
            let (l, t) = (wa.position.x, wa.position.y);
            let (r, b) = (l + wa.size.width as i32, t + wa.size.height as i32);
            let (w, h) = (size.width as i32, size.height as i32);
            let (mut x, mut y) = (pos.x, pos.y);
            if (x - l).abs() < th {
                x = l;
            } else if (r - (x + w)).abs() < th {
                x = r - w;
            }
            if (y - t).abs() < th {
                y = t;
            } else if (b - (y + h)).abs() < th {
                y = b - h;
            }
            if (x, y) != (pos.x, pos.y) {
                let _ = pet.set_position(Position::Physical(PhysicalPosition::new(x, y)));
                pos = PhysicalPosition::new(x, y);
            }
        }
    }
    if let Ok(mut guard) = state.0.lock() {
        guard.settings.pet_x = Some(pos.x);
        guard.settings.pet_y = Some(pos.y);
        let _ = settings::save_settings(&guard.settings);
    }
}

#[tauri::command]
fn test_notification(app: AppHandle) -> Result<(), String> {
    app.notification()
        .builder()
        .title("T3 DeskCat")
        .body("系統通知運作正常！額度過低或重置時會在這裡提醒你。")
        .show()
        .map_err(|err| format!("通知發送失敗: {err}"))
}

#[tauri::command]
fn preview_mood(app: AppHandle, mood: CatMood) {
    let _ = app.emit("preview-mood", mood);
}

#[tauri::command]
fn clear_custom_images(
    app: AppHandle,
    state: tauri::State<SharedState>,
) -> Result<DashboardSnapshot, String> {
    let mut guard = state.0.lock().map_err(|_| "State poisoned".to_string())?;
    guard.settings.custom_image_working = None;
    guard.settings.custom_image_sweating = None;
    guard.settings.custom_image_sleeping = None;
    settings::save_settings(&guard.settings)?;
    let clean_settings = guard.settings.clone();
    if let Some(ref mut snap) = guard.snapshot {
        snap.settings = clean_settings;
        let snap_clone = snap.clone();
        let _ = app.emit("snapshot-updated", &snap_clone);
        return Ok(snap_clone);
    }
    Err("Snapshot not ready".to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

async fn run_refresh(app: &AppHandle, state: &SharedState) -> DashboardSnapshot {
    let discovered = discover_accounts();

    // Today's tokens from the local CLI logs, scanned on a blocking thread while
    // the network fetches run.
    let usage_sources: Vec<usage_stats::Source> = discovered
        .iter()
        .filter_map(|a| match a {
            DiscoveredAccount::Claude { id, credentials_path, .. } => {
                credentials_path.parent().map(|d| usage_stats::Source::Claude {
                    account_id: id.clone(),
                    config_dir: d.to_path_buf(),
                })
            }
            DiscoveredAccount::Codex { id, auth_path, .. } => {
                auth_path.parent().map(|d| usage_stats::Source::Codex {
                    account_id: id.clone(),
                    codex_home: d.to_path_buf(),
                })
            }
            _ => None,
        })
        .collect();
    let want_usage = state.0.lock().map(|g| g.settings.show_usage_stats).unwrap_or(true);
    let usage_task = want_usage
        .then(|| tokio::task::spawn_blocking(move || usage_stats::compute(&usage_sources)));

    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| Client::new());

    let mut non_claude = Vec::new();
    let mut claude_accounts = Vec::new();

    for acc in discovered {
        match acc {
            DiscoveredAccount::Claude { .. } => claude_accounts.push(acc),
            _ => non_claude.push(acc),
        }
    }

    let mut handles = Vec::with_capacity(non_claude.len());
    for acc in non_claude {
        let client = client.clone();
        handles.push(tokio::spawn(async move {
            match acc {
                DiscoveredAccount::Antigravity {
                    id,
                    name,
                    token_path,
                    is_legacy_gemini,
                } => {
                    fetch_antigravity_quota(&client, id, name, &token_path, is_legacy_gemini).await
                }
                DiscoveredAccount::Codex {
                    id,
                    name,
                    auth_path,
                } => fetch_codex_quota(&client, id, name, &auth_path).await,
                _ => unreachable!(),
            }
        }));
    }

    // Claude: sequential, spaced out, and gated by per-account backoff so a
    // 429 is never retried while the server-side limit is still active.
    let mut claude_results = Vec::with_capacity(claude_accounts.len());
    let mut fetched_any = false;
    for acc in claude_accounts {
        let DiscoveredAccount::Claude {
            id,
            name,
            credentials_path,
        } = acc
        else {
            continue;
        };
        let now = Utc::now().timestamp();
        let allowed = state
            .0
            .lock()
            .map(|g| {
                let min = g.settings.claude_min_interval_secs as i64;
                g.cache.may_fetch(&id, now, min)
            })
            .unwrap_or(true);
        if !allowed {
            let placeholder = AccountQuota {
                id: id.clone(),
                provider: ProviderKind::Claude,
                name,
                plan: None,
                effective_remaining: 0,
                primary_windows: Vec::new(),
                extra_windows: Vec::new(),
                status: "cooldown".to_string(),
                error: Some("Anthropic 暫時限制查詢，稍後自動重試".to_string()),
                updated_at: now,
            };
            let shown = state
                .0
                .lock()
                .map(|g| g.cache.skipped(&id, placeholder.clone(), now))
                .unwrap_or(placeholder);
            claude_results.push(shown);
            continue;
        }
        if fetched_any {
            tokio::time::sleep(Duration::from_millis(1200)).await;
        }
        fetched_any = true;
        if let Ok(mut g) = state.0.lock() {
            g.cache.note_attempt(&id, now);
        }
        let fresh = fetch_claude_quota(&client, id, name, &credentials_path).await;
        claude_results.push(fresh);
    }

    let mut accounts = Vec::with_capacity(handles.len() + claude_results.len());
    for handle in handles {
        if let Ok(res) = handle.await {
            accounts.push(res);
        }
    }
    accounts.extend(claude_results);

    let usage_today: HashMap<String, usage_stats::UsageToday> = match usage_task {
        Some(task) => task
            .await
            .map(|list| {
                list.into_iter()
                    .filter(|u| u.requests > 0)
                    .map(|u| (u.account_id.clone(), u))
                    .collect()
            })
            .unwrap_or_default(),
        None => HashMap::new(),
    };

    // Never let a transient failure (429 / network / 5xx) wipe an account to 0%:
    // fall back to the last good data (persisted across restarts).
    let mut forecasts = HashMap::new();
    if let Ok(mut guard) = state.0.lock() {
        let now = Utc::now().timestamp();
        accounts = accounts
            .into_iter()
            .map(|acc| {
                if acc.status == "stale" {
                    acc // already resolved from cache (skipped fetch)
                } else {
                    guard.cache.reconcile(acc, now)
                }
            })
            .collect();
        guard.cache.save();

        for acc in accounts.iter().filter(|a| a.status == "ok") {
            guard.history.record(&acc.id, now, acc.effective_remaining);
            // Per-window series for the depletion forecast.
            for w in acc.primary_windows.iter().filter(|w| !w.label.contains(' ')) {
                guard.history.record(&forecast::window_key(&acc.id, &w.label), now, w.remaining_percent);
            }
        }
        guard.history.prune(now);
        guard.history.save();

        for acc in &accounts {
            let samples = &guard.history.samples;
            let series =
                |label: &str| samples.get(&forecast::window_key(&acc.id, label)).map(Vec::as_slice);
            if let Some(f) = forecast::forecast(acc, series, now) {
                forecasts.insert(acc.id.clone(), f);
            }
        }
    }

    let now = Utc::now().timestamp();
    let mut notifications: Vec<(String, String)> = Vec::new();

    let snapshot = {
        let mut guard = state.0.lock().expect("state lock");
        let cfg = guard.settings.clone();

        let mut snap = DashboardSnapshot {
            accounts,
            picks: Vec::new(),
            overall_score: 0,
            mood: CatMood::Working,
            tooltip_text: String::new(),
            last_refreshed_at: now,
            settings: cfg.clone(),
            offline: false,
            forecasts,
            usage_today,
        };
        recompute_snapshot_metrics(&mut snap, &cfg);

        let mut n = std::mem::take(&mut guard.notify);
        if cfg.notify_enabled {
            for acc in snap.accounts.iter().filter(|a| !cfg.is_hidden(&a.id)) {
                let name = cfg.display_name(acc);
                let who = format!("{} ({})", acc.provider.short_label(), name);

                // Remember windows that are mostly used, so their reset can be announced
                // even when the reset happens between fetches (or while rate-limited).
                if cfg.notify_on_reset && is_usable(acc) {
                    for w in &acc.primary_windows {
                        if let (Some(r), true) = (w.reset_at, w.remaining_percent < 50) {
                            n.pending_resets.insert(format!("{}|{}", acc.id, w.label), (r, acc.id.clone(), w.label.clone()));
                        }
                    }
                }

                if acc.status != "ok" {
                    continue; // threshold alerts only on fresh data
                }
                let rem = acc.effective_remaining;
                let prev = n.prev_effective.get(&acc.id).copied();
                let has_reset_times = acc.primary_windows.iter().any(|w| w.reset_at.is_some());

                // Fallback reset detection for providers without reset timestamps
                if cfg.notify_on_reset && !has_reset_times {
                    if let Some(prev_val) = prev {
                        if prev_val < 80 && rem >= 98 {
                            notifications.push((
                                format!("✨ {who} 額度已恢復"),
                                format!("已恢復至 {rem}%，小貓繼續上工！"),
                            ));
                        }
                    }
                }
                n.prev_effective.insert(acc.id.clone(), rem);

                let low = cfg.low_threshold_for(&acc.id);
                if rem == 0 {
                    if !n.zero_notified.get(&acc.id).copied().unwrap_or(false) {
                        n.zero_notified.insert(acc.id.clone(), true);
                        n.low_notified.insert(acc.id.clone(), true);
                        notifications.push((
                            format!("😴 {who} 額度已見底"),
                            "剩餘 0%，請切換推薦帳號或等待重設。".to_string(),
                        ));
                    }
                } else {
                    if rem > 10 {
                        n.zero_notified.insert(acc.id.clone(), false);
                    }
                    if rem <= low {
                        if !n.low_notified.get(&acc.id).copied().unwrap_or(false) {
                            n.low_notified.insert(acc.id.clone(), true);
                            notifications.push((
                                format!("⚠️ {who} 額度偏低"),
                                format!("目前僅剩 {rem}%（警戒線 {low}%）。"),
                            ));
                        }
                    } else if rem >= low + 10 {
                        n.low_notified.insert(acc.id.clone(), false);
                    }
                }
            }

            // Announce windows whose reset time has passed.
            let due: Vec<String> = n
                .pending_resets
                .iter()
                .filter(|(_, (r, _, _))| *r <= now)
                .map(|(k, _)| k.clone())
                .collect();
            for key in due {
                if let Some((_, id, label)) = n.pending_resets.remove(&key) {
                    if !cfg.notify_on_reset || cfg.is_hidden(&id) {
                        continue;
                    }
                    if let Some(acc) = snap.accounts.iter().find(|a| a.id == id) {
                        notifications.push((
                            format!("✨ {} 的{}已重設", cfg.display_name(acc), window_label_zh(&label)),
                            format!("{} 額度已恢復，可以繼續使用了。", acc.provider.short_label()),
                        ));
                    }
                }
            }
        } else {
            n.pending_resets.clear();
            n.quiet_backlog.clear();
        }

        // Do-not-disturb: hold alerts, then send one summary when the window ends.
        let local = Local::now();
        if cfg.in_quiet_hours(local.hour() * 60 + local.minute()) {
            n.defer(std::mem::take(&mut notifications));
        } else if let Some(summary) = n.take_backlog_summary() {
            notifications.insert(0, summary);
        }
        n.save();
        guard.notify = n;

        guard.snapshot = Some(snap.clone());
        snap
    };

    for (title, body) in notifications {
        let _ = app.notification().builder().title(&title).body(&body).show();
    }

    sync_tray(app, state, &snapshot);
    let _ = app.emit("snapshot-updated", &snapshot);
    snapshot
}

fn recompute_snapshot_metrics(snap: &mut DashboardSnapshot, settings: &AppSettings) {
    // Hidden accounts drop out entirely; aliases replace names in picks / tooltip.
    let visible: Vec<AccountQuota> = snap
        .accounts
        .iter()
        .filter(|a| !settings.is_hidden(&a.id))
        .cloned()
        .map(|mut a| {
            a.name = settings.display_name(&a);
            a
        })
        .collect();
    let scored: Vec<AccountQuota> = visible
        .iter()
        .filter(|a| settings.counts_in_score(&a.id))
        .cloned()
        .collect();
    let offline = !visible.is_empty() && !visible.iter().any(is_live);
    let picks = compute_picks(&visible, Utc::now().timestamp());
    let mut tooltip = format_tooltip(&picks, &visible);
    if offline {
        tooltip = format!("暫時抓不到最新額度｜{tooltip}");
    }
    // Excluding every account from the score falls back to all visible ones.
    let score_opt = compute_overall_score(&scored, settings.score_mode)
        .or_else(|| compute_overall_score(&visible, settings.score_mode));
    let score = score_opt.unwrap_or(0);
    let mood = if score_opt.is_none() || score == 0 || score < settings.sleeping_threshold {
        CatMood::Sleeping
    } else if score <= settings.working_threshold {
        CatMood::Sweating
    } else {
        CatMood::Working
    };

    snap.picks = picks;
    snap.tooltip_text = tooltip;
    snap.overall_score = score;
    snap.mood = mood;
    snap.offline = offline;
    snap.settings = settings.clone();
}

/// Has numbers to show: fresh, cached after a failure, or last-known before the
/// token expired (an idle account's quota only changes when its windows reset,
/// which the cache already accounts for).
fn is_usable(a: &AccountQuota) -> bool {
    a.status == "ok"
        || a.status == "stale"
        || (a.status == "expired" && !a.primary_windows.is_empty())
}

/// Fresh this round, or deliberately not re-fetched yet (min interval, no error).
fn is_live(a: &AccountQuota) -> bool {
    a.status == "ok" || (a.status == "stale" && a.error.is_none())
}

/// A limit that resets within this long, with at least this much left, is
/// recommended first: whatever is left would be lost at the reset anyway.
const RESET_SOON_SECS: i64 = 30 * 60;
const RESET_SOON_MIN_LEFT: i32 = 10;

/// The limit currently capping the account (model-specific windows excluded).
fn binding_window(acc: &AccountQuota) -> Option<&QuotaWindow> {
    acc.primary_windows
        .iter()
        .filter(|w| !w.label.contains(' '))
        .min_by_key(|w| w.remaining_percent)
}

fn resets_soon(acc: &AccountQuota, now: i64) -> Option<i64> {
    let r = binding_window(acc)?.reset_at?;
    (r > now && r - now <= RESET_SOON_SECS && acc.effective_remaining >= RESET_SOON_MIN_LEFT)
        .then_some(r)
}

fn compute_picks(accounts: &[AccountQuota], now: i64) -> Vec<SmartPick> {
    let mut picks = Vec::new();
    for provider in [ProviderKind::Claude, ProviderKind::Antigravity] {
        let candidates: Vec<&AccountQuota> = accounts
            .iter()
            .filter(|a| a.provider == provider && is_usable(a) && a.effective_remaining > 0)
            .collect();
        if candidates.is_empty() {
            continue;
        }

        let soon = candidates
            .iter()
            .filter_map(|a| resets_soon(a, now).map(|r| (*a, r)))
            .max_by(|(a, _), (b, _)| compare_accounts(a, b));
        let (best, use_before_reset) = match soon {
            Some((a, _)) => (a, true),
            None => (
                candidates.iter().copied().max_by(|a, b| compare_accounts(a, b)).unwrap(),
                false,
            ),
        };

        let reset_at = binding_window(best).and_then(|w| w.reset_at).filter(|r| *r > now);
        let reason = if use_before_reset {
            let mins = ((reset_at.unwrap_or(now) - now) + 59) / 60;
            format!("{} 分鐘後重設，建議優先使用", mins.max(1))
        } else {
            build_pick_reason(best)
        };
        let note = (best.status == "expired")
            .then(|| "最後已知額度（憑證過期，切換過去用一次就會更新）".to_string());
        picks.push(SmartPick {
            provider,
            account_id: best.id.clone(),
            account_name: best.name.clone(),
            effective_remaining: best.effective_remaining,
            reason,
            reset_at,
            use_before_reset,
            note,
        });
    }
    picks
}

fn compare_accounts(a: &AccountQuota, b: &AccountQuota) -> std::cmp::Ordering {
    let a_eff = a.effective_remaining;
    let b_eff = b.effective_remaining;
    if a_eff != b_eff {
        return a_eff.cmp(&b_eff);
    }
    let a_5h = window_percent(a, "5h");
    let b_5h = window_percent(b, "5h");
    if a_5h != b_5h {
        return a_5h.cmp(&b_5h);
    }
    let a_wk = window_percent(a, "Wk");
    let b_wk = window_percent(b, "Wk");
    a_wk.cmp(&b_wk)
}

fn window_percent(acc: &AccountQuota, label: &str) -> i32 {
    acc.primary_windows
        .iter()
        .find(|w| w.label == label)
        .map(|w| w.remaining_percent)
        .unwrap_or(acc.effective_remaining)
}

fn build_pick_reason(acc: &AccountQuota) -> String {
    if acc.primary_windows.is_empty() {
        return format!("剩餘 {}%", acc.effective_remaining);
    }
    acc.primary_windows
        .iter()
        .map(|w| format!("{} {}%", w.label, w.remaining_percent))
        .collect::<Vec<_>>()
        .join(" · ")
}

fn format_tooltip(picks: &[SmartPick], accounts: &[AccountQuota]) -> String {
    let mut parts = Vec::new();
    for pick in picks {
        parts.push(format!(
            "{}: {} {}%{}",
            pick.provider.short_label(),
            pick.account_name,
            pick.effective_remaining,
            if pick.use_before_reset { "（即將重設）" } else { "" }
        ));
    }
    if parts.is_empty() {
        if let Some(codex) = accounts
            .iter()
            .find(|a| a.provider == ProviderKind::Codex && is_usable(a))
        {
            parts.push(format!("ChatGPT: {}%", codex.effective_remaining));
        } else {
            return "T3 DeskCat（載入額度中…）".to_string();
        }
    }
    parts.join("｜")
}

/// None when no account has numbers (nothing found / all failing).
fn compute_overall_score(accounts: &[AccountQuota], mode: ScoreMode) -> Option<i32> {
    let ok_accounts: Vec<&AccountQuota> =
        accounts.iter().filter(|a| is_usable(a)).collect();
    if ok_accounts.is_empty() {
        return None;
    }

    Some(match mode {
        ScoreMode::AllAvg => {
            let sum: i32 = ok_accounts.iter().map(|a| a.effective_remaining).sum();
            (sum as f64 / ok_accounts.len() as f64).round() as i32
        }
        ScoreMode::MaxAvg => {
            let mut best_per_provider = Vec::new();
            for provider in [
                ProviderKind::Claude,
                ProviderKind::Antigravity,
                ProviderKind::Codex,
            ] {
                if let Some(max_val) = ok_accounts
                    .iter()
                    .filter(|a| a.provider == provider)
                    .map(|a| a.effective_remaining)
                    .max()
                {
                    best_per_provider.push(max_val);
                }
            }
            let sum: i32 = best_per_provider.iter().sum();
            (sum as f64 / best_per_provider.len().max(1) as f64).round() as i32
        }
    })
}

fn window_label_zh(label: &str) -> String {
    let mut parts = label.splitn(2, ' ');
    let base = parts.next().unwrap_or("");
    let pool = parts.next().unwrap_or("");
    let span = match base {
        "週" => "Wk".to_string(),
        "Argon" | "3P" => {
            let name = if base == "3P" { "Claude/GPT" } else { base };
            return format!(" {name} {}", window_label_zh(pool).trim_start());
        }
        other => other.to_string(),
    };
    if pool.is_empty() {
        format!(" {span} ")
    } else {
        format!(" {span} · {pool} ")
    }
}

/// Tray tooltip (best picks + overall + today's cost) and the live number / ring icon.
fn sync_tray(app: &AppHandle, state: &SharedState, snap: &DashboardSnapshot) {
    let cfg = &snap.settings;
    let mut tip = format!("{}\n總剩餘 {}%", snap.tooltip_text, snap.overall_score);
    let cost: f64 = snap
        .usage_today
        .iter()
        .filter(|(id, _)| !cfg.is_hidden(id))
        .filter_map(|(_, u)| u.cost_usd)
        .sum();
    if cfg.show_usage_stats && cost >= 0.01 {
        tip.push_str(&format!(" · 今日約 US${cost:.2}"));
    }
    // Windows caps tray tooltips at 127 UTF-16 units.
    if tip.encode_utf16().count() > 127 {
        tip = tip.chars().take(120).collect::<String>() + "…";
    }

    let has_data = snap.accounts.iter().any(|a| !cfg.is_hidden(&a.id) && is_usable(a));
    let level = tray_icon::level_for(
        snap.overall_score,
        snap.offline || !has_data,
        cfg.working_threshold,
        cfg.sleeping_threshold,
    );
    let key = format!("{}|{}|{:?}", cfg.tray_style, snap.overall_score, level);

    let (tray_id, redraw) = match state.0.lock() {
        Ok(mut g) => {
            let redraw = g.tray_icon_key != key;
            g.tray_icon_key = key;
            (g.tray_id.clone(), redraw)
        }
        Err(_) => ("main-tray".to_string(), true),
    };
    let Some(tray) = app.tray_by_id(&tray_id) else { return };
    let _ = tray.set_tooltip(Some(&tip));
    if redraw {
        let icon = match tray_icon::render(&cfg.tray_style, Some(snap.overall_score), level) {
            Some(rgba) => Some(tauri::image::Image::new_owned(rgba, tray_icon::SIZE, tray_icon::SIZE)),
            None => app.default_window_icon().cloned(),
        };
        let _ = tray.set_icon(icon);
    }
}

fn position_pet_initial(app: &AppHandle, cfg: &AppSettings) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let _ = pet.set_size(Size::Logical(LogicalSize::new(
        cfg.pet_size as f64,
        cfg.pet_size as f64,
    )));

    if let (Some(x), Some(y)) = (cfg.pet_x, cfg.pet_y) {
        let _ = pet.set_position(Position::Physical(PhysicalPosition::new(x, y)));
        return;
    }

    if let Ok(Some(monitor)) = pet.primary_monitor() {
        let scale = monitor.scale_factor();
        let wa = monitor.work_area();
        let size_px = (cfg.pet_size as f64 * scale).round() as i32;
        let margin = (24.0 * scale).round() as i32;
        let x = wa.position.x + wa.size.width as i32 - size_px - margin;
        let y = wa.position.y + wa.size.height as i32 - size_px - margin;
        let _ = pet.set_position(Position::Physical(PhysicalPosition::new(x, y)));
    }
}

/// Place the panel according to the "panel position" setting.
fn position_panel(app: &AppHandle, panel: &tauri::WebviewWindow) {
    let where_ = app
        .try_state::<SharedState>()
        .and_then(|s| s.0.lock().ok().map(|g| g.settings.panel_position.clone()))
        .unwrap_or_else(|| "pet".to_string());
    if where_ == "pet" {
        position_panel_near_pet(app, panel);
        return;
    }
    let monitor = app
        .get_webview_window("pet")
        .and_then(|p| p.current_monitor().ok().flatten())
        .or_else(|| panel.primary_monitor().ok().flatten());
    let (Some(mon), Ok(size)) = (monitor, panel.outer_size()) else {
        position_panel_near_pet(app, panel);
        return;
    };
    let wa = mon.work_area();
    let m = (12.0 * mon.scale_factor()).round() as i32;
    let (l, t) = (wa.position.x, wa.position.y);
    let (r, b) = (l + wa.size.width as i32, t + wa.size.height as i32);
    let (w, h) = (size.width as i32, size.height as i32);
    let (x, y) = match where_.as_str() {
        "top_left" => (l + m, t + m),
        "bottom_left" => (l + m, b - h - m),
        "top_right" => (r - w - m, t + m),
        "bottom_right" => (r - w - m, b - h - m),
        _ => (l + (r - l - w) / 2, t + (b - t - h) / 2),
    };
    let _ = panel.set_position(Position::Physical(PhysicalPosition::new(x, y)));
}

fn position_panel_near_pet(app: &AppHandle, panel: &tauri::WebviewWindow) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let Ok(pet_pos) = pet.outer_position() else {
        return;
    };
    let Ok(pet_size) = pet.outer_size() else {
        return;
    };
    let Ok(panel_size) = panel.outer_size() else {
        return;
    };

    let monitor = pet
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| pet.primary_monitor().ok().flatten());

    if let Some(mon) = monitor {
        let wa = mon.work_area();
        let scale = mon.scale_factor();
        let gap = (10.0 * scale).round() as i32;

        let wa_left = wa.position.x;
        let wa_top = wa.position.y;
        let wa_right = wa.position.x + wa.size.width as i32;
        let wa_bottom = wa.position.y + wa.size.height as i32;

        let pw = panel_size.width as i32;
        let ph = panel_size.height as i32;

        // Align horizontally with pet's right edge, clamped inside work area
        let mut x = pet_pos.x + pet_size.width as i32 - pw;
        x = x.clamp(wa_left + 8, (wa_right - pw - 8).max(wa_left + 8));

        // Prefer opening above the pet if there's room, otherwise below
        let space_above = pet_pos.y - wa_top;
        let y = if space_above >= ph + gap {
            pet_pos.y - ph - gap
        } else {
            (pet_pos.y + pet_size.height as i32 + gap).min((wa_bottom - ph - 8).max(wa_top + 8))
        };

        let _ = panel.set_position(Position::Physical(PhysicalPosition::new(x, y)));
    } else {
        let _ = panel.set_position(Position::Logical(LogicalPosition::new(100.0, 100.0)));
    }
}

pub fn run() {
    let loaded_settings = settings::load_settings();
    let shared = SharedState(Arc::new(Mutex::new(InnerState {
        settings: loaded_settings.clone(),
        snapshot: None,
        notify: NotifyState::load(),
        panel_pinned: false,
        last_toggle: Instant::now() - Duration::from_secs(5),
        tray_id: "main-tray".to_string(),
        cache: QuotaCache::load(),
        history: History::load(),
        hotkey_error: None,
        tray_icon_key: String::new(),
        mobile_status: MobileStatus::default(),
    })));

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = toggle_panel_window(app);
                    }
                })
                .build(),
        )
        .manage(shared.clone())
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_settings,
            refresh_now,
            update_settings,
            toggle_panel,
            hide_panel,
            set_panel_pinned,
            save_pet_position,
            test_notification,
            preview_mood,
            clear_custom_images,
            quit_app,
            hotkey_status,
            get_history,
            mobile_status,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            position_pet_initial(&handle, &loaded_settings);
            let hk_err = apply_hotkey(&handle, &loaded_settings.hotkey);
            if let Ok(mut g) = shared.0.lock() {
                g.hotkey_error = hk_err;
            }
            if let Some(ref panel) = app.get_webview_window("panel") {
                position_panel(&handle, panel);
                let _ = panel.show();
                let _ = panel.set_focus();
            }

            // Auto-hide panel when it loses focus (unless pinned)
            if let Some(panel) = app.get_webview_window("panel") {
                let panel_handle = handle.clone();
                let panel_state = shared.clone();
                panel.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        let pinned = panel_state
                            .0
                            .lock()
                            .map(|g| g.panel_pinned)
                            .unwrap_or(false);
                        let recently_toggled = panel_state
                            .0
                            .lock()
                            .map(|g| g.last_toggle.elapsed() < Duration::from_millis(220))
                            .unwrap_or(false);
                        if !pinned && !recently_toggled {
                            if let Some(w) = panel_handle.get_webview_window("panel") {
                                let _ = w.hide();
                            }
                        }
                    }
                });
            }

            // Build Windows system tray
            let toggle_item =
                MenuItem::with_id(app, "toggle", "展開 / 收合面板", true, None::<&str>)?;
            let refresh_item =
                MenuItem::with_id(app, "refresh", "立即更新額度", true, None::<&str>)?;
            let reset_pos_item =
                MenuItem::with_id(app, "reset_pos", "重設小貓位置", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "結束 T3 DeskCat", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&toggle_item, &refresh_item, &reset_pos_item, &quit_item],
            )?;

            let tray_builder = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("T3 DeskCat")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event({
                    let state_c = shared.clone();
                    move |app, event| match event.id.as_ref() {
                        "toggle" => {
                            let _ = toggle_panel_window(app);
                        }
                        "refresh" => {
                            let h = app.clone();
                            let s = state_c.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = run_refresh(&h, &s).await;
                            });
                        }
                        "reset_pos" => {
                            if let Ok(mut guard) = state_c.0.lock() {
                                guard.settings.pet_x = None;
                                guard.settings.pet_y = None;
                                let _ = settings::save_settings(&guard.settings);
                                position_pet_initial(app, &guard.settings);
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let _ = toggle_panel_window(tray.app_handle());
                    }
                });

            let _ = tray_builder.build(app)?;

            spawn_mobile_supervisor(shared.clone());

            // Background polling loop
            let poll_app = handle.clone();
            let poll_state = shared.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let _ = run_refresh(&poll_app, &poll_state).await;
                    let interval = poll_state
                        .0
                        .lock()
                        .map(|g| g.settings.refresh_interval_secs)
                        .unwrap_or(120);
                    tokio::time::sleep(Duration::from_secs(interval)).await;
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running t3-deskcat");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::QuotaWindow;

    fn mock_acc(id: &str, provider: ProviderKind, name: &str, pct: i32) -> AccountQuota {
        AccountQuota {
            id: id.to_string(),
            provider,
            name: name.to_string(),
            plan: Some("Pro".to_string()),
            effective_remaining: pct,
            primary_windows: vec![
                QuotaWindow {
                    label: "5h".to_string(),
                    remaining_percent: pct,
                    reset_at: None,
                },
                QuotaWindow {
                    label: "Wk".to_string(),
                    remaining_percent: pct,
                    reset_at: None,
                },
            ],
            extra_windows: Vec::new(),
            status: "ok".to_string(),
            error: None,
            updated_at: 0,
        }
    }

    #[test]
    fn picks_best_accounts_and_formats_exact_tooltip() {
        let accounts = vec![
            mock_acc("c1", ProviderKind::Claude, "Alpha", 68),
            mock_acc("c2", ProviderKind::Claude, "Beta", 94),
            mock_acc("a1", ProviderKind::Antigravity, "Gamma", 74),
            mock_acc("a2", ProviderKind::Antigravity, "Delta", 88),
            mock_acc("x1", ProviderKind::Codex, "Codex", 90),
        ];

        let picks = compute_picks(&accounts, 0);
        assert_eq!(picks.len(), 2);
        assert_eq!(picks[0].account_name, "Beta");
        assert_eq!(picks[1].account_name, "Delta");

        let tip = format_tooltip(&picks, &accounts);
        assert_eq!(tip, "Claude: Beta 94%｜AG: Delta 88%");
    }

    #[test]
    fn hidden_and_excluded_accounts_and_aliases() {
        use crate::models::AccountPref;
        let accounts = vec![
            mock_acc("c1", ProviderKind::Claude, "Alpha", 90),
            mock_acc("c2", ProviderKind::Claude, "Beta", 40),
            mock_acc("a1", ProviderKind::Antigravity, "Gamma", 10),
        ];
        let mut settings = AppSettings::default();
        settings.score_mode = ScoreMode::AllAvg;
        settings
            .account_prefs
            .insert("c1".into(), AccountPref { hidden: true, ..Default::default() });
        settings.account_prefs.insert(
            "a1".into(),
            AccountPref { exclude_score: true, alias: Some("Work".into()), ..Default::default() },
        );
        let mut snap = DashboardSnapshot {
            accounts,
            picks: Vec::new(),
            overall_score: 0,
            mood: CatMood::Working,
            tooltip_text: String::new(),
            last_refreshed_at: 0,
            settings: settings.clone(),
            offline: false,
            forecasts: HashMap::new(),
            usage_today: HashMap::new(),
        };
        recompute_snapshot_metrics(&mut snap, &settings);
        assert_eq!(snap.overall_score, 40); // only Beta counts
        assert_eq!(snap.picks[0].account_name, "Beta"); // hidden Alpha not picked
        assert_eq!(snap.picks[1].account_name, "Work"); // alias, still pickable
        assert_eq!(snap.accounts.len(), 3); // raw list kept for the settings UI
    }

    fn snap_of(accounts: Vec<AccountQuota>) -> DashboardSnapshot {
        DashboardSnapshot {
            accounts,
            picks: Vec::new(),
            overall_score: 0,
            mood: CatMood::Working,
            tooltip_text: String::new(),
            last_refreshed_at: 0,
            settings: AppSettings::default(),
            offline: false,
            forecasts: HashMap::new(),
            usage_today: HashMap::new(),
        }
    }

    #[test]
    fn pick_prefers_quota_that_resets_soon() {
        let now = 1_000_000;
        let mut soon = mock_acc("c1", ProviderKind::Claude, "Kai", 12);
        soon.primary_windows[0].reset_at = Some(now + 20 * 60);
        let full = mock_acc("c2", ProviderKind::Claude, "Main", 94);
        let picks = compute_picks(&[soon.clone(), full.clone()], now);
        assert_eq!(picks[0].account_name, "Kai");
        assert!(picks[0].use_before_reset);
        assert_eq!(picks[0].reason, "20 分鐘後重設，建議優先使用");
        assert_eq!(picks[0].reset_at, Some(now + 20 * 60));

        // Under 10% left is not worth recommending first.
        let mut tiny = soon.clone();
        tiny.effective_remaining = 5;
        tiny.primary_windows[0].remaining_percent = 5;
        tiny.primary_windows[1].remaining_percent = 5;
        assert_eq!(compute_picks(&[tiny, full.clone()], now)[0].account_name, "Main");

        // Weekly is the real cap: the 5h reset doesn't free anything.
        let mut weekly_cap = soon;
        weekly_cap.primary_windows[0].remaining_percent = 60;
        weekly_cap.primary_windows[1].remaining_percent = 12;
        let p = compute_picks(&[weekly_cap, full], now);
        assert_eq!(p[0].account_name, "Main");
        assert!(!p[0].use_before_reset);
    }

    #[test]
    fn expired_account_keeps_last_known_numbers_for_picks() {
        let mut idle = mock_acc("c1", ProviderKind::Claude, "Idle", 100);
        idle.status = "expired".into();
        let busy = mock_acc("c2", ProviderKind::Claude, "Busy", 30);
        let picks = compute_picks(&[idle, busy], 0);
        assert_eq!(picks[0].account_name, "Idle");
        assert!(picks[0].note.is_some());

        // Without cached numbers an expired account is not usable.
        let mut empty = mock_acc("c3", ProviderKind::Claude, "Gone", 0);
        empty.status = "expired".into();
        empty.primary_windows.clear();
        assert!(!is_usable(&empty));
    }

    #[test]
    fn offline_when_nothing_is_fresh() {
        let settings = AppSettings::default();
        let mut a = mock_acc("c1", ProviderKind::Claude, "A", 80);
        a.status = "stale".into();
        a.error = Some("連線失敗".into());
        let mut b = mock_acc("x1", ProviderKind::Codex, "Codex", 0);
        b.status = "error".into();
        b.primary_windows.clear();

        let mut snap = snap_of(vec![a.clone(), b.clone()]);
        recompute_snapshot_metrics(&mut snap, &settings);
        assert!(snap.offline);
        assert_eq!(snap.overall_score, 80); // last-known numbers still count
        assert!(snap.tooltip_text.starts_with("暫時抓不到最新額度"));

        // Skipped only because of the min interval (no error) is not offline.
        a.error = None;
        let mut snap = snap_of(vec![a, b.clone()]);
        recompute_snapshot_metrics(&mut snap, &settings);
        assert!(!snap.offline);

        // Nothing usable at all: score 0 and the cat sleeps instead of looking happy.
        let mut snap = snap_of(vec![b]);
        recompute_snapshot_metrics(&mut snap, &settings);
        assert!(snap.offline);
        assert_eq!(snap.overall_score, 0);
        assert_eq!(snap.mood, CatMood::Sleeping);
    }

    #[test]
    fn window_labels_in_chinese() {
        assert_eq!(window_label_zh("5h"), " 5h ");
        assert_eq!(window_label_zh("Wk Sonnet"), " Wk · Sonnet ");
        assert_eq!(window_label_zh("Argon 5h"), " Argon 5h ");
    }

    #[test]
    fn score_modes_and_mood_thresholds_work_as_configured() {
        let accounts = vec![
            mock_acc("c1", ProviderKind::Claude, "A", 10),
            mock_acc("c2", ProviderKind::Claude, "B", 80),
            mock_acc("a1", ProviderKind::Antigravity, "C", 20),
            mock_acc("a2", ProviderKind::Antigravity, "D", 90),
        ];

        assert_eq!(compute_overall_score(&accounts, ScoreMode::MaxAvg), Some(85));
        assert_eq!(compute_overall_score(&accounts, ScoreMode::AllAvg), Some(50));

        let settings = AppSettings::default();
        let mut snap = DashboardSnapshot {
            accounts,
            picks: Vec::new(),
            overall_score: 0,
            mood: CatMood::Working,
            tooltip_text: String::new(),
            last_refreshed_at: 0,
            settings: settings.clone(),
            offline: false,
            forecasts: HashMap::new(),
            usage_today: HashMap::new(),
        };

        recompute_snapshot_metrics(&mut snap, &settings);
        assert_eq!(snap.mood, CatMood::Working); // 85 > 70

        let mut all_avg_settings = settings.clone();
        all_avg_settings.score_mode = ScoreMode::AllAvg;
        recompute_snapshot_metrics(&mut snap, &all_avg_settings);
        assert_eq!(snap.mood, CatMood::Sweating); // 50 in [20, 70]

        let mut high_th = all_avg_settings.clone();
        high_th.sleeping_threshold = 60;
        high_th.working_threshold = 80;
        recompute_snapshot_metrics(&mut snap, &high_th);
        assert_eq!(snap.mood, CatMood::Sleeping); // 50 < 60
    }
}

