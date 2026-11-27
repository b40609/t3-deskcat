#[cfg(all(not(debug_assertions), dev))]
compile_error!(
    "Release builds MUST enable `tauri/custom-protocol` so frontend assets from `../dist` are embedded \
     instead of connecting to http://localhost:1420. Use `npm run build:exe` or `npm run deploy:local`."
);

mod activity;
#[macro_use]
mod i18n;
mod discovery;
mod forecast;
mod history;
mod logging;
mod mobile;
mod models;
mod notify_state;
mod providers;
mod quota_cache;
mod quota_contract;
mod ranking;
mod settings;
mod support;
mod tray_icon;
mod usage_stats;

use crate::discovery::{discover_accounts, DiscoveredAccount};
use crate::models::{
    AccountQuota, AppSettings, CatMood, DashboardSnapshot, PetTheme, ProviderKind, ScoreMode,
    SmartPick,
};
use crate::providers::{
    antigravity::fetch_antigravity_quota,
    claude::{fetch_claude_quota, read_local_claude_quota},
    codex::{fetch_codex_quota, read_local_codex_quota},
    FetchOutcome,
};
use chrono::{Local, Timelike, Utc};
use reqwest::Client;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};
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

static SETUP_DONE: AtomicBool = AtomicBool::new(false);
static DIALOG_OPEN: AtomicBool = AtomicBool::new(false);

/// Background scheduler heartbeat. Each tick evaluates per-account adaptive TTLs
/// and only hits the network for accounts that are actually due.
const SCHEDULER_TICK_SECS: u64 = 30;
/// An account with local session/transcript writes inside this window is "active".
const ACTIVE_WINDOW_SECS: i64 = 15 * 60;
/// Minimum gap between full local usage-log incremental scans.
const USAGE_SCAN_MIN_SECS: i64 = 20;

// Adaptive per-provider minimum fetch intervals (seconds):
// - Active:    currently in use (local logs written within 15 min)
// - Idle:      no recent local activity (quota only moves on window resets)
// - Triggered: turn just completed, window reset passed, or panel opened on demand
// - Manual:    user explicitly clicked Refresh (short debounce to prevent double-click bursts)
const CLAUDE_ACTIVE_SECS: i64 = 300;
const CLAUDE_IDLE_SECS: i64 = 900;
const CLAUDE_TRIGGERED_SECS: i64 = 120;
const CLAUDE_MANUAL_SECS: i64 = 45;

const AG_ACTIVE_SECS: i64 = 60;
const AG_IDLE_SECS: i64 = 300;
const AG_TRIGGERED_SECS: i64 = 30;
const AG_MANUAL_SECS: i64 = 15;

const AG_CLI_ACTIVE_SECS: i64 = 180;
const AG_CLI_IDLE_SECS: i64 = 600;
const AG_CLI_TRIGGERED_SECS: i64 = 90;
const AG_CLI_MANUAL_SECS: i64 = 45;

const CODEX_ACTIVE_SECS: i64 = 120;
const CODEX_IDLE_SECS: i64 = 600;
const CODEX_TRIGGERED_SECS: i64 = 45;
const CODEX_MANUAL_SECS: i64 = 15;

#[derive(Clone, Debug, PartialEq, Eq)]
enum RefreshReason {
    /// Initial background sync immediately after startup.
    Startup,
    /// Periodic 30 s scheduler tick (respects adaptive per-account intervals).
    Scheduled,
    /// Panel was opened by the user (checks active / due accounts).
    OnDemand,
    /// Explicit Refresh button / tray Refresh click.
    Manual,
    /// Local log watcher detected an account finished a turn (`working -> done`).
    ActivityDone(String),
    /// Add-account login watcher / folder rescan: fetch newly discovered accounts only.
    DiscoverOnly,
}

struct BoolResetGuard(&'static AtomicBool);
impl Drop for BoolResetGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

struct ArcBoolGuard(Arc<RefreshRuntime>);
impl Drop for ArcBoolGuard {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::Release);
    }
}

struct RefreshRuntime {
    /// Reusable HTTP client for connection pooling & TLS session reuse.
    client: Client,
    /// Single-flight lock so concurrent triggers never hit provider APIs simultaneously.
    lock: tokio::sync::Mutex<()>,
    /// True while a refresh pass is in flight (allows non-urgent ticks to skip).
    busy: AtomicBool,
}

impl RefreshRuntime {
    fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            lock: tokio::sync::Mutex::new(()),
            busy: AtomicBool::new(false),
        }
    }
}

struct InnerState {
    settings: AppSettings,
    snapshot: Option<DashboardSnapshot>,
    /// Alert bookkeeping, persisted across restarts.
    notify: NotifyState,
    panel_pinned: bool,
    last_toggle: Instant,
    last_auto_position: Instant,
    bounds_save_seq: u64,
    tray_id: String,
    cache: QuotaCache,
    history: History,
    hotkey_error: Option<String>,
    /// What the tray icon currently shows, to skip redundant redraws.
    tray_icon_key: String,
    /// Phone page: URL while serving, or why it isn't.
    mobile_status: MobileStatus,
    /// Last observed `(mtime_secs, file_len)` per account credential file, to detect token refreshes.
    cred_stamps: HashMap<String, (i64, u64)>,
    /// Timestamp of the last local usage-log incremental scan.
    last_usage_scan: i64,
    /// Cached today's usage map reused when skipping rapid usage rescans.
    last_usage_today: HashMap<String, usage_stats::UsageToday>,
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
fn spawn_mobile_supervisor(app: AppHandle, state: SharedState) {
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
                    let remote = std::sync::Arc::new(make_remote(app.clone(), state.clone()));
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    let handle = tauri::async_runtime::spawn(async move {
                        let res = mobile::serve(addr, remote).await;
                        let _ = tx.send(res.err().map(|e| e.to_string()));
                    });
                    // Give bind a moment so a port clash is reported right away.
                    match tokio::time::timeout(Duration::from_millis(500), rx).await {
                        Ok(Ok(Some(err))) => status.error = Some(tr!("無法開啟連接埠 {port}：{err}", port = port, err = err)),
                        _ => {
                            status.url = Some(format!("http://{addr}"));
                            running = Some((addr, handle));
                        }
                    }
                } else if enabled {
                    status.error = Some(tr!("找不到 Tailscale：請在這台電腦開啟 Tailscale"));
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
struct SharedState(Arc<Mutex<InnerState>>, Arc<RefreshRuntime>);

/// The phone page's view of the app: embedded frontend files and the few
/// commands a phone may run.
fn make_remote(app: AppHandle, state: SharedState) -> mobile::Remote {
    let snap_state = state.clone();
    let asset_app = app.clone();
    mobile::Remote {
        snapshot: Box::new(move || snap_state.0.lock().ok().and_then(|g| g.snapshot.clone())),
        asset: Box::new(move |path| {
            let a = asset_app.asset_resolver().get(path.to_string())?;
            Some((a.bytes().to_vec(), a.mime_type().to_string()))
        }),
        invoke: Box::new(move |cmd, args| {
            let app = app.clone();
            let state = state.clone();
            Box::pin(async move { remote_invoke(app, state, cmd, args).await })
        }),
    }
}

/// Commands the phone may run. Settings that only make sense on this PC (start
/// with Windows, hotkey, folders, pet position, the phone server itself) are
/// kept as they are, whatever the phone sends.
async fn remote_invoke(
    app: AppHandle,
    state: SharedState,
    cmd: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, (u16, String)> {
    let json = |v: serde_json::Result<serde_json::Value>| v.map_err(|e| (500u16, e.to_string()));
    match cmd.as_str() {
        "get_snapshot" => json(serde_json::to_value(state.0.lock().ok().and_then(|g| g.snapshot.clone()))),
        "get_settings" => json(serde_json::to_value(state.0.lock().map(|g| g.settings.clone()).unwrap_or_default())),
        "refresh_now" => json(serde_json::to_value(run_refresh(&app, &state, RefreshReason::Manual).await)),
        "rescan_accounts" => json(serde_json::to_value(run_refresh(&app, &state, RefreshReason::DiscoverOnly).await)),
        "usage_report" => {
            let period = args.get("period").and_then(|v| v.as_str()).unwrap_or("week").to_string();
            let r = tokio::task::spawn_blocking(move || usage_stats::report(&period)).await.map_err(|e| (500, e.to_string()))?;
            json(serde_json::to_value(r))
        }
        "account_sources" => json(serde_json::to_value(account_sources())),
        "update_settings" => {
            let mut next: AppSettings = serde_json::from_value(args.get("newSettings").cloned().unwrap_or_default())
                .map_err(|e| (400u16, e.to_string()))?;
            let cur = state.0.lock().map(|g| g.settings.clone()).map_err(|_| (500u16, "state".to_string()))?;
            next.launch_at_startup = cur.launch_at_startup;
            next.show_pet = cur.show_pet;
            next.hotkey = cur.hotkey.clone();
            next.panel_position = cur.panel_position.clone();
            next.panel_pinned = cur.panel_pinned;
            next.panel_x = cur.panel_x;
            next.panel_y = cur.panel_y;
            next.panel_width = cur.panel_width;
            next.panel_height = cur.panel_height;
            next.pet_x = cur.pet_x;
            next.pet_y = cur.pet_y;
            next.hud_count = cur.hud_count;
            next.hud_layout = cur.hud_layout.clone();
            next.hud_strategy = cur.hud_strategy.clone();
            next.hud_scope = cur.hud_scope.clone();
            next.hud_pin_active = cur.hud_pin_active;
            next.hud_pinned_ids = cur.hud_pinned_ids.clone();
            next.extra_account_dirs = cur.extra_account_dirs.clone();
            next.mobile_enabled = cur.mobile_enabled;
            next.mobile_port = cur.mobile_port;
            next.custom_image_working = cur.custom_image_working.clone();
            next.custom_image_sweating = cur.custom_image_sweating.clone();
            next.custom_image_sleeping = cur.custom_image_sleeping.clone();
            let snap = update_settings(app.clone(), app.state::<SharedState>(), next).map_err(|e| (400u16, e))?;
            let _ = app.emit("snapshot-updated", &snap);
            json(serde_json::to_value(snap))
        }
        _ => Err((403, "not allowed from the phone".to_string())),
    }
}

#[tauri::command]
fn get_snapshot(state: tauri::State<SharedState>) -> Option<DashboardSnapshot> {
    state.0.lock().ok().and_then(|s| s.snapshot.clone())
}

/// Add an account: create `~/.claude-<name>` / `~/.codex-<name>` and open a
/// terminal running that CLI's own login against it (Antigravity: `agy`, which
/// asks to sign in on first run). Discovery picks the account up once the
/// login file is written; DeskCat never sees the password.
#[tauri::command]
fn add_account_login(provider: String, name: String) -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| tr!("找不到使用者資料夾"))?;
    let slug: String = name.trim().to_ascii_lowercase();
    let valid = !slug.is_empty() && slug.len() <= 24 && slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    let (var, dir, cmd, marker) = match provider.as_str() {
        "claude" => ("CLAUDE_CONFIG_DIR", Some(home.join(format!(".claude-{slug}"))), "claude auth login", ".credentials.json"),
        "codex" => ("CODEX_HOME", Some(home.join(format!(".codex-{slug}"))), "codex login", "auth.json"),
        "antigravity" => ("", None, "agy", ""),
        _ => return Err(tr!("不支援的平台")),
    };
    if let Some(dir) = &dir {
        if !valid {
            return Err(tr!("名稱只能用英文字母、數字、- 或 _"));
        }
        if dir.join(marker).exists() {
            return Err(tr!("已經有叫這個名稱的帳號"));
        }
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("cmd");
        // `start` opens a new console window that inherits this environment.
        c.args(["/C", "start", "", "cmd", "/K", cmd]);
        if let Some(dir) = &dir {
            c.env(var, dir);
        }
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW for the outer cmd
        c.spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = (var, cmd);
        return Err(tr!("這個系統請在終端機自行執行登入指令"));
    }
    #[allow(unreachable_code)]
    Ok(dir.map(|d| d.to_string_lossy().to_string()).unwrap_or_default())
}

/// Shows the main panel and switches it to the requested dashboard tab (`"quota"` | `"analytics"`).
fn show_panel_tab(app: &AppHandle, tab: &str) -> tauri::Result<()> {
    if let Some(state) = app.try_state::<SharedState>() {
        if let Ok(mut guard) = state.0.lock() {
            guard.last_toggle = Instant::now();
        }
    }
    if let Some(panel) = app.get_webview_window("panel") {
        let pinned = app
            .try_state::<SharedState>()
            .and_then(|s| s.0.lock().ok().map(|g| g.panel_pinned))
            .unwrap_or(false);
        if !panel.is_visible().unwrap_or(false) {
            apply_saved_panel_size(app, &panel);
            apply_panel_pin_state(&panel, pinned);
            position_panel(app, &panel);
            spawn_on_demand_refresh(app);
        }
        let _ = panel.unminimize();
        apply_panel_backdrop_from_state(app, &panel);
        panel.show()?;
        panel.set_focus()?;
        let _ = panel.emit("open-dash-tab", tab);
    }
    Ok(())
}

/// Non-blocking freshness check when the panel opens (skipped immediately if a refresh is already running).
fn spawn_on_demand_refresh(app: &AppHandle) {
    let Some(state) = app.try_state::<SharedState>() else {
        return;
    };
    let h = app.clone();
    let s = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let _ = run_refresh(&h, &s, RefreshReason::OnDemand).await;
    });
}

#[tauri::command]
fn open_analytics(app: AppHandle) -> Result<(), String> {
    show_panel_tab(&app, "analytics").map_err(|e| {
        logging::log(&format!("open analytics tab failed: {e}"));
        e.to_string()
    })
}

