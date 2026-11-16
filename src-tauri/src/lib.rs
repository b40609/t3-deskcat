mod discovery;
mod models;
mod providers;
mod settings;

use crate::discovery::{discover_accounts, DiscoveredAccount};
use crate::models::{
    AccountQuota, AppSettings, CatMood, DashboardSnapshot, ProviderKind, ScoreMode, SmartPick,
};
use crate::providers::{
    antigravity::fetch_antigravity_quota, claude::fetch_claude_quota, codex::fetch_codex_quota,
};
use chrono::Utc;
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

struct InnerState {
    settings: AppSettings,
    snapshot: Option<DashboardSnapshot>,
    low_notified: HashMap<String, bool>,
    zero_notified: HashMap<String, bool>,
    prev_effective: HashMap<String, i32>,
    panel_pinned: bool,
    last_toggle: Instant,
    tray_id: String,
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
    let updated_snapshot;
    {
        let mut guard = state.0.lock().map_err(|_| "State poisoned".to_string())?;
        old_startup = guard.settings.launch_at_startup;
        let mut clean = new_settings;
        clean.pet_size = clean.pet_size.clamp(48, 128);
        clean.sleeping_threshold = clean.sleeping_threshold.clamp(0, 90);
        clean.working_threshold = clean
            .working_threshold
            .clamp(clean.sleeping_threshold + 1, 99);
        clean.notify_low_threshold = clean.notify_low_threshold.clamp(1, 90);
        clean.refresh_interval_secs = clean.refresh_interval_secs.clamp(30, 3600);

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

    if let Some(snap) = updated_snapshot {
        sync_tray_tooltip(&app, &state, &snap.tooltip_text);
        let _ = app.emit("snapshot-updated", &snap);
        return Ok(snap);
    }

    Err("Snapshot not initialized yet".to_string())
}

#[tauri::command]
fn toggle_panel(app: AppHandle, state: tauri::State<SharedState>) -> Result<bool, String> {
    {
        let mut guard = state.0.lock().map_err(|_| "State poisoned".to_string())?;
        if guard.last_toggle.elapsed() < Duration::from_millis(160) {
            return Ok(false);
        }
        guard.last_toggle = Instant::now();
    }

    let Some(panel) = app.get_webview_window("panel") else {
        return Err("Panel window missing".to_string());
    };

    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        Ok(false)
    } else {
        position_panel_near_pet(&app, &panel);
        let _ = panel.show();
        let _ = panel.set_focus();
        Ok(true)
    }
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
    let Ok(pos) = pet.outer_position() else {
        return;
    };
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

    // Sequence Claude calls with 350ms delay to avoid Anthropic OAuth 429
    let mut claude_results = Vec::with_capacity(claude_accounts.len());
    for (idx, acc) in claude_accounts.into_iter().enumerate() {
        if idx > 0 {
            tokio::time::sleep(Duration::from_millis(350)).await;
        }
        if let DiscoveredAccount::Claude {
            id,
            name,
            credentials_path,
        } = acc
        {
            claude_results.push(fetch_claude_quota(&client, id, name, &credentials_path).await);
        }
    }

    let mut accounts = Vec::with_capacity(handles.len() + claude_results.len());
    for handle in handles {
        if let Ok(res) = handle.await {
            accounts.push(res);
        }
    }
    accounts.extend(claude_results);