/// Token and cost history for the analytics view.
#[tauri::command]
async fn usage_report(period: String) -> usage_stats::UsageReport {
    tokio::task::spawn_blocking(move || usage_stats::report(&period))
        .await
        .unwrap_or_else(|_| usage_stats::report("week"))
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
    Ok(run_refresh(&app, &state, RefreshReason::Manual).await)
}

#[tauri::command]
async fn rescan_accounts(
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<DashboardSnapshot, String> {
    Ok(run_refresh(&app, &state, RefreshReason::DiscoverOnly).await)
}

#[tauri::command]
fn update_settings(
    app: AppHandle,
    state: tauri::State<SharedState>,
    new_settings: AppSettings,
) -> Result<DashboardSnapshot, String> {
    let old_startup;
    let new_startup;
    let old_hotkey;
    let new_hotkey;
    let old_panel_position;
    let new_panel_position;
    let new_panel_theme;
    let new_panel_opacity;
    let new_appearance;
    let lang_changed;
    let new_pet_size;
    let new_pet_theme;
    let new_show_pet;
    let new_hud_count;
    let new_hud_layout;
    let mut updated_snapshot;
    {
        let mut guard = state.0.lock().map_err(|_| "State poisoned".to_string())?;
        old_startup = guard.settings.launch_at_startup;
        old_hotkey = guard.settings.hotkey.clone();
        old_panel_position = guard.settings.panel_position.clone();
        let mut clean = new_settings;
        settings::sanitize(&mut clean);

        // Keep window bounds and pin state owned by the backend window event handlers
        // so stale coordinates cached in the frontend settings object never clobber recent drags/resizes.
        clean.panel_pinned = guard.panel_pinned;
        clean.panel_x = guard.settings.panel_x;
        clean.panel_y = guard.settings.panel_y;
        clean.panel_width = guard.settings.panel_width;
        clean.panel_height = guard.settings.panel_height;
        clean.pet_x = guard.settings.pet_x;
        clean.pet_y = guard.settings.pet_y;
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
        usage_stats::set_price_overrides(&clean.model_prices);
        lang_changed = i18n::set_lang(&clean.language);
        new_pet_size = clean.pet_size;
        new_pet_theme = clean.pet_theme.clone();
        new_show_pet = clean.show_pet;
        new_hud_count = clean.hud_count;
        new_hud_layout = clean.hud_layout.clone();
        new_startup = clean.launch_at_startup;
        new_hotkey = clean.hotkey.clone();
        new_panel_position = clean.panel_position.clone();
        new_panel_theme = clean.panel_theme.clone();
        new_panel_opacity = clean.panel_opacity;
        new_appearance = clean.appearance.clone();

        if let Some(ref mut snap) = guard.snapshot {
            recompute_snapshot_metrics(snap, &clean);
            updated_snapshot = Some(snap.clone());
        } else {
            updated_snapshot = None;
        }
    }

    // Perform all UI / tray / OS calls after releasing `state.0` to avoid AB-BA
    // deadlocks when called off the main thread (e.g. from the phone server).
    if lang_changed {
        if let (Some(tray), Ok(menu)) = (app.tray_by_id("main-tray"), build_tray_menu(&app)) {
            let _ = tray.set_menu(Some(menu));
        }
    }

    if let Some(pet) = app.get_webview_window("pet") {
        let (pet_w, pet_h) =
            pet_window_dimensions_for(&new_pet_theme, new_pet_size, new_hud_count, &new_hud_layout);
        let _ = pet.set_size(Size::Logical(LogicalSize::new(pet_w, pet_h)));
        clamp_pet_inside_monitor(&pet);
        if new_show_pet {
            let _ = pet.unminimize();
            let _ = pet.show();
        } else {
            let _ = pet.hide();
            if let Some(b) = app.get_webview_window("bubble") {
                let _ = b.hide();
            }
        }
    }

    if let Some(panel) = app.get_webview_window("panel") {
        apply_panel_backdrop(&panel, &new_panel_theme, new_panel_opacity, &new_appearance);
    }

    if new_panel_position != old_panel_position {
        if let Some(panel) = app.get_webview_window("panel") {
            if panel.is_visible().unwrap_or(false) {
                if new_panel_position == "remember" {
                    if let Ok(pos) = panel.outer_position() {
                        if pos.x > -10_000 && pos.y > -10_000 {
                            if let Ok(mut guard) = state.0.lock() {
                                guard.settings.panel_x = Some(pos.x);
                                guard.settings.panel_y = Some(pos.y);
                                let _ = settings::save_settings(&guard.settings);
                                if let Some(ref mut snap) = guard.snapshot {
                                    snap.settings.panel_x = Some(pos.x);
                                    snap.settings.panel_y = Some(pos.y);
                                    updated_snapshot = Some(snap.clone());
                                }
                            }
                        }
                    }
                } else {
                    position_panel(&app, &panel);
                }
            }
        }
    }

    if old_startup != new_startup {
        let autostart = app.autolaunch();
        let _ = if new_startup {
            autostart.enable()
        } else {
            autostart.disable()
        };
    }

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
        let pinned = app
            .try_state::<SharedState>()
            .and_then(|s| s.0.lock().ok().map(|g| g.panel_pinned))
            .unwrap_or(false);
        apply_saved_panel_size(app, &panel);
        apply_panel_pin_state(&panel, pinned);
        position_panel(app, &panel);
        let _ = panel.unminimize();
        apply_panel_backdrop_from_state(app, &panel);
        let _ = panel.show();
        let _ = panel.set_focus();
        spawn_on_demand_refresh(app);
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
            .map(|_| tr!("{combo} 無法註冊，可能已被其他程式佔用", combo = combo)),
        Err(_) => Some(tr!("{combo} 不是有效的快捷鍵", combo = combo)),
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
fn hide_panel(app: AppHandle, state: tauri::State<SharedState>, force: Option<bool>) {
    let pinned = state.0.lock().map(|g| g.panel_pinned).unwrap_or(false);
    if pinned && !force.unwrap_or(false) {
        return;
    }
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.hide();
    }
}

/// Applies native Windows 11 DWM Acrylic blur + native rounded corners when the panel
/// background is translucent (`opacity < 100`), or clears it when fully opaque (`opacity == 100`).
fn apply_panel_backdrop(
    panel: &tauri::WebviewWindow,
    _panel_theme: &str,
    panel_opacity: u32,
    appearance: &str,
) {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::c_void;
        use tauri::window::{Effect, EffectsBuilder};
        use windows_sys::Win32::Graphics::Dwm::{
            DwmExtendFrameIntoClientArea, DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE,
            DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
        };
        use windows_sys::Win32::UI::Controls::MARGINS;

        let dark_mode: i32 = match appearance {
            "light" => 0,
            "dark" => 1,
            _ => match panel.theme() {
                Ok(tauri::Theme::Light) => 0,
                _ => 1,
            },
        };

        if let Ok(hwnd_raw) = panel.hwnd() {
            let hwnd = hwnd_raw.0 as windows_sys::Win32::Foundation::HWND;
            let corner_pref: u32 = DWMWCP_ROUND as u32;
            let margins = MARGINS {
                cxLeftWidth: -1,
                cxRightWidth: -1,
                cyTopHeight: -1,
                cyBottomHeight: -1,
            };
            unsafe {
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
                    &dark_mode as *const i32 as *const c_void,
                    std::mem::size_of::<i32>() as u32,
                );
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_WINDOW_CORNER_PREFERENCE as u32,
                    &corner_pref as *const u32 as *const c_void,
                    std::mem::size_of::<u32>() as u32,
                );
                let _ = DwmExtendFrameIntoClientArea(hwnd, &margins);
            }
        }

        if panel_opacity < 100 {
            let effects = EffectsBuilder::new().effect(Effect::Acrylic).build();
            let _ = panel.set_effects(effects);
        } else {
            let _ = panel.set_effects(None);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (panel, panel_opacity, appearance);
    }
}

fn apply_panel_backdrop_from_state(app: &AppHandle, panel: &tauri::WebviewWindow) {
    if let Some(state) = app.try_state::<SharedState>() {
        if let Ok(g) = state.0.lock() {
            let theme = g.settings.panel_theme.clone();
            let opacity = g.settings.panel_opacity;
            let appearance = g.settings.appearance.clone();
            drop(g);
            apply_panel_backdrop(panel, &theme, opacity, &appearance);
        }
    }
}

/// Pinned mode behaves as a normal desktop widget window (does not auto-hide on blur,
/// does not stay always-on-top, appears on taskbar/Alt+Tab). Open placement still follows `panel_position`.
fn apply_panel_pin_state(panel: &tauri::WebviewWindow, pinned: bool) {
    let _ = panel.set_always_on_top(!pinned);
    let _ = panel.set_skip_taskbar(!pinned);
}

#[tauri::command]
fn set_panel_pinned(app: AppHandle, state: tauri::State<SharedState>, pinned: bool) {
    let bounds = app.get_webview_window("panel").and_then(|panel| {
        if !panel.is_visible().unwrap_or(false) {
            return None;
        }
        let pos = panel.outer_position().ok()?;
        let size = panel.inner_size().ok()?;
        let scale = panel.scale_factor().unwrap_or(1.0).max(0.5);
        let w = (size.width as f64 / scale).round() as u32;
        let h = (size.height as f64 / scale).round() as u32;
        Some((pos.x, pos.y, w, h))
    });

    let snap_to_emit = if let Ok(mut guard) = state.0.lock() {
        guard.panel_pinned = pinned;
        guard.settings.panel_pinned = pinned;
        if let Some((x, y, w, h)) = bounds {
            if x > -10_000 && y > -10_000 {
                guard.settings.panel_x = Some(x);
                guard.settings.panel_y = Some(y);
            }
            if w >= 300 && h >= 360 {
                guard.settings.panel_width = Some(w.clamp(320, 680));
                guard.settings.panel_height = Some(h.clamp(420, 1080));
            }
        }
        let _ = settings::save_settings(&guard.settings);
        let clean = guard.settings.clone();
        if let Some(ref mut snap) = guard.snapshot {
            snap.settings = clean;
            Some(snap.clone())
        } else {
            None
        }
    } else {
        None
    };

    if let Some(panel) = app.get_webview_window("panel") {
        apply_panel_pin_state(&panel, pinned);
    }
    if let Some(snap) = snap_to_emit {
        let _ = app.emit("snapshot-updated", &snap);
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
        .body(tr!("系統通知運作正常！額度過低或重設時會在這裡提醒你。"))
        .show()
        .map_err(|err| tr!("通知發送失敗: {err}", err = err))
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
    let snap_clone = {
        let mut guard = state.0.lock().map_err(|_| "State poisoned".to_string())?;
        guard.settings.custom_image_working = None;
        guard.settings.custom_image_sweating = None;
        guard.settings.custom_image_sleeping = None;
        settings::save_settings(&guard.settings)?;
        let clean_settings = guard.settings.clone();
        if let Some(ref mut snap) = guard.snapshot {
            snap.settings = clean_settings;
            Some(snap.clone())
        } else {
            None
        }
    };
    if let Some(snap_clone) = snap_clone {
        let _ = app.emit("snapshot-updated", &snap_clone);
        return Ok(snap_clone);
    }
    Err("Snapshot not ready".to_string())
}

#[tauri::command]
fn account_sources() -> HashMap<String, String> {
    support::sources()
}

#[tauri::command]
fn tailscale_state() -> support::TailscaleState {
    support::tailscale_state()
}

#[tauri::command]
fn open_target(target: String) -> Result<(), String> {
    support::open_target(&target)
}

#[tauri::command]
fn qr_svg(text: String) -> Result<String, String> {
    support::qr_svg(&text)
}

#[tauri::command]
fn diagnostics(state: tauri::State<SharedState>) -> String {
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let m = &guard.mobile_status;
    let mobile = if !guard.settings.mobile_enabled {
        "off".to_string()
    } else {
        m.url.clone().or_else(|| m.error.clone()).unwrap_or_else(|| "starting".into())
    };
    support::diagnostics(guard.snapshot.as_ref(), &mobile)
}

/// Folder picker for an extra account folder; None when cancelled.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    DIALOG_OPEN.store(true, Ordering::Release);
    let _guard = BoolResetGuard(&DIALOG_OPEN);
    let app_c = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        app_c
            .dialog()
            .file()
            .set_title(tr!("選擇帳號資料夾"))
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
            .map(|p| p.display().to_string())
    })
    .await
    .ok()
    .flatten();
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.show();
        let _ = panel.set_focus();
    }
    res
}

#[tauri::command]
fn get_activity() -> activity::Activity {
    activity::get()
}

/// Hover bubble over (or under) the pet. The pet window composes the lines.
#[tauri::command]
fn show_bubble(app: AppHandle, lines: Vec<String>) {
    let show_pet = app
        .try_state::<SharedState>()
        .and_then(|s| s.0.lock().ok().map(|g| g.settings.show_pet))
        .unwrap_or(true);
    if !show_pet {
        return;
    }
    let (Some(pet), Some(bubble)) = (app.get_webview_window("pet"), app.get_webview_window("bubble")) else {
        return;
    };
    let (Ok(pp), Ok(ps), Ok(bs)) = (pet.outer_position(), pet.outer_size(), bubble.outer_size()) else {
        return;
    };
    let Some(mon) = pet.current_monitor().ok().flatten() else { return };
    let wa = mon.work_area();
    let scale = mon.scale_factor();
    let (bw, bh) = (bs.width as i32, bs.height as i32);
    let (l, t) = (wa.position.x, wa.position.y);
    let r = l + wa.size.width as i32;
    let b = t + wa.size.height as i32;
    let pet_cx = pp.x + ps.width as i32 / 2;
    let x = (pet_cx - bw / 2).clamp(l + 4, (r - bw - 4).max(l + 4));
    let above = pp.y - t >= bh;
    let y = if above { pp.y - bh } else { (pp.y + ps.height as i32).min(b - bh) };
    let tail_x = ((pet_cx - x) as f64 / scale).round();
    let _ = app.emit_to(
        "bubble",
        "bubble-content",
        serde_json::json!({ "lines": lines, "above": above, "tailX": tail_x }),
    );
    let _ = bubble.set_position(Position::Physical(PhysicalPosition::new(x, y)));
    let _ = bubble.show();
}

#[tauri::command]
fn hide_bubble(app: AppHandle) {
    if let Some(b) = app.get_webview_window("bubble") {
        let _ = b.hide();
    }
}

/// End the process cleanly and unconditionally. On Windows, Tauri v2's
/// default exit sequence can leave this tray + WebView2 + tokio app
/// lingering without windows or tray while still holding the
/// single-instance lock, blocking every future launch.
fn force_exit(app: &AppHandle, code: i32, reason: &str) -> ! {
    logging::log(&format!("exiting (code={code}): {reason}"));
    // Safety net in case tray removal or cleanup_before_exit() blocks.
    // Shorter than the 2 s delay in --relaunch so a relaunched copy sees
    // the single-instance lock released even if cleanup hangs.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        logging::log(&format!("exit watchdog fired (code={code})"));
        std::process::exit(code);
    });
    if let Some(tray) = app.remove_tray_by_id("main-tray") {
        drop(tray);
    }
    app.cleanup_before_exit();
    logging::log(&format!("exit complete (code={code})"));
    std::process::exit(code);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Write the discovered accounts and where each came from to the log whenever the
/// set changes, so "an account is missing" can be answered from the log alone.
fn log_discovery_changes(accounts: &[DiscoveredAccount]) {
    support::set_sources(accounts.iter().map(|a| (a.id().to_string(), a.source())).collect());
    static LAST: Mutex<String> = Mutex::new(String::new());
    let summary = if accounts.is_empty() {
        "accounts: none found (no Claude Code / Codex / agy sign-in detected)".to_string()
    } else {
        let lines: Vec<String> = accounts
            .iter()
            .map(|a| format!("  {} <- {}", a.id(), a.source()))
            .collect();
        format!("accounts ({}):\n{}", accounts.len(), lines.join("\n"))
    };
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if *last != summary {
        logging::log(&summary);
        *last = summary;
    }
}

fn discovered_provider(acc: &DiscoveredAccount) -> ProviderKind {
    match acc {
        DiscoveredAccount::Claude { .. } => ProviderKind::Claude,
        DiscoveredAccount::Antigravity { .. } | DiscoveredAccount::AntigravityCli { .. } => {
            ProviderKind::Antigravity
        }
        DiscoveredAccount::Codex { .. } => ProviderKind::Codex,
    }
}

fn discovered_name(acc: &DiscoveredAccount) -> &str {
    match acc {
        DiscoveredAccount::Claude { name, .. }
        | DiscoveredAccount::Antigravity { name, .. }
        | DiscoveredAccount::AntigravityCli { name, .. }
        | DiscoveredAccount::Codex { name, .. } => name,
    }
}

fn is_ag_cli(acc: &DiscoveredAccount) -> bool {
    matches!(
        acc,
        DiscoveredAccount::Antigravity { .. } | DiscoveredAccount::AntigravityCli { .. }
    )
}

/// File `(mtime_secs, byte_len)` for an account's local credential file, so we detect
/// token refreshes immediately without wasting HTTP calls on unchanged expired tokens.
fn cred_stamp(acc: &DiscoveredAccount) -> Option<(i64, u64)> {
    let path = match acc {
        DiscoveredAccount::Claude { credentials_path, .. } => credentials_path,
        DiscoveredAccount::Antigravity { token_path, .. } => token_path,
        DiscoveredAccount::Codex { auth_path, .. } => auth_path,
        DiscoveredAccount::AntigravityCli { .. } => return None,
    };
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Some((mtime, meta.len()))
}

/// Adaptive minimum interval (seconds) before hitting the network again for one account.
fn account_min_interval(
    provider: ProviderKind,
    is_cli_probe: bool,
    reason: &RefreshReason,
    active: bool,
    cred_changed: bool,
    reset_passed: bool,
) -> i64 {
    if cred_changed {
        return 0;
    }
    let (active_s, idle_s, trig_s, manual_s) = match (provider, is_cli_probe) {
        (ProviderKind::Claude, _) => (
            CLAUDE_ACTIVE_SECS,
            CLAUDE_IDLE_SECS,
            CLAUDE_TRIGGERED_SECS,
            CLAUDE_MANUAL_SECS,
        ),
        (ProviderKind::Antigravity, true) => (
            AG_CLI_ACTIVE_SECS,
            AG_CLI_IDLE_SECS,
            AG_CLI_TRIGGERED_SECS,
            AG_CLI_MANUAL_SECS,
        ),
        (ProviderKind::Antigravity, false) => (
            AG_ACTIVE_SECS,
            AG_IDLE_SECS,
            AG_TRIGGERED_SECS,
            AG_MANUAL_SECS,
        ),
        (ProviderKind::Codex, _) => (
            CODEX_ACTIVE_SECS,
            CODEX_IDLE_SECS,
            CODEX_TRIGGERED_SECS,
            CODEX_MANUAL_SECS,
        ),
    };
    match reason {
        RefreshReason::Manual => manual_s,
        RefreshReason::ActivityDone(_) => trig_s,
        RefreshReason::OnDemand => {
            if active || reset_passed {
                trig_s
            } else {
                idle_s
            }
        }
        RefreshReason::Startup | RefreshReason::Scheduled | RefreshReason::DiscoverOnly => {
            if reset_passed {
                trig_s
            } else if active {
                active_s
            } else {
                idle_s
            }
        }
    }
}

fn placeholder_account(acc: &DiscoveredAccount, now: i64) -> AccountQuota {
    AccountQuota {
        id: acc.id().to_string(),
        provider: discovered_provider(acc),
        name: discovered_name(acc).to_string(),
        plan: None,
        effective_remaining: 0,
        primary_windows: Vec::new(),
        extra_windows: Vec::new(),
        status: "stale".to_string(),
        error: None,
        updated_at: now,
    }
}

/// Seeds an immediate startup snapshot from the persisted `QuotaCache` so the UI
/// renders last-known numbers on millisecond 0 instead of blocking on network I/O.
fn seed_initial_snapshot(state: &SharedState) {
    let Ok(mut guard) = state.0.lock() else { return };
    if guard.snapshot.is_some() {
        return;
    }
    let now = Utc::now().timestamp();
    let discovered = discover_accounts(&guard.settings.extra_account_dirs);
    if discovered.is_empty() {
        return;
    }
    let mut accounts = Vec::with_capacity(discovered.len());
    let mut has_any_cached = false;
    for acc in &discovered {
        let id = acc.id().to_string();
        if let Some(st) = cred_stamp(acc) {
            guard.cred_stamps.insert(id.clone(), st);
        }
        if guard.cache.last_good.contains_key(&id) || guard.cache.is_known_expired(&id) {
            has_any_cached = true;
            accounts.push(guard.cache.skipped(&id, placeholder_account(acc, now), now));
        }
    }
    if !has_any_cached {
        return;
    }
    let cfg = guard.settings.clone();
    let mut forecasts = HashMap::new();
    let mut burn_rates = HashMap::new();
    for acc in &accounts {
        let samples = &guard.history.samples;
        let series = |label: &str| samples.get(&forecast::window_key(&acc.id, label)).map(Vec::as_slice);
        if let Some(f) = forecast::forecast(acc, series, now) {
            forecasts.insert(acc.id.clone(), f);
        }
        if let Some(r) = forecast::burn_rate(acc, series, now) {
            burn_rates.insert(acc.id.clone(), r);
        }
    }
    let freshest = accounts
        .iter()
        .filter(|a| !cfg.is_hidden(&a.id) && a.updated_at > 0 && is_usable(a))
        .map(|a| a.updated_at)
        .max()
        .unwrap_or(now);
    let mut snap = DashboardSnapshot {
        accounts,
        picks: Vec::new(),
        overall_score: 0,
        mood: CatMood::Working,
        tooltip_text: String::new(),
        last_refreshed_at: freshest,
        settings: cfg.clone(),
        offline: false,
        forecasts,
        usage_today: HashMap::new(),
        burn_rates,
    };
    recompute_snapshot_metrics(&mut snap, &cfg);
    guard.snapshot = Some(snap);
}

struct AccountResult {
    outcome: FetchOutcome,
    /// True when this round produced a fresh observation (network fetch or newer local Codex log)
    /// that must be reconciled into cache & history.
    freshly_observed: bool,
}