    // If any account hit cooldown (429), preserve previous quota if available
    if let Ok(guard) = state.0.lock() {
        if let Some(prev_snap) = &guard.snapshot {
            for acc in &mut accounts {
                if acc.status == "cooldown" {
                    if let Some(prev) = prev_snap
                        .accounts
                        .iter()
                        .find(|p| p.id == acc.id && p.status == "ok")
                    {
                        acc.effective_remaining = prev.effective_remaining;
                        acc.primary_windows = prev.primary_windows.clone();
                        acc.extra_windows = prev.extra_windows.clone();
                    }
                }
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
        };
        recompute_snapshot_metrics(&mut snap, &cfg);

        if cfg.notify_enabled {
            for acc in &snap.accounts {
                if acc.status != "ok" {
                    continue;
                }
                let rem = acc.effective_remaining;
                let prev = guard.prev_effective.get(&acc.id).copied();

                // Reset / recovery detection
                if let Some(prev_val) = prev {
                    if prev_val < 80 && rem >= 98 {
                        notifications.push((
                            format!("✨ {} ({}) 額度已重置", acc.provider.short_label(), acc.name),
                            format!("已恢復至 {rem}%，小貓繼續上工！"),
                        ));
                    }
                }
                guard.prev_effective.insert(acc.id.clone(), rem);

                // Exhausted detection
                if rem == 0 {
                    if !guard.zero_notified.get(&acc.id).copied().unwrap_or(false) {
                        guard.zero_notified.insert(acc.id.clone(), true);
                        guard.low_notified.insert(acc.id.clone(), true);
                        notifications.push((
                            format!("😴 {} ({}) 額度已見底", acc.provider.short_label(), acc.name),
                            "剩餘 0%，請切換推薦帳號或等待重置。".to_string(),
                        ));
                    }
                } else {
                    if rem > 10 {
                        guard.zero_notified.insert(acc.id.clone(), false);
                    }
                    if rem <= cfg.notify_low_threshold {
                        if !guard.low_notified.get(&acc.id).copied().unwrap_or(false) {
                            guard.low_notified.insert(acc.id.clone(), true);
                            notifications.push((
                                format!("⚠️ {} ({}) 額度偏低", acc.provider.short_label(), acc.name),
                                format!("目前僅剩 {rem}%（警戒線 {}%）。", cfg.notify_low_threshold),
                            ));
                        }
                    } else if rem >= cfg.notify_low_threshold + 10 {
                        guard.low_notified.insert(acc.id.clone(), false);
                    }
                }
            }
        }

        guard.snapshot = Some(snap.clone());
        snap
    };

    for (title, body) in notifications {
        let _ = app.notification().builder().title(&title).body(&body).show();
    }

    sync_tray_tooltip(app, state, &snapshot.tooltip_text);
    let _ = app.emit("snapshot-updated", &snapshot);
    snapshot
}

fn recompute_snapshot_metrics(snap: &mut DashboardSnapshot, settings: &AppSettings) {
    let picks = compute_picks(&snap.accounts);
    let tooltip = format_tooltip(&picks, &snap.accounts);
    let score = compute_overall_score(&snap.accounts, settings.score_mode);
    let mood = if score == 0 || score < settings.sleeping_threshold {
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
    snap.settings = settings.clone();
}

fn compute_picks(accounts: &[AccountQuota]) -> Vec<SmartPick> {
    let mut picks = Vec::new();
    for provider in [ProviderKind::Claude, ProviderKind::Antigravity] {
        let candidates: Vec<&AccountQuota> = accounts
            .iter()
            .filter(|a| a.provider == provider && a.status == "ok" && a.effective_remaining > 0)
            .collect();
        if candidates.is_empty() {
            continue;
        }

        let best = candidates
            .into_iter()
            .max_by(|a, b| compare_accounts(a, b))
            .unwrap();

        let reason = build_pick_reason(best);
        picks.push(SmartPick {
            provider,
            account_id: best.id.clone(),
            account_name: best.name.clone(),
            effective_remaining: best.effective_remaining,
            reason,
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
            "{}: {} {}%",
            pick.provider.short_label(),
            pick.account_name,
            pick.effective_remaining
        ));
    }
    if parts.is_empty() {
        if let Some(codex) = accounts
            .iter()
            .find(|a| a.provider == ProviderKind::Codex && a.status == "ok")
        {
            parts.push(format!("ChatGPT: {}%", codex.effective_remaining));
        } else {
            return "T3 DeskCat（載入額度中…）".to_string();
        }
    }
    parts.join("｜")
}

fn compute_overall_score(accounts: &[AccountQuota], mode: ScoreMode) -> i32 {
    let ok_accounts: Vec<&AccountQuota> =
        accounts.iter().filter(|a| a.status == "ok").collect();
    if ok_accounts.is_empty() {
        return 100; // Default awake while loading or offline
    }

    match mode {
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
            if best_per_provider.is_empty() {
                return 0;
            }
            let sum: i32 = best_per_provider.iter().sum();
            (sum as f64 / best_per_provider.len() as f64).round() as i32
        }
    }
}

fn sync_tray_tooltip(app: &AppHandle, state: &SharedState, text: &str) {
    let tray_id = state
        .0
        .lock()
        .map(|g| g.tray_id.clone())
        .unwrap_or_else(|_| "main-tray".to_string());
    if let Some(tray) = app.tray_by_id(&tray_id) {
        let _ = tray.set_tooltip(Some(text));
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
        low_notified: HashMap::new(),
        zero_notified: HashMap::new(),
        prev_effective: HashMap::new(),
        panel_pinned: false,
        last_toggle: Instant::now() - Duration::from_secs(5),
        tray_id: "main-tray".to_string(),
    })));

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
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
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            position_pet_initial(&handle, &loaded_settings);

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
                            if let Some(panel) = app.get_webview_window("panel") {
                                if panel.is_visible().unwrap_or(false) {
                                    let _ = panel.hide();
                                } else {
                                    position_panel_near_pet(app, &panel);
                                    let _ = panel.show();
                                    let _ = panel.set_focus();
                                }
                            }
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
                        let app = tray.app_handle();
                        if let Some(panel) = app.get_webview_window("panel") {
                            if panel.is_visible().unwrap_or(false) {
                                let _ = panel.hide();
                            } else {
                                position_panel_near_pet(app, &panel);
                                let _ = panel.show();
                                let _ = panel.set_focus();
                            }
                        }
                    }
                });

            let _ = tray_builder.build(app)?;

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

        let picks = compute_picks(&accounts);
        assert_eq!(picks.len(), 2);
        assert_eq!(picks[0].account_name, "Beta");
        assert_eq!(picks[1].account_name, "Delta");

        let tip = format_tooltip(&picks, &accounts);
        assert_eq!(tip, "Claude: Beta 94%｜AG: Delta 88%");
    }

    #[test]
    fn score_modes_and_mood_thresholds_work_as_configured() {
        let accounts = vec![
            mock_acc("c1", ProviderKind::Claude, "A", 10),
            mock_acc("c2", ProviderKind::Claude, "B", 80),
            mock_acc("a1", ProviderKind::Antigravity, "C", 20),
            mock_acc("a2", ProviderKind::Antigravity, "D", 90),
        ];

        assert_eq!(compute_overall_score(&accounts, ScoreMode::MaxAvg), 85);
        assert_eq!(compute_overall_score(&accounts, ScoreMode::AllAvg), 50);

        let settings = AppSettings::default();
        let mut snap = DashboardSnapshot {
            accounts,
            picks: Vec::new(),
            overall_score: 0,
            mood: CatMood::Working,
            tooltip_text: String::new(),
            last_refreshed_at: 0,
            settings: settings.clone(),
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