async fn run_refresh(
    app: &AppHandle,
    state: &SharedState,
    reason: RefreshReason,
) -> DashboardSnapshot {
    // Non-urgent triggers skip immediately if another refresh is already in flight.
    if matches!(reason, RefreshReason::Scheduled | RefreshReason::OnDemand)
        && state.1.busy.load(Ordering::Acquire)
    {
        if let Some(existing) = state.0.lock().ok().and_then(|g| g.snapshot.clone()) {
            return existing;
        }
    }

    // Single-flight lock guarantees no two refresh passes hit provider APIs concurrently.
    let _flight_lock = state.1.lock.lock().await;
    state.1.busy.store(true, Ordering::Release);
    let _busy_guard = ArcBoolGuard(state.1.clone());

    let (extra_dirs, settings_copy, prev_usage_scan, prev_usage_today) = state
        .0
        .lock()
        .map(|g| {
            (
                g.settings.extra_account_dirs.clone(),
                g.settings.clone(),
                g.last_usage_scan,
                g.last_usage_today.clone(),
            )
        })
        .unwrap_or_else(|_| (Vec::new(), AppSettings::default(), 0, HashMap::new()));

    let discovered = discover_accounts(&extra_dirs);
    log_discovery_changes(&discovered);

    // Snapshot discovery metadata before `discovered` is partitioned/moved, for `quota_v1.json`.
    let binding_meta: HashMap<String, quota_contract::AccountBindingMeta> = discovered
        .iter()
        .map(|a| (a.id().to_string(), quota_contract::AccountBindingMeta::from_discovered(a)))
        .collect();

    // Local CLI / transcript log sources for activity tracking + incremental usage ledger.
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
            DiscoveredAccount::Antigravity { id, token_path, is_legacy_gemini, .. } => {
                token_path.parent().map(|d| usage_stats::Source::Antigravity {
                    account_id: id.clone(),
                    brain_dirs: if *is_legacy_gemini {
                        vec![
                            d.join("antigravity-cli").join("brain"),
                            d.join("antigravity").join("brain"),
                        ]
                    } else {
                        vec![d.join("brain")]
                    },
                })
            }
            DiscoveredAccount::AntigravityCli { id, .. } => {
                dirs::home_dir().map(|h| usage_stats::Source::Antigravity {
                    account_id: id.clone(),
                    brain_dirs: vec![
                        h.join(".gemini").join("antigravity-cli").join("brain"),
                        h.join(".gemini").join("antigravity").join("brain"),
                    ],
                })
            }
        })
        .collect();

    activity::set_sources(
        usage_sources
            .iter()
            .map(|s| match s {
                usage_stats::Source::Claude { account_id, config_dir } => activity::Src {
                    account_id: account_id.clone(),
                    kind: activity::Kind::Claude,
                    dirs: vec![config_dir.clone()],
                },
                usage_stats::Source::Codex { account_id, codex_home } => activity::Src {
                    account_id: account_id.clone(),
                    kind: activity::Kind::Codex,
                    dirs: vec![codex_home.clone()],
                },
                usage_stats::Source::Antigravity { account_id, brain_dirs } => activity::Src {
                    account_id: account_id.clone(),
                    kind: activity::Kind::Antigravity,
                    dirs: brain_dirs.clone(),
                },
            })
            .collect(),
    );

    let now_start = Utc::now().timestamp();
    let should_scan_usage = matches!(
        reason,
        RefreshReason::Startup | RefreshReason::Scheduled | RefreshReason::Manual
    ) || (now_start - prev_usage_scan >= USAGE_SCAN_MIN_SECS);
    let usage_task = should_scan_usage.then(|| {
        tokio::task::spawn_blocking(move || usage_stats::compute(&usage_sources))
    });

    // Detect credential file mtime/size changes across all discovered accounts.
    let mut cred_changed_ids: HashSet<String> = HashSet::new();
    if let Ok(mut guard) = state.0.lock() {
        for acc in &discovered {
            let id = acc.id().to_string();
            if let Some(stamp) = cred_stamp(acc) {
                let prev = guard.cred_stamps.insert(id.clone(), stamp);
                if prev.is_some_and(|p| p != stamp) {
                    cred_changed_ids.insert(id.clone());
                    guard.cache.clear_expired(&id);
                }
            }
        }
    }

    // Partition accounts into: skipped (reused from cache), locally updated (Codex logs),
    // Claude sequential queue, and non-Claude concurrency-capped queue.
    let mut skipped_results: Vec<AccountResult> = Vec::new();
    let mut local_fresh_results: Vec<AccountResult> = Vec::new();
    let mut claude_due: Vec<DiscoveredAccount> = Vec::new();
    let mut non_claude_due: Vec<DiscoveredAccount> = Vec::new();

    for acc in discovered {
        let id = acc.id().to_string();
        let provider = discovered_provider(&acc);
        let name = discovered_name(&acc).to_string();
        let placeholder = placeholder_account(&acc, now_start);

        // Hidden accounts never burn network quota.
        if settings_copy.is_hidden(&id) {
            let shown = state
                .0
                .lock()
                .map(|g| g.cache.skipped(&id, placeholder.clone(), now_start))
                .unwrap_or(placeholder);
            skipped_results.push(AccountResult {
                outcome: FetchOutcome::local(shown),
                freshly_observed: false,
            });
            continue;
        }

        // Targeted turn-done refresh only touches the account that just finished a turn.
        if let RefreshReason::ActivityDone(ref target_id) = reason {
            if &id != target_id {
                let shown = state
                    .0
                    .lock()
                    .map(|g| g.cache.skipped(&id, placeholder.clone(), now_start))
                    .unwrap_or(placeholder);
                skipped_results.push(AccountResult {
                    outcome: FetchOutcome::local(shown),
                    freshly_observed: false,
                });
                continue;
            }
        }

        // Claude: check local `.claude.json` (`cachedUsageUtilization`) first (0 HTTP calls).
        if let DiscoveredAccount::Claude { ref credentials_path, .. } = acc {
            let min_ts = state
                .0
                .lock()
                .ok()
                .and_then(|g| g.cache.last_good_updated_at(&id))
                .unwrap_or(0);
            if let Some(local_q) = read_local_claude_quota(&id, &name, credentials_path, min_ts, now_start) {
                local_fresh_results.push(AccountResult {
                    outcome: FetchOutcome::local(local_q),
                    freshly_observed: true,
                });
                continue;
            }
        }

        // Codex: try reading live `rate_limits` from local session `.jsonl` first (0 HTTP calls).
        if let DiscoveredAccount::Codex { ref auth_path, .. } = acc {
            if let Some(codex_home) = auth_path.parent() {
                let min_ts = state
                    .0
                    .lock()
                    .ok()
                    .and_then(|g| g.cache.last_good_updated_at(&id))
                    .unwrap_or(0);
                if let Some(local_q) = read_local_codex_quota(&id, &name, codex_home, min_ts, now_start) {
                    local_fresh_results.push(AccountResult {
                        outcome: FetchOutcome::local(local_q),
                        freshly_observed: true,
                    });
                    continue;
                }
            }
        }

        let cred_changed = cred_changed_ids.contains(&id);

        // `DiscoverOnly` (add-account watcher / rescan): only fetch accounts never seen before.
        if reason == RefreshReason::DiscoverOnly && !cred_changed {
            let already_known = state
                .0
                .lock()
                .map(|g| {
                    g.cache.last_good.contains_key(&id)
                        || g.cache.last_attempt.contains_key(&id)
                        || g.cache.is_known_expired(&id)
                })
                .unwrap_or(false);
            if already_known {
                let shown = state
                    .0
                    .lock()
                    .map(|g| g.cache.skipped(&id, placeholder.clone(), now_start))
                    .unwrap_or(placeholder);
                skipped_results.push(AccountResult {
                    outcome: FetchOutcome::local(shown),
                    freshly_observed: false,
                });
                continue;
            }
        }

        // Unchanged expired credentials don't need repeated polling until refreshed or manually forced.
        let skip_unchanged_expired = !cred_changed
            && !matches!(reason, RefreshReason::Manual | RefreshReason::Startup)
            && state
                .0
                .lock()
                .map(|g| g.cache.is_known_expired(&id))
                .unwrap_or(false);
        if skip_unchanged_expired {
            let shown = state
                .0
                .lock()
                .map(|g| g.cache.skipped(&id, placeholder.clone(), now_start))
                .unwrap_or(placeholder);
            skipped_results.push(AccountResult {
                outcome: FetchOutcome::local(shown),
                freshly_observed: false,
            });
            continue;
        }

        let active = activity::is_account_active(&id, now_start, ACTIVE_WINDOW_SECS);
        let reset_passed = state
            .0
            .lock()
            .map(|g| g.cache.has_passed_reset(&id, now_start))
            .unwrap_or(false);
        let min_interval = account_min_interval(
            provider,
            is_ag_cli(&acc),
            &reason,
            active,
            cred_changed,
            reset_passed,
        );
        let allow_retry_errors =
            matches!(reason, RefreshReason::Manual | RefreshReason::Startup) || cred_changed;
        let allowed = state
            .0
            .lock()
            .map(|g| g.cache.may_fetch(&id, now_start, min_interval, allow_retry_errors))
            .unwrap_or(true);

        if !allowed {
            let shown = state
                .0
                .lock()
                .map(|g| g.cache.skipped(&id, placeholder.clone(), now_start))
                .unwrap_or(placeholder);
            skipped_results.push(AccountResult {
                outcome: FetchOutcome::local(shown),
                freshly_observed: false,
            });
            continue;
        }

        match acc {
            DiscoveredAccount::Claude { .. } => claude_due.push(acc),
            _ => non_claude_due.push(acc),
        }
    }

    let client = state.1.client.clone();

    // Split non-Claude into Antigravity (cold-start CLI probes: strictly sequential with
    // 1.2-2.5s jitter only after real CLI hits to prevent simultaneous bursts) and Codex
    // (lightweight HTTP: max 2 concurrent).
    let (ag_due, codex_due): (Vec<_>, Vec<_>) = non_claude_due.into_iter().partition(|a| {
        matches!(
            a,
            DiscoveredAccount::Antigravity { .. } | DiscoveredAccount::AntigravityCli { .. }
        )
    });

    let mut handles: Vec<tokio::task::JoinHandle<Vec<AccountResult>>> = Vec::new();

    if !ag_due.is_empty() {
        handles.push(tokio::spawn(async move {
            let mut out_list = Vec::with_capacity(ag_due.len());
            let mut prev_network_hit = false;
            for (idx, acc) in ag_due.into_iter().enumerate() {
                if prev_network_hit {
                    // Deterministic pseudo-random jitter in [1200, 2500] ms (zero extra crates).
                    let nanos = std::time::SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.subsec_nanos() as u64)
                        .unwrap_or(0);
                    let jitter_ms = 1200 + ((nanos ^ ((idx as u64).wrapping_mul(397))) % 1301);
                    tokio::time::sleep(Duration::from_millis(jitter_ms)).await;
                }
                let outcome = match acc {
                    DiscoveredAccount::Antigravity {
                        id,
                        name,
                        token_path,
                        is_legacy_gemini,
                        ..
                    } => fetch_antigravity_quota(id, name, &token_path, is_legacy_gemini).await,
                    DiscoveredAccount::AntigravityCli { id, name, exe, .. } => {
                        providers::antigravity_cli::fetch_antigravity_cli_quota(id, name, &exe)
                            .await
                    }
                    _ => unreachable!(),
                };
                prev_network_hit = outcome.network_hit;
                out_list.push(AccountResult {
                    outcome,
                    freshly_observed: true,
                });
            }
            out_list
        }));
    }

    if !codex_due.is_empty() {
        let sem = Arc::new(tokio::sync::Semaphore::new(2));
        for (idx, acc) in codex_due.into_iter().enumerate() {
            let client = client.clone();
            let sem = sem.clone();
            handles.push(tokio::spawn(async move {
                let _permit = sem.acquire_owned().await;
                if idx > 0 {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                let outcome = match acc {
                    DiscoveredAccount::Codex {
                        id,
                        name,
                        auth_path,
                        ..
                    } => fetch_codex_quota(&client, id, name, &auth_path).await,
                    _ => unreachable!(),
                };
                vec![AccountResult {
                    outcome,
                    freshly_observed: true,
                }]
            }));
        }
    }

    // Claude: sequential, spaced out ONLY after actual network hits, never burning
    // `last_attempt` on local token-expiry short-circuits, and circuit-breaking the rest
    // of the pass if 2 consecutive accounts hit 429 (protects shared IP/token buckets).
    let mut claude_results = Vec::with_capacity(claude_due.len());
    let mut prev_network_hit = false;
    let mut consecutive_429 = 0u32;
    for acc in claude_due {
        let placeholder = placeholder_account(&acc, now_start);
        let DiscoveredAccount::Claude {
            id,
            name,
            credentials_path,
            ..
        } = acc
        else {
            continue;
        };
        if consecutive_429 >= 2 {
            let shown = state
                .0
                .lock()
                .map(|g| g.cache.skipped(&id, placeholder.clone(), now_start))
                .unwrap_or(placeholder);
            claude_results.push(AccountResult {
                outcome: FetchOutcome::local(shown),
                freshly_observed: false,
            });
            continue;
        }
        if prev_network_hit {
            tokio::time::sleep(Duration::from_millis(2000)).await;
        }
        let outcome = fetch_claude_quota(&client, id, name, &credentials_path).await;
        prev_network_hit = outcome.network_hit;
        if outcome.quota.status == "cooldown" {
            consecutive_429 += 1;
        } else if outcome.network_hit {
            consecutive_429 = 0;
        }
        claude_results.push(AccountResult {
            outcome,
            freshly_observed: true,
        });
    }

    let mut all_results = Vec::with_capacity(
        skipped_results.len() + local_fresh_results.len() + handles.len() + claude_results.len(),
    );
    all_results.extend(skipped_results);
    all_results.extend(local_fresh_results);
    for handle in handles {
        if let Ok(list) = handle.await {
            all_results.extend(list);
        }
    }
    all_results.extend(claude_results);

    // Keep deterministic provider + name order matching discovery.
    all_results.sort_by_key(|r| {
        let p = match r.outcome.quota.provider {
            ProviderKind::Claude => 0u8,
            ProviderKind::Antigravity => 1u8,
            ProviderKind::Codex => 2u8,
        };
        (p, r.outcome.quota.name.to_lowercase(), r.outcome.quota.id.clone())
    });

    let usage_today: HashMap<String, usage_stats::UsageToday> = match usage_task {
        Some(task) => {
            let computed = task
                .await
                .map(|list| {
                    list.into_iter()
                        .filter(|u| u.requests > 0)
                        .map(|u| (u.account_id.clone(), u))
                        .collect::<HashMap<_, _>>()
                })
                .unwrap_or(prev_usage_today);
            if let Ok(mut g) = state.0.lock() {
                g.last_usage_scan = Utc::now().timestamp();
                g.last_usage_today = computed.clone();
            }
            computed
        }
        None => prev_usage_today,
    };

    // Reconcile only freshly observed results; skipped accounts already come straight from cache.
    let mut accounts: Vec<AccountQuota> = Vec::with_capacity(all_results.len());
    let mut forecasts = HashMap::new();
    let mut burn_rates = HashMap::new();
    let mut log_events: Vec<String> = Vec::new();
    if let Ok(mut guard) = state.0.lock() {
        let now = Utc::now().timestamp();
        for res in all_results {
            if !res.freshly_observed {
                accounts.push(res.outcome.quota);
                continue;
            }
            let id = res.outcome.quota.id.clone();
            let raw_status = res.outcome.quota.status.clone();
            if res.outcome.network_hit {
                guard.cache.note_attempt(&id, now);
            }
            let reconciled =
                guard
                    .cache
                    .reconcile_outcome(res.outcome.quota, res.outcome.retry_after_secs, now);
            if raw_status == "cooldown" {
                let rem = guard
                    .cache
                    .backoff_remaining(&id, now)
                    .map(|(s, _)| s)
                    .unwrap_or(0);
                log_events.push(format!(
                    "quota rate-limited id={id} retry_after={:?} next_in={rem}s",
                    res.outcome.retry_after_secs
                ));
            } else if raw_status == "error" && res.outcome.network_hit {
                log_events.push(format!(
                    "quota fetch error id={id} err={:?}",
                    reconciled.error.as_deref().unwrap_or("")
                ));
            }
            if raw_status == "ok" && reconciled.status == "ok" {
                guard.history.record(&reconciled.id, now, reconciled.effective_remaining);
                for w in reconciled
                    .primary_windows
                    .iter()
                    .filter(|w| !w.label.contains(' '))
                {
                    guard.history.record(
                        &forecast::window_key(&reconciled.id, &w.label),
                        now,
                        w.remaining_percent,
                    );
                }
            }
            accounts.push(reconciled);
        }
        guard.cache.save();
        let contract = quota_contract::build_contract(&accounts, &binding_meta, &guard.cache, now);
        quota_contract::write_contract(&contract);
        guard.history.prune(now);
        guard.history.save();

        for acc in &accounts {
            let samples = &guard.history.samples;
            let series =
                |label: &str| samples.get(&forecast::window_key(&acc.id, label)).map(Vec::as_slice);
            if let Some(f) = forecast::forecast(acc, series, now) {
                forecasts.insert(acc.id.clone(), f);
            }
            if let Some(r) = forecast::burn_rate(acc, series, now) {
                burn_rates.insert(acc.id.clone(), r);
            }
        }
    }
    for line in log_events {
        logging::log(&line);
    }

    let now = Utc::now().timestamp();
    let mut notifications: Vec<(String, String)> = Vec::new();

    let snapshot = {
        // A panic elsewhere must not poison the state for good.
        let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
        let cfg = guard.settings.clone();

        // Honest header timestamp: latest actual successful fetch time among visible usable accounts.
        let freshest_ts = accounts
            .iter()
            .filter(|a| !cfg.is_hidden(&a.id) && a.updated_at > 0 && is_usable(a))
            .map(|a| a.updated_at)
            .max()
            .unwrap_or(now);

        let mut snap = DashboardSnapshot {
            accounts,
            picks: Vec::new(),
            overall_score: 0,
            mood: CatMood::Working,
            tooltip_text: String::new(),
            last_refreshed_at: freshest_ts,
            settings: cfg.clone(),
            offline: false,
            forecasts,
            usage_today,
            burn_rates,
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
                                tr!("✨ {who} 額度已恢復", who = who),
                                tr!("已恢復至 {rem}%，可繼續使用。", rem = rem),
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
                            tr!("⚠️ {who} 額度已用盡", who = who),
                            tr!("剩餘 0%，請切換推薦帳號或等待重設。"),
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
                                tr!("⚠️ {who} 額度偏低", who = who),
                                tr!("目前剩餘 {rem}%（低於危險線 {low}%）。", rem = rem, low = low),
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
                            tr!("✨ {name} 的{window}已重設", name = cfg.display_name(acc), window = window_label_zh(&label)),
                            tr!("{provider} 額度已恢復，可以繼續使用了。", provider = acc.provider.short_label()),
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
    let act = activity::get();
    let active_id = matches!(act.state, "working" | "done" | "error")
        .then_some(act.account_id.as_deref())
        .flatten();
    let rank_cfg = ranking::RankConfig {
        strategy: &settings.picks_strategy,
        scope: &settings.picks_scope,
        count: settings.picks_count as usize,
        pin_active: settings.picks_pin_active,
        active_id,
        pinned_ids: &settings.picks_pinned_ids,
    };
    let picks = ranking::compute_ranked_picks(&visible, &snap.forecasts, &rank_cfg, Utc::now().timestamp());
    let mut tooltip = format_tooltip(&picks, &visible);
    if offline {
        tooltip = tr!("暫時抓不到最新額度｜{tooltip}", tooltip = tooltip);
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
        || ((a.status == "expired" || a.status == "idle") && !a.primary_windows.is_empty())
}

/// Fresh this round, or deliberately not re-fetched yet (min interval, no error).
/// Idle accounts count too: they are skipped on purpose, not failing.
fn is_live(a: &AccountQuota) -> bool {
    a.status == "ok" || a.status == "idle" || (a.status == "stale" && a.error.is_none())
}

#[cfg_attr(not(test), allow(dead_code))]
fn compute_picks(accounts: &[AccountQuota], now: i64) -> Vec<SmartPick> {
    let cfg = ranking::RankConfig {
        strategy: "most_left",
        scope: "per_provider",
        count: 1,
        pin_active: false,
        active_id: None,
        pinned_ids: &[],
    };
    ranking::compute_ranked_picks(accounts, &HashMap::new(), &cfg, now)
}

fn format_tooltip(picks: &[SmartPick], accounts: &[AccountQuota]) -> String {
    let mut parts = Vec::new();
    for pick in picks {
        parts.push(format!(
            "{}: {} {}%{}",
            pick.provider.short_label(),
            pick.account_name,
            pick.effective_remaining,
            if pick.use_before_reset { tr!("（即將重設）") } else { String::new() }
        ));
    }
    if parts.is_empty() {
        if let Some(codex) = accounts
            .iter()
            .find(|a| a.provider == ProviderKind::Codex && is_usable(a))
        {
            parts.push(format!("ChatGPT: {}%", codex.effective_remaining));
        } else {
            return tr!("T3 DeskCat（載入額度中…）");
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
    let mut tip = format!("{}\n{}", snap.tooltip_text, tr!("總剩餘 {n}%", n = snap.overall_score));
    let cost: f64 = snap
        .usage_today
        .iter()
        .filter(|(id, _)| !cfg.is_hidden(id))
        .filter_map(|(_, u)| u.cost_usd)
        .sum();
    if cfg.show_usage_stats && cost >= 0.01 {
        tip.push_str(&format!(" · {}", tr!("今日約 US${cost}", cost = format!("{cost:.2}"))));
    }
    // Windows caps tray tooltips at 127 UTF-16 units.
    if tip.encode_utf16().count() > 127 {
        tip = tip.chars().take(120).collect::<String>() + "…";
    }

    let tray_id = state
        .0
        .lock()
        .map(|g| g.tray_id.clone())
        .unwrap_or_else(|_| "main-tray".to_string());
    let Some(tray) = app.tray_by_id(&tray_id) else { return };
    let _ = tray.set_tooltip(Some(&tip));
    // Keep the system tray icon fixed to the app's original icon.
    let redraw = state
        .0
        .lock()
        .map(|mut g| {
            let changed = g.tray_icon_key != "icon";
            g.tray_icon_key = "icon".to_string();
            changed
        })
        .unwrap_or(false);
    if redraw {
        let icon = match tray_icon::render("icon", Some(snap.overall_score), tray_icon::level_for(snap.overall_score, snap.offline, cfg.working_threshold, cfg.sleeping_threshold)) {
            Some(rgba) => Some(tauri::image::Image::new_owned(rgba, tray_icon::SIZE, tray_icon::SIZE)),
            None => app.default_window_icon().cloned(),
        };
        let _ = tray.set_icon(icon);
    }
}

fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let toggle_item = MenuItem::with_id(app, "toggle", tr!("展開 / 收合面板"), true, None::<&str>)?;
    let analytics_item = MenuItem::with_id(app, "analytics", tr!("用量分析"), true, None::<&str>)?;
    let refresh_item = MenuItem::with_id(app, "refresh", tr!("立即更新額度"), true, None::<&str>)?;
    let reset_pos_item = MenuItem::with_id(app, "reset_pos", tr!("重設浮動卡片位置"), true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", tr!("結束 T3 DeskCat"), true, None::<&str>)?;
    Menu::with_items(app, &[&toggle_item, &analytics_item, &refresh_item, &reset_pos_item, &quit_item])
}

fn hud_card_scale(pet_size: u32) -> f64 {
    let clamped = pet_size.clamp(48, 128) as f64;
    if clamped <= 64.0 {
        0.88 + ((clamped - 48.0) / 16.0) * 0.12
    } else {
        1.0 + ((clamped - 64.0) / 64.0) * 0.22
    }
}

#[cfg_attr(not(test), allow(dead_code))]
fn pet_window_dimensions(theme: &PetTheme, pet_size: u32) -> (f64, f64) {
    pet_window_dimensions_for(theme, pet_size, 1, "vertical")
}

fn pet_window_dimensions_for(
    theme: &PetTheme,
    pet_size: u32,
    hud_count: u32,
    hud_layout: &str,
) -> (f64, f64) {
    match theme {
        PetTheme::HudGauge => {
            let s = hud_card_scale(pet_size);
            let n = hud_count.clamp(1, 4) as f64;
            if n <= 1.0 {
                return ((178.0 * s).round(), (64.0 * s).round());
            }
            let gap = (5.0 * s).round();
            if hud_layout == "horizontal" {
                let card_w = (if hud_count == 2 { 164.0 } else { 152.0 } * s).round();
                let total_w = card_w * n + gap * (n - 1.0) + 6.0;
                let total_h = (64.0 * s).round();
                (total_w, total_h)
            } else {
                let card_w = (184.0 * s).round();
                let card_h = (if hud_count >= 3 { 54.0 } else { 58.0 } * s).round();
                let total_h = card_h * n + gap * (n - 1.0) + 6.0;
                (card_w, total_h)
            }
        }
        _ => {
            let h = pet_size as f64;
            (h, h)
        }
    }
}

fn clamp_pet_inside_monitor(pet: &tauri::WebviewWindow) {
    let (Ok(pos), Ok(size)) = (pet.outer_position(), pet.outer_size()) else {
        return;
    };
    let monitor = pet
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| pet.primary_monitor().ok().flatten());
    let Some(mon) = monitor else {
        return;
    };
    let wa = mon.work_area();
    let l = wa.position.x;
    let t = wa.position.y;
    let max_x = (l + wa.size.width as i32 - size.width as i32).max(l);
    let max_y = (t + wa.size.height as i32 - size.height as i32).max(t);
    let nx = pos.x.clamp(l, max_x);
    let ny = pos.y.clamp(t, max_y);
    if (nx, ny) != (pos.x, pos.y) {
        let _ = pet.set_position(Position::Physical(PhysicalPosition::new(nx, ny)));
    }
}

fn position_pet_initial(app: &AppHandle, cfg: &AppSettings) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let (pet_w, pet_h) = pet_window_dimensions_for(&cfg.pet_theme, cfg.pet_size, cfg.hud_count, &cfg.hud_layout);
    let _ = pet.set_size(Size::Logical(LogicalSize::new(pet_w, pet_h)));

    if let (Some(x), Some(y)) = (cfg.pet_x, cfg.pet_y) {
        let _ = pet.set_position(Position::Physical(PhysicalPosition::new(x, y)));
        clamp_pet_inside_monitor(&pet);
        return;
    }

    if let Ok(Some(monitor)) = pet.primary_monitor() {
        let scale = monitor.scale_factor();
        let wa = monitor.work_area();
        let w_px = (pet_w * scale).round() as i32;
        let h_px = (pet_h * scale).round() as i32;
        let margin = (24.0 * scale).round() as i32;
        let x = wa.position.x + wa.size.width as i32 - w_px - margin;
        let y = wa.position.y + wa.size.height as i32 - h_px - margin;
        let _ = pet.set_position(Position::Physical(PhysicalPosition::new(x, y)));
    }
}

fn apply_saved_panel_size(app: &AppHandle, panel: &tauri::WebviewWindow) {
    let saved = app.try_state::<SharedState>().and_then(|s| {
        s.0.lock().ok().map(|mut g| {
            g.last_auto_position = Instant::now();
            (g.settings.panel_width, g.settings.panel_height)
        })
    });
    if let Some((Some(w), Some(h))) = saved {
        let _ = panel.set_size(Size::Logical(LogicalSize::new(
            w.clamp(320, 680) as f64,
            h.clamp(420, 1080) as f64,
        )));
    }
}

fn panel_pos_on_any_monitor(panel: &tauri::WebviewWindow, x: i32, y: i32) -> bool {
    let Ok(monitors) = panel.available_monitors() else {
        return false;
    };
    let (pw, ph) = panel
        .outer_size()
        .map(|s| (s.width as i32, s.height as i32))
        .unwrap_or((376, 620));
    let cx = x + pw / 2;
    let cy = y + (ph / 2).min(120);
    monitors.iter().any(|m| {
        let wa = m.work_area();
        let l = wa.position.x;
        let t = wa.position.y;
        let r = l + wa.size.width as i32;
        let b = t + wa.size.height as i32;
        cx >= l && cx <= r && cy >= t && cy <= b
    })
}

fn schedule_bounds_save(state: SharedState, seq: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        if let Ok(guard) = state.0.lock() {
            if guard.bounds_save_seq == seq {
                let _ = settings::save_settings(&guard.settings);
            }
        }
    });
}

fn should_restore_saved_panel_pos(where_: &str, saved_pos: Option<(i32, i32)>) -> bool {
    where_ == "remember" && saved_pos.is_some()
}

fn compute_panel_position_in_work_area(
    where_: &str,
    work_area: (i32, i32, i32, i32),
    panel_size: (i32, i32),
    scale: f64,
) -> (i32, i32) {
    let (l, t, wa_w, wa_h) = work_area;
    let r = l + wa_w;
    let b = t + wa_h;
    let (w, h) = panel_size;
    let m = (12.0 * scale).round() as i32;
    let max_x = (r - w - m).max(l);
    let max_y = (b - h - m).max(t);
    let (raw_x, raw_y) = match where_ {
        "top_left" => (l + m, t + m),
        "bottom_left" => (l + m, b - h - m),
        "top_right" => (r - w - m, t + m),
        "bottom_right" => (r - w - m, b - h - m),
        _ => (l + (wa_w - w) / 2, t + (wa_h - h) / 2),
    };
    let min_x = (l + m).min(max_x);
    let min_y = (t + m).min(max_y);
    (raw_x.clamp(min_x, max_x), raw_y.clamp(min_y, max_y))
}

fn compute_panel_position_near_pet(
    work_area: (i32, i32, i32, i32),
    pet_rect: (i32, i32, i32, i32),
    panel_size: (i32, i32),
    scale: f64,
) -> (i32, i32) {
    let (wa_left, wa_top, wa_w, wa_h) = work_area;
    let wa_right = wa_left + wa_w;
    let wa_bottom = wa_top + wa_h;
    let (pet_x, pet_y, pet_w, pet_h) = pet_rect;
    let (pw, ph) = panel_size;
    let gap = (10.0 * scale).round() as i32;
    let margin = (8.0 * scale).round() as i32;
    let max_x = (wa_right - pw - margin).max(wa_left + margin);
    let max_y = (wa_bottom - ph - margin).max(wa_top + margin);

    let pet_cx = pet_x + pet_w / 2;
    let wa_cx = wa_left + wa_w / 2;
    let aligned_x = if pet_cx < wa_cx {
        // Pet is on the left half of the monitor: align panel left edge with pet left edge.
        pet_x
    } else {
        // Pet is on the right half: align panel right edge with pet right edge.
        pet_x + pet_w - pw
    };
    let clamped_x = aligned_x.clamp(wa_left + margin, max_x);

    let space_above = pet_y - wa_top;
    let space_below = wa_bottom - (pet_y + pet_h);
    let fits_above = space_above >= ph + gap;
    let fits_below = space_below >= ph + gap;

    let pet_cy = pet_y + pet_h / 2;
    let wa_cy = wa_top + wa_h / 2;

    if fits_above && (!fits_below || pet_cy >= wa_cy) {
        return (clamped_x, (pet_y - ph - gap).clamp(wa_top + margin, max_y));
    }
    if fits_below {
        return (clamped_x, (pet_y + pet_h + gap).clamp(wa_top + margin, max_y));
    }

    // Neither above nor below fits completely (e.g. pet parked near vertical center):
    // open beside the pet if there is room so we don't cover it.
    let space_right = wa_right - (pet_x + pet_w);
    let space_left = pet_x - wa_left;
    let side_y = pet_y.clamp(wa_top + margin, max_y);
    if space_right >= pw + gap && (space_right >= space_left || pet_cx < wa_cx) {
        return ((pet_x + pet_w + gap).clamp(wa_left + margin, max_x), side_y);
    }
    if space_left >= pw + gap {
        return ((pet_x - pw - gap).clamp(wa_left + margin, max_x), side_y);
    }

    let fallback_y = if space_above >= space_below {
        (pet_y - ph - gap).clamp(wa_top + margin, max_y)
    } else {
        (pet_y + pet_h + gap).clamp(wa_top + margin, max_y)
    };
    (clamped_x, fallback_y)
}

fn panel_physical_size_for_monitor(
    panel: &tauri::WebviewWindow,
    target_scale: f64,
    saved_size: (Option<u32>, Option<u32>),
) -> (i32, i32) {
    let target_scale = target_scale.max(0.5);
    if let (Some(w), Some(h)) = saved_size {
        let lw = w.clamp(320, 680) as f64;
        let lh = h.clamp(420, 1080) as f64;
        return ((lw * target_scale).round() as i32, (lh * target_scale).round() as i32);
    }
    let cur_scale = panel.scale_factor().unwrap_or(target_scale).max(0.5);
    if let Ok(size) = panel.outer_size() {
        if (cur_scale - target_scale).abs() < 0.01 {
            return (size.width as i32, size.height as i32);
        }
        let ratio = target_scale / cur_scale;
        return (
            (size.width as f64 * ratio).round() as i32,
            (size.height as f64 * ratio).round() as i32,
        );
    }
    ((376.0 * target_scale).round() as i32, (620.0 * target_scale).round() as i32)
}

fn mark_auto_position(app: &AppHandle) {
    if let Some(state) = app.try_state::<SharedState>() {
        if let Ok(mut g) = state.0.lock() {
            g.last_auto_position = Instant::now();
        }
    }
}

/// Place the panel according to the "panel position" setting.
fn position_panel(app: &AppHandle, panel: &tauri::WebviewWindow) {
    let (mut where_, show_pet, saved_pos, saved_size) = app
        .try_state::<SharedState>()
        .and_then(|s| {
            s.0.lock().ok().map(|mut g| {
                g.last_auto_position = Instant::now();
                (
                    g.settings.panel_position.clone(),
                    g.settings.show_pet,
                    g.settings.panel_x.zip(g.settings.panel_y),
                    (g.settings.panel_width, g.settings.panel_height),
                )
            })
        })
        .unwrap_or_else(|| ("pet".to_string(), true, None, (None, None)));

    if should_restore_saved_panel_pos(&where_, saved_pos)
        && saved_pos.is_some_and(|(x, y)| panel_pos_on_any_monitor(panel, x, y))
    {
        let (x, y) = saved_pos.unwrap();
        let _ = panel.set_position(Position::Physical(PhysicalPosition::new(x, y)));
        mark_auto_position(app);
        return;
    }

    if where_ == "remember" {
        where_ = if show_pet { "pet".to_string() } else { "bottom_right".to_string() };
    }
    if where_ == "pet" {
        if show_pet {
            position_panel_near_pet(app, panel, saved_size);
            mark_auto_position(app);
            return;
        }
        where_ = "bottom_right".to_string();
    }
    let monitor = if show_pet {
        app.get_webview_window("pet")
            .and_then(|p| p.current_monitor().ok().flatten())
            .or_else(|| panel.current_monitor().ok().flatten())
            .or_else(|| panel.primary_monitor().ok().flatten())
    } else {
        panel
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| panel.primary_monitor().ok().flatten())
    };
    let Some(mon) = monitor else {
        position_panel_near_pet(app, panel, saved_size);
        mark_auto_position(app);
        return;
    };
    let wa = mon.work_area();
    let scale = mon.scale_factor();
    let panel_size = panel_physical_size_for_monitor(panel, scale, saved_size);
    let (x, y) = compute_panel_position_in_work_area(
        &where_,
        (wa.position.x, wa.position.y, wa.size.width as i32, wa.size.height as i32),
        panel_size,
        scale,
    );
    let _ = panel.set_position(Position::Physical(PhysicalPosition::new(x, y)));
    mark_auto_position(app);
}

fn position_panel_near_pet(
    app: &AppHandle,
    panel: &tauri::WebviewWindow,
    saved_size: (Option<u32>, Option<u32>),
) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let Ok(pet_pos) = pet.outer_position() else {
        return;
    };
    let Ok(pet_size) = pet.outer_size() else {
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
        let panel_size = panel_physical_size_for_monitor(panel, scale, saved_size);
        let (x, y) = compute_panel_position_near_pet(
            (wa.position.x, wa.position.y, wa.size.width as i32, wa.size.height as i32),
            (pet_pos.x, pet_pos.y, pet_size.width as i32, pet_size.height as i32),
            panel_size,
            scale,
        );
        let _ = panel.set_position(Position::Physical(PhysicalPosition::new(x, y)));
    } else {
        let _ = panel.set_position(Position::Logical(LogicalPosition::new(100.0, 100.0)));
    }
}

pub fn run() {
    logging::install_panic_hook();
    logging::log(&format!(
        "start v{} args={:?}",
        env!("CARGO_PKG_VERSION"),
        std::env::args().skip(1).collect::<Vec<_>>()
    ));
    if std::env::args().any(|a| a == logging::RELAUNCH_FLAG) {
        // Let the crashed instance release the single-instance lock first.
        std::thread::sleep(Duration::from_secs(2));
    }
    let loaded_settings = settings::load_settings();
    i18n::set_lang(&loaded_settings.language);
    usage_stats::set_price_overrides(&loaded_settings.model_prices);
    let shared = SharedState(
        Arc::new(Mutex::new(InnerState {
            settings: loaded_settings.clone(),
            snapshot: None,
            notify: NotifyState::load(),
            panel_pinned: loaded_settings.panel_pinned,
            last_toggle: Instant::now() - Duration::from_secs(5),
            last_auto_position: Instant::now() - Duration::from_secs(5),
            bounds_save_seq: 0,
            tray_id: "main-tray".to_string(),
            cache: QuotaCache::load(),
            history: History::load(),
            hotkey_error: None,
            tray_icon_key: String::new(),
            mobile_status: MobileStatus::default(),
            cred_stamps: HashMap::new(),
            last_usage_scan: 0,
            last_usage_today: HashMap::new(),
        })),
        Arc::new(RefreshRuntime::new()),
    );
    seed_initial_snapshot(&shared);

    tauri::Builder::default()
        // Must be registered first: a second launch (autostart + double-click)
        // hands over to the running copy instead of fighting over the tray and port.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let ready = SETUP_DONE.load(Ordering::Acquire);
            let pet = app.get_webview_window("pet");
            let panel = app.get_webview_window("panel");
            logging::log(&format!(
                "second launch received, args={args:?}, ready={ready}, has_pet={}, has_panel={}",
                pet.is_some(),
                panel.is_some()
            ));
            if ready && pet.is_none() && panel.is_none() {
                logging::relaunch_guard("second launch hit windowless instance");
                force_exit(app, 0, "windowless instance on second launch");
            }
            let show_pet = app
                .try_state::<SharedState>()
                .and_then(|s| s.0.lock().ok().map(|g| g.settings.show_pet))
                .unwrap_or(true);
            if show_pet {
                if let Some(pet) = pet {
                    let _ = pet.unminimize();
                    let _ = pet.show();
                }
            }
            if let Some(panel) = panel {
                let pinned = app
                    .try_state::<SharedState>()
                    .and_then(|s| {
                        s.0.lock().ok().map(|mut g| {
                            g.last_toggle = Instant::now();
                            g.panel_pinned
                        })
                    })
                    .unwrap_or(false);
                apply_saved_panel_size(app, &panel);
                apply_panel_pin_state(&panel, pinned);
                apply_panel_backdrop_from_state(app, &panel);
                position_panel(app, &panel);
                let _ = panel.unminimize();
                let _ = panel.show();
                let _ = panel.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
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
            rescan_accounts,
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
            account_sources,
            tailscale_state,
            open_target,
            qr_svg,
            diagnostics,
            pick_folder,
            get_activity,
            show_bubble,
            hide_bubble,
            usage_report,
            open_analytics,
            add_account_login,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            position_pet_initial(&handle, &loaded_settings);
            if let Some(pet) = app.get_webview_window("pet") {
                if loaded_settings.show_pet {
                    let _ = pet.show();
                }
                pet.on_window_event(|event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                    }
                });
            }
            if let Some(b) = app.get_webview_window("bubble") {
                let _ = b.set_ignore_cursor_events(true);
                let bubble_handle = handle.clone();
                b.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(w) = bubble_handle.get_webview_window("bubble") {
                            let _ = w.hide();
                        }
                    }
                });
            }
            {
                let act_app = handle.clone();
                let act_state = shared.clone();
                let last_triggers: Arc<Mutex<HashMap<String, Instant>>> =
                    Arc::new(Mutex::new(HashMap::new()));
                activity::spawn(handle.clone(), move |acc_id| {
                    if let Ok(mut map) = last_triggers.lock() {
                        if map
                            .get(&acc_id)
                            .is_some_and(|t| t.elapsed() < Duration::from_secs(15))
                        {
                            return;
                        }
                        map.insert(acc_id.clone(), Instant::now());
                    }
                    let h = act_app.clone();
                    let s = act_state.clone();
                    tauri::async_runtime::spawn(async move {
                        // Brief settle delay so upstream usage accounting commits before we query.
                        tokio::time::sleep(Duration::from_secs(4)).await;
                        let _ = run_refresh(&h, &s, RefreshReason::ActivityDone(acc_id)).await;
                    });
                });
            }
            let hk_err = apply_hotkey(&handle, &loaded_settings.hotkey);
            if let Ok(mut g) = shared.0.lock() {
                g.hotkey_error = hk_err;
            }
            if let Some(ref panel) = app.get_webview_window("panel") {
                if let Ok(mut g) = shared.0.lock() {
                    g.last_toggle = Instant::now();
                }
                apply_saved_panel_size(&handle, panel);
                apply_panel_pin_state(panel, loaded_settings.panel_pinned);
                apply_panel_backdrop(
                    panel,
                    &loaded_settings.panel_theme,
                    loaded_settings.panel_opacity,
                    &loaded_settings.appearance,
                );
                position_panel(&handle, panel);
                let _ = panel.show();
                let _ = panel.set_focus();
            }

            // Auto-hide panel when it loses focus (unless pinned), remember user moves/resizes, and guard against Alt+F4
            if let Some(panel) = app.get_webview_window("panel") {
                let panel_handle = handle.clone();
                let panel_state = shared.clone();
                panel.on_window_event(move |event| match event {
                    WindowEvent::Focused(false) => {
                        let pinned = panel_state
                            .0
                            .lock()
                            .map(|g| g.panel_pinned)
                            .unwrap_or(false);
                        let recently_toggled = panel_state
                            .0
                            .lock()
                            .map(|g| g.last_toggle.elapsed() < Duration::from_millis(600))
                            .unwrap_or(false);
                        if !pinned && !recently_toggled && !DIALOG_OPEN.load(Ordering::Acquire) {
                            if let Some(w) = panel_handle.get_webview_window("panel") {
                                let _ = w.hide();
                            }
                        }
                    }
                    WindowEvent::Moved(pos) => {
                        let visible = panel_handle
                            .get_webview_window("panel")
                            .and_then(|w| w.is_visible().ok())
                            .unwrap_or(false);
                        if !visible || pos.x < -10_000 || pos.y < -10_000 {
                            return;
                        }
                        if let Ok(mut g) = panel_state.0.lock() {
                            if g.last_auto_position.elapsed() < Duration::from_millis(500) {
                                return;
                            }
                            if g.settings.panel_x != Some(pos.x) || g.settings.panel_y != Some(pos.y) {
                                g.settings.panel_x = Some(pos.x);
                                g.settings.panel_y = Some(pos.y);
                                g.bounds_save_seq = g.bounds_save_seq.wrapping_add(1);
                                let seq = g.bounds_save_seq;
                                drop(g);
                                schedule_bounds_save(panel_state.clone(), seq);
                            }
                        }
                    }
                    WindowEvent::Resized(size) => {
                        let Some(w_win) = panel_handle.get_webview_window("panel") else {
                            return;
                        };
                        if !w_win.is_visible().unwrap_or(false) {
                            return;
                        }
                        let scale = w_win.scale_factor().unwrap_or(1.0).max(0.5);
                        let lw = (size.width as f64 / scale).round() as u32;
                        let lh = (size.height as f64 / scale).round() as u32;
                        if lw < 300 || lh < 360 {
                            return;
                        }
                        let cw = lw.clamp(320, 680);
                        let ch = lh.clamp(420, 1080);
                        if let Ok(mut g) = panel_state.0.lock() {
                            if g.last_auto_position.elapsed() < Duration::from_millis(500) {
                                return;
                            }
                            if g.settings.panel_width != Some(cw) || g.settings.panel_height != Some(ch) {
                                g.settings.panel_width = Some(cw);
                                g.settings.panel_height = Some(ch);
                                g.bounds_save_seq = g.bounds_save_seq.wrapping_add(1);
                                let seq = g.bounds_save_seq;
                                drop(g);
                                schedule_bounds_save(panel_state.clone(), seq);
                            }
                        }
                    }
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        if let Some(w) = panel_handle.get_webview_window("panel") {
                            let _ = w.hide();
                        }
                    }
                    _ => {}
                });
            }

            // Build Windows system tray
            let menu = build_tray_menu(app.handle())?;

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
                        "analytics" => {
                            if let Err(e) = show_panel_tab(app, "analytics") {
                                logging::log(&format!("open analytics tab from tray failed: {e}"));
                            }
                        }
                        "refresh" => {
                            let h = app.clone();
                            let s = state_c.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = run_refresh(&h, &s, RefreshReason::Manual).await;
                            });
                        }
                        "reset_pos" => {
                            let cfg = state_c.0.lock().ok().map(|mut guard| {
                                guard.settings.pet_x = None;
                                guard.settings.pet_y = None;
                                let _ = settings::save_settings(&guard.settings);
                                guard.settings.clone()
                            });
                            if let Some(cfg) = cfg {
                                position_pet_initial(app, &cfg);
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

            spawn_mobile_supervisor(handle.clone(), shared.clone());

            // Background adaptive scheduler loop (ticks every 30s; only due accounts hit the network)
            let poll_app = handle.clone();
            let poll_state = shared.clone();
            tauri::async_runtime::spawn(async move {
                let mut first = true;
                loop {
                    let (app_c, state_c) = (poll_app.clone(), poll_state.clone());
                    let reason = if first {
                        first = false;
                        RefreshReason::Startup
                    } else {
                        RefreshReason::Scheduled
                    };
                    let run = tauri::async_runtime::spawn(async move {
                        let _ = run_refresh(&app_c, &state_c, reason).await;
                    });
                    if let Err(err) = run.await {
                        logging::log(&format!("refresh task failed: {err}"));
                    }
                    poll_state.0.clear_poison();
                    tokio::time::sleep(Duration::from_secs(SCHEDULER_TICK_SECS)).await;
                }
            });

            SETUP_DONE.store(true, Ordering::Release);
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|err| {
            logging::log(&format!("build failed: {err}"));
            panic!("error while building t3-deskcat: {err}");
        })
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { code, .. } => {
                logging::log(&format!("exit requested code={code:?}"));
                if let Some(exit_code) = code {
                    force_exit(app, exit_code, "explicit quit");
                } else {
                    // `None` means the last window went away on its own, which this tray app never wants.
                    // Left alone the process lingers with no window and no tray (tested),
                    // so start a fresh copy and end this one for real.
                    logging::relaunch_guard("all windows closed unexpectedly");
                    force_exit(app, 0, "unexpected window close");
                }
            }
            tauri::RunEvent::Exit => logging::log("exit"),
            _ => {}
        });
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
                    id: None,
                    label: "5h".to_string(),
                    remaining_percent: pct,
                    reset_at: None,
                },
                QuotaWindow {
                    id: None,
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
    fn pet_window_dimensions_are_compact_for_hud_and_square_for_others() {
        assert_eq!(pet_window_dimensions(&PetTheme::HudGauge, 48), (157.0, 56.0));
        assert_eq!(pet_window_dimensions(&PetTheme::HudGauge, 64), (178.0, 64.0));
        assert_eq!(pet_window_dimensions(&PetTheme::HudGauge, 128), (217.0, 78.0));
        assert_eq!(pet_window_dimensions(&PetTheme::Custom, 64), (64.0, 64.0));
        // Multi-account vertical & horizontal layouts scale cleanly.
        let (vw, vh) = pet_window_dimensions_for(&PetTheme::HudGauge, 64, 2, "vertical");
        assert!(vw >= 178.0 && vh > 100.0);
        let (hw, hh) = pet_window_dimensions_for(&PetTheme::HudGauge, 64, 2, "horizontal");
        assert!(hw > 300.0 && hh == 64.0);
    }

    #[test]
    fn saved_panel_position_is_only_restored_in_remember_mode() {
        let saved = Some((500, 300));
        assert!(should_restore_saved_panel_pos("remember", saved));
        assert!(!should_restore_saved_panel_pos("remember", None));
        for mode in ["pet", "top_left", "top_right", "bottom_left", "bottom_right", "center"] {
            assert!(
                !should_restore_saved_panel_pos(mode, saved),
                "mode {mode} must not be overridden by saved coordinates"
            );
        }
    }

    #[test]
    fn panel_position_in_work_area_handles_all_presets_and_secondary_monitor() {
        let wa = (1920, 0, 1920, 1040);
        let size = (400, 600);
        assert_eq!(compute_panel_position_in_work_area("top_left", wa, size, 1.0), (1932, 12));
        assert_eq!(compute_panel_position_in_work_area("top_right", wa, size, 1.0), (3428, 12));
        assert_eq!(compute_panel_position_in_work_area("bottom_left", wa, size, 1.0), (1932, 428));
        assert_eq!(compute_panel_position_in_work_area("bottom_right", wa, size, 1.0), (3428, 428));
        assert_eq!(compute_panel_position_in_work_area("center", wa, size, 1.0), (2680, 220));
    }

    #[test]
    fn panel_position_near_pet_aligns_to_pet_edge_and_avoids_overlap() {
        let wa = (0, 0, 1920, 1040);
        let panel = (400, 620);

        // Pet near top-left: align panel left edge with pet left edge, open below pet.
        let (x, y) = compute_panel_position_near_pet(wa, (40, 20, 178, 64), panel, 1.0);
        assert_eq!((x, y), (40, 94));

        // Pet near bottom-right: align panel right edge with pet right edge, open above pet.
        let (x, y) = compute_panel_position_near_pet(wa, (1718, 952, 178, 64), panel, 1.0);
        assert_eq!((x, y), (1496, 322));

        // Pet near top-right: align panel right edge with pet right edge, open below pet.
        let (x, y) = compute_panel_position_near_pet(wa, (1718, 20, 178, 64), panel, 1.0);
        assert_eq!((x, y), (1496, 94));

        // Pet near vertical center on left side: neither above nor below fits -> open to the right of pet.
        let (x, y) = compute_panel_position_near_pet(wa, (40, 500, 178, 64), panel, 1.0);
        assert_eq!((x, y), (228, 412));
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
        assert_eq!(picks.len(), 3);
        assert_eq!(picks[0].account_name, "Beta");
        assert_eq!(picks[1].account_name, "Delta");
        assert_eq!(picks[2].account_name, "Codex");

        let tip = format_tooltip(&picks, &accounts);
        assert_eq!(tip, "Claude: Beta 94%｜AG: Delta 88%｜ChatGPT: Codex 90%");
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
            burn_rates: HashMap::new(),
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
            burn_rates: HashMap::new(),
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
        // Active accounts always beat expired cached snapshots in SmartPick.
        let picks = compute_picks(&[idle.clone(), busy], 0);
        assert_eq!(picks[0].account_name, "Busy");
        assert!(picks[0].note.is_none());

        // When every usable account for a provider is expired, fall back to last-known with a note.
        let fallback_picks = compute_picks(&[idle], 0);
        assert_eq!(fallback_picks[0].account_name, "Idle");
        assert!(fallback_picks[0].note.is_some());

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
            burn_rates: HashMap::new(),
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

    #[test]
    fn analytics_opens_in_panel_without_spawning_window() {
        // Usage analytics is embedded inside the main panel so opening it never
        // constructs a second WebView2 window (which also avoids wry#583 deadlocks).
        let src = include_str!("lib.rs");
        assert!(
            !src.contains(concat!("WebviewWindowBuilder", "::new(")),
            "analytics must stay embedded in the main panel instead of spawning a new window"
        );
        // Verify BoolResetGuard restores AtomicBool even on panic unwind.
        static TEST_FLAG: AtomicBool = AtomicBool::new(false);
        let res = std::panic::catch_unwind(|| {
            TEST_FLAG.store(true, Ordering::Release);
            let _g = BoolResetGuard(&TEST_FLAG);
            assert!(TEST_FLAG.load(Ordering::Acquire));
            panic!("simulated unwind");
        });
        assert!(res.is_err());
        assert!(!TEST_FLAG.load(Ordering::Acquire));
    }

    #[test]
    fn adaptive_intervals_balance_freshness_and_rate_limits() {
        // Active vs idle automatic polling
        assert_eq!(
            account_min_interval(ProviderKind::Claude, false, &RefreshReason::Scheduled, true, false, false),
            CLAUDE_ACTIVE_SECS
        );
        assert_eq!(
            account_min_interval(ProviderKind::Claude, false, &RefreshReason::Scheduled, false, false, false),
            CLAUDE_IDLE_SECS
        );
        assert_eq!(
            account_min_interval(ProviderKind::Antigravity, true, &RefreshReason::Scheduled, true, false, false),
            AG_CLI_ACTIVE_SECS
        );
        assert_eq!(
            account_min_interval(ProviderKind::Antigravity, true, &RefreshReason::Scheduled, false, false, false),
            AG_CLI_IDLE_SECS
        );

        // Manual refresh uses short debounce (never trapped behind 180s auto interval)
        assert_eq!(
            account_min_interval(ProviderKind::Claude, false, &RefreshReason::Manual, false, false, false),
            CLAUDE_MANUAL_SECS
        );
        assert_eq!(
            account_min_interval(ProviderKind::Antigravity, true, &RefreshReason::Manual, false, false, false),
            AG_CLI_MANUAL_SECS
        );

        // Turn finished / reset passed accelerate refreshes
        assert_eq!(
            account_min_interval(
                ProviderKind::Claude,
                false,
                &RefreshReason::ActivityDone("claude:a".into()),
                true,
                false,
                false
            ),
            CLAUDE_TRIGGERED_SECS
        );
        assert_eq!(
            account_min_interval(ProviderKind::Claude, false, &RefreshReason::Scheduled, false, false, true),
            CLAUDE_TRIGGERED_SECS
        );

        // Opening the panel accelerates active accounts without waking idle ones
        assert_eq!(
            account_min_interval(ProviderKind::Claude, false, &RefreshReason::OnDemand, true, false, false),
            CLAUDE_TRIGGERED_SECS
        );
        assert_eq!(
            account_min_interval(ProviderKind::Claude, false, &RefreshReason::OnDemand, false, false, false),
            CLAUDE_IDLE_SECS
        );

        // Credential file change always triggers immediate refresh
        assert_eq!(
            account_min_interval(ProviderKind::Claude, false, &RefreshReason::Scheduled, false, true, false),
            0
        );
    }
}

#[cfg(test)]
mod live_probe_tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    #[tokio::test]
    #[ignore]
    async fn probe_real_local_environment() {
        // 1. Read-only account discovery
        let discovered = discover_accounts(&[]);
        assert!(!discovered.is_empty(), "expected at least one local account");
        eprintln!("[1/6] discovered {} accounts:", discovered.len());
        support::set_sources(discovered.iter().map(|a| (a.id().to_string(), a.source())).collect());
        let sources = support::sources();
        for a in &discovered {
            let src = sources.get(a.id()).map(String::as_str).unwrap_or("?");
            eprintln!("  - {} source={}", a.id(), src);
        }

        // 2. One read-only quota fetch per discovered account (in-memory only)
        let client = Client::builder().timeout(Duration::from_secs(20)).build().unwrap();
        let mut results = Vec::new();
        for acc in discovered {
            let outcome = match acc {
                DiscoveredAccount::Claude { id, name, credentials_path, .. } => {
                    fetch_claude_quota(&client, id, name, &credentials_path).await
                }
                DiscoveredAccount::Antigravity { id, name, token_path, is_legacy_gemini, .. } => {
                    fetch_antigravity_quota(id, name, &token_path, is_legacy_gemini).await
                }
                DiscoveredAccount::AntigravityCli { id, name, exe, .. } => {
                    providers::antigravity_cli::fetch_antigravity_cli_quota(id, name, &exe).await
                }
                DiscoveredAccount::Codex { id, name, auth_path, .. } => {
                    fetch_codex_quota(&client, id, name, &auth_path).await
                }
            };
            let q = outcome.quota;
            eprintln!(
                "[2/6] {} ({}) plan={:?} status={} eff={}% primary={:?} extra={:?} err={:?}",
                q.id,
                q.name,
                q.plan,
                q.status,
                q.effective_remaining,
                q.primary_windows.iter().map(|w| (&w.label, w.remaining_percent)).collect::<Vec<_>>(),
                q.extra_windows.iter().map(|w| (&w.label, w.remaining_percent)).collect::<Vec<_>>(),
                q.error
            );
            results.push(q);
        }

        // 3. Snapshot metrics computation (read-only loaded settings)
        let loaded_settings = settings::load_settings();
        let mut snap = DashboardSnapshot {
            accounts: results,
            picks: Vec::new(),
            overall_score: 0,
            mood: CatMood::Working,
            tooltip_text: String::new(),
            last_refreshed_at: Utc::now().timestamp(),
            settings: loaded_settings.clone(),
            offline: false,
            forecasts: HashMap::new(),
            usage_today: HashMap::new(),
            burn_rates: HashMap::new(),
        };
        recompute_snapshot_metrics(&mut snap, &loaded_settings);
        eprintln!(
            "[3/6] metrics: score={} mood={:?} offline={} picks={:?} tooltip={:?}",
            snap.overall_score,
            snap.mood,
            snap.offline,
            snap.picks.iter().map(|p| format!("{}:{}({}%)", p.provider.short_label(), p.account_name, p.effective_remaining)).collect::<Vec<_>>(),
            snap.tooltip_text
        );

        // 4. Support & Tailscale & Diagnostics leak check
        let ts_ip = mobile::tailscale_ip();
        let ts_state = support::tailscale_state();
        let qr = support::qr_svg("http://100.64.0.1:8765").unwrap();
        let diag = support::diagnostics(Some(&snap), "probe");
        for secret in ["ya29.", "sk-ant-", "refresh_token", "access_token", "client_secret"] {
            assert!(!diag.contains(secret), "diagnostics leaked secret marker {secret}");
        }
        eprintln!(
            "[4/6] tailscale={:?} installed={} connected={} qr_len={} diag_lines={}",
            ts_ip,
            ts_state.installed,
            ts_state.connected,
            qr.len(),
            diag.lines().count()
        );

        // 5. Real mobile HTTP server check with compiled ../dist assets over loopback TCP
        let dist_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("dist");
        assert!(dist_dir.join("panel.html").is_file(), "dist/panel.html missing");
        let panel_html = fs::read_to_string(dist_dir.join("panel.html")).unwrap();
        let asset_rel = panel_html
            .split("src=\"/")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .unwrap()
            .to_string();
        let snap_for_remote = snap.clone();
        let dist_for_remote = dist_dir.clone();
        let remote = Arc::new(mobile::Remote {
            snapshot: Box::new(move || Some(snap_for_remote.clone())),
            asset: Box::new(move |rel| {
                let p = dist_for_remote.join(rel);
                let bytes = fs::read(&p).ok()?;
                let mime = if rel.ends_with(".html") {
                    "text/html; charset=utf-8"
                } else if rel.ends_with(".js") {
                    "application/javascript; charset=utf-8"
                } else if rel.ends_with(".css") {
                    "text/css; charset=utf-8"
                } else {
                    "application/octet-stream"
                };
                Some((bytes, mime.to_string()))
            }),
            invoke: Box::new(|cmd, _args| {
                Box::pin(async move {
                    if cmd == "get_snapshot" {
                        Ok(serde_json::json!({"ok": true}))
                    } else {
                        Err((403, "not allowed from the phone".into()))
                    }
                })
            }),
        });
        let http_call = |req: String| {
            let r = remote.clone();
            async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let addr = listener.local_addr().unwrap();
                let srv = tokio::spawn(async move {
                    let (stream, _) = listener.accept().await.unwrap();
                    mobile::test_handle(stream, r).await;
                });
                let mut cli = TcpStream::connect(addr).await.unwrap();
                cli.write_all(req.as_bytes()).await.unwrap();
                let _ = cli.shutdown().await;
                let mut raw = Vec::new();
                cli.read_to_end(&mut raw).await.unwrap();
                srv.await.unwrap();
                let sep = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
                let head = String::from_utf8_lossy(&raw[..sep]).to_string();
                let code = head
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|s| s.parse::<u16>().ok())
                    .unwrap();
                (code, head, raw[sep + 4..].to_vec())
            }
        };
        let (c_root, _, b_root) = http_call("GET / HTTP/1.1\r\nHost: x\r\n\r\n".into()).await;
        assert_eq!(c_root, 200);
        assert!(!b_root.is_empty());
        let (c_ana, _, b_ana) = http_call("GET /analytics.html HTTP/1.1\r\nHost: x\r\n\r\n".into()).await;
        assert_eq!(c_ana, 200);
        assert!(!b_ana.is_empty());
        let (c_js, _, b_js) = http_call(format!("GET /{asset_rel} HTTP/1.1\r\nHost: x\r\n\r\n")).await;
        assert_eq!(c_js, 200);
        assert!(!b_js.is_empty());
        let (c_snap, _, b_snap) = http_call("GET /api/snapshot HTTP/1.1\r\nHost: x\r\n\r\n".into()).await;
        assert_eq!(c_snap, 200);
        assert!(!b_snap.is_empty());
        let (c_inv, _, _) = http_call("POST /api/invoke/get_snapshot HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}".into()).await;
        assert_eq!(c_inv, 200);
        let (c_deny, _, _) = http_call("POST /api/invoke/quit_app HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}".into()).await;
        assert_eq!(c_deny, 403);
        eprintln!(
            "[5/6] real dist + mobile HTTP OK: /({}B) /analytics.html({}B) /{}({}B) /api/snapshot({}B) invoke=200 quit=403",
            b_root.len(),
            b_ana.len(),
            asset_rel,
            b_js.len(),
            b_snap.len()
        );

        // 6. Read-only parse check on persisted %APPDATA%\t3-deskcat JSON files
        let app_dir = dirs::config_dir().unwrap().join("t3-deskcat");
        let s_raw = fs::read_to_string(app_dir.join("settings.json")).unwrap();
        let _: AppSettings = serde_json::from_str(&s_raw).unwrap();
        let h_raw = fs::read_to_string(app_dir.join("history.json")).unwrap();
        let h_parsed: History = serde_json::from_str(&h_raw).unwrap();
        let c_raw = fs::read_to_string(app_dir.join("quota_cache.json")).unwrap();
        let c_parsed: QuotaCache = serde_json::from_str(&c_raw).unwrap();
        let n_raw = fs::read_to_string(app_dir.join("notify_state.json")).unwrap();
        let n_parsed: NotifyState = serde_json::from_str(&n_raw).unwrap();
        let l_raw = fs::read_to_string(app_dir.join("usage-ledger.json")).unwrap();
        let l_parsed: serde_json::Value = serde_json::from_str(&l_raw).unwrap();
        assert_eq!(l_parsed.get("version").and_then(|v| v.as_u64()), Some(1));
        assert!(l_parsed.get("buckets").and_then(|v| v.as_object()).is_some());
        eprintln!(
            "[6/7] persisted files valid (read-only): history_series={} cache_accounts={} pending_resets={} ledger_buckets={} ledger_kb={}",
            h_parsed.samples.len(),
            c_parsed.last_good.len(),
            n_parsed.pending_resets.len(),
            l_parsed["buckets"].as_object().map(|m| m.len()).unwrap_or(0),
            l_raw.len() / 1024
        );

        // 7. Read-only real usage_stats::report across all 4 periods
        for (period, expected_slot) in [("day", "hour"), ("week", "day"), ("month", "day"), ("quarter", "day")] {
            let r = usage_stats::report(period);
            assert_eq!(r.period, period);
            assert_eq!(r.slot, expected_slot);
            assert!(r.from <= r.to, "invalid range for {period}");
            let total_tok: u64 = r.rows.iter().map(|x| x.input + x.output + x.cache_read + x.cache_write).sum();
            let total_cost: f64 = r
                .rows
                .iter()
                .filter_map(|x| x.cost)
                .map(|c| c.input + c.output + c.cache_read + c.cache_write)
                .sum();
            eprintln!(
                "[7/7] usage_report({period}): slot={} rows={} models={} tokens={} cost=${:.2}",
                r.slot,
                r.rows.len(),
                r.models.len(),
                total_tok,
                total_cost
            );
        }
    }

    /// Multi-round real-world scheduler soak test (read-only, in-memory cache).
    /// Runs 12 ticks × 30s = 6 minutes against the real local accounts, including
    /// simulated OnDemand (panel open) and Manual refresh, verifying:
    /// - zero false "stale" states on healthy throttled accounts
    /// - zero 429 rate-limit bursts
    /// - drastically reduced HTTP call volume on idle & unchanged-expired accounts
    #[tokio::test]
    #[ignore]
    async fn soak_test_real_local_scheduler() {
        let ticks: usize = std::env::var("SOAK_TICKS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(12);
        let tick_secs: u64 = std::env::var("SOAK_TICK_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30);

        let settings = settings::load_settings();
        let client = Client::builder().timeout(Duration::from_secs(20)).build().unwrap();
        let mut cache = QuotaCache::default();
        let mut cred_stamps: HashMap<String, (i64, u64)> = HashMap::new();

        let mut total_claude_http = 0usize;
        let mut total_ag_http = 0usize;
        let mut total_codex_http = 0usize;
        let mut total_429 = 0usize;
        let mut total_false_stale = 0usize;

        for tick in 0..ticks {
            let reason = match tick {
                0 => RefreshReason::Startup,
                3 => RefreshReason::OnDemand,
                7 => RefreshReason::Manual,
                _ => RefreshReason::Scheduled,
            };
            let now = Utc::now().timestamp();
            let discovered = discover_accounts(&settings.extra_account_dirs);

            let mut tick_claude_http = 0usize;
            let mut tick_ag_http = 0usize;
            let mut tick_codex_http = 0usize;
            let mut tick_skipped = 0usize;
            let mut tick_local = 0usize;
            let mut statuses: Vec<String> = Vec::new();
            let mut consecutive_claude_429 = 0u32;

            for acc in discovered {
                let id = acc.id().to_string();
                let provider = discovered_provider(&acc);
                let name = discovered_name(&acc).to_string();
                let placeholder = placeholder_account(&acc, now);

                let cred_changed = if let Some(st) = cred_stamp(&acc) {
                    let prev = cred_stamps.insert(id.clone(), st);
                    if prev.is_some_and(|p| p != st) {
                        cache.clear_expired(&id);
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };

                if settings.is_hidden(&id) {
                    tick_skipped += 1;
                    continue;
                }

                // Zero-network local cache checks
                if let DiscoveredAccount::Claude { ref credentials_path, .. } = acc {
                    let min_ts = cache.last_good_updated_at(&id).unwrap_or(0);
                    if let Some(lq) = read_local_claude_quota(&id, &name, credentials_path, min_ts, now) {
                        let rec = cache.reconcile_outcome(lq, None, now);
                        tick_local += 1;
                        statuses.push(format!("{}:{}({}%)", rec.name, rec.status, rec.effective_remaining));
                        continue;
                    }
                }
                if let DiscoveredAccount::Codex { ref auth_path, .. } = acc {
                    if let Some(home) = auth_path.parent() {
                        let min_ts = cache.last_good_updated_at(&id).unwrap_or(0);
                        if let Some(lq) = read_local_codex_quota(&id, &name, home, min_ts, now) {
                            let rec = cache.reconcile_outcome(lq, None, now);
                            tick_local += 1;
                            statuses.push(format!("{}:{}({}%)", rec.name, rec.status, rec.effective_remaining));
                            continue;
                        }
                    }
                }

                let skip_expired = !cred_changed
                    && !matches!(reason, RefreshReason::Manual | RefreshReason::Startup)
                    && cache.is_known_expired(&id);
                if skip_expired {
                    let sk = cache.skipped(&id, placeholder, now);
                    tick_skipped += 1;
                    statuses.push(format!("{}:{}", sk.name, sk.status));
                    continue;
                }

                let active = activity::is_account_active(&id, now, ACTIVE_WINDOW_SECS);
                let reset_passed = cache.has_passed_reset(&id, now);
                let min_interval = account_min_interval(
                    provider,
                    is_ag_cli(&acc),
                    &reason,
                    active,
                    cred_changed,
                    reset_passed,
                );
                let allow_retry =
                    matches!(reason, RefreshReason::Manual | RefreshReason::Startup) || cred_changed;
                if !cache.may_fetch(&id, now, min_interval, allow_retry) {
                    let sk = cache.skipped(&id, placeholder, now);
                    if sk.status == "stale" && sk.error.is_none() {
                        total_false_stale += 1;
                    }
                    tick_skipped += 1;
                    statuses.push(format!("{}:{}({}%)", sk.name, sk.status, sk.effective_remaining));
                    continue;
                }

                if provider == ProviderKind::Claude && consecutive_claude_429 >= 2 {
                    let sk = cache.skipped(&id, placeholder, now);
                    tick_skipped += 1;
                    statuses.push(format!("{}:{}(breaker)", sk.name, sk.status));
                    continue;
                }

                let outcome = match acc {
                    DiscoveredAccount::Claude { id, name, credentials_path, .. } => {
                        if tick_claude_http > 0 {
                            tokio::time::sleep(Duration::from_millis(2000)).await;
                        }
                        fetch_claude_quota(&client, id, name, &credentials_path).await
                    }
                    DiscoveredAccount::Antigravity { id, name, token_path, is_legacy_gemini, .. } => {
                        if tick_ag_http > 0 {
                            tokio::time::sleep(Duration::from_millis(200)).await;
                        }
                        fetch_antigravity_quota(id, name, &token_path, is_legacy_gemini).await
                    }
                    DiscoveredAccount::AntigravityCli { id, name, exe, .. } => {
                        providers::antigravity_cli::fetch_antigravity_cli_quota(id, name, &exe).await
                    }
                    DiscoveredAccount::Codex { id, name, auth_path, .. } => {
                        fetch_codex_quota(&client, id, name, &auth_path).await
                    }
                };

                if outcome.network_hit {
                    cache.note_attempt(&id, now);
                    match provider {
                        ProviderKind::Claude => tick_claude_http += 1,
                        ProviderKind::Antigravity => tick_ag_http += 1,
                        ProviderKind::Codex => tick_codex_http += 1,
                    }
                }
                if outcome.quota.status == "cooldown" {
                    total_429 += 1;
                    if provider == ProviderKind::Claude {
                        consecutive_claude_429 += 1;
                    }
                } else if outcome.network_hit && provider == ProviderKind::Claude {
                    consecutive_claude_429 = 0;
                }
                let rec = cache.reconcile_outcome(outcome.quota, outcome.retry_after_secs, now);
                if rec.status == "stale" && rec.error.is_none() {
                    total_false_stale += 1;
                }
                statuses.push(format!(
                    "{}:{}({}%){}",
                    rec.name,
                    rec.status,
                    rec.effective_remaining,
                    if outcome.network_hit { "*" } else { "" }
                ));
            }

            total_claude_http += tick_claude_http;
            total_ag_http += tick_ag_http;
            total_codex_http += tick_codex_http;
            eprintln!(
                "[soak tick={:02}/{} reason={:?}] http(claude={}, ag={}, codex={}) local={} skipped={} | {}",
                tick + 1,
                ticks,
                reason,
                tick_claude_http,
                tick_ag_http,
                tick_codex_http,
                tick_local,
                tick_skipped,
                statuses.join(", ")
            );

            if tick + 1 < ticks {
                tokio::time::sleep(Duration::from_secs(tick_secs)).await;
            }
        }

        eprintln!(
            "[soak SUMMARY] ticks={} total_http(claude={}, ag={}, codex={}) total_429={} total_false_stale={}",
            ticks, total_claude_http, total_ag_http, total_codex_http, total_429, total_false_stale
        );
        assert_eq!(total_false_stale, 0, "must never emit false stale without error");
        assert_eq!(total_429, 0, "soak test must not trigger any 429 rate limits");
    }
}

