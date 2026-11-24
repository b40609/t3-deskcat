use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Claude,
    Antigravity,
    Codex,
}

impl ProviderKind {
    pub fn short_label(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Antigravity => "AG",
            Self::Codex => "ChatGPT",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub label: String,
    pub remaining_percent: i32,
    pub reset_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountQuota {
    pub id: String,
    pub provider: ProviderKind,
    pub name: String,
    pub plan: Option<String>,
    pub effective_remaining: i32,
    pub primary_windows: Vec<QuotaWindow>,
    pub extra_windows: Vec<QuotaWindow>,
    pub status: String, // "ok" | "stale" (cached) | "cooldown" | "error" | "expired"
    pub error: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartPick {
    pub provider: ProviderKind,
    pub account_id: String,
    pub account_name: String,
    pub effective_remaining: i32,
    pub reason: String,
    /// Reset time of the account's tightest limit.
    #[serde(default)]
    pub reset_at: Option<i64>,
    /// The tightest limit resets soon and still has quota: use it before it's lost.
    #[serde(default)]
    pub use_before_reset: bool,
    /// Extra caveat, e.g. the numbers are last-known because the token expired.
    #[serde(default)]
    pub note: Option<String>,
}

/// "At the current pace this limit runs out before it resets."
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Forecast {
    pub label: String,
    pub exhaust_at: i64,
    pub reset_at: Option<i64>,
    /// Burn rate in percent per hour.
    pub rate_per_hour: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScoreMode {
    /// Average of the best available account from each active provider
    MaxAvg,
    /// Average across all tracked accounts
    AllAvg,
}

impl Default for ScoreMode {
    fn default() -> Self {
        Self::MaxAvg
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CatMood {
    Working,
    Sweating,
    Sleeping,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PetTheme {
    HudGauge,
    Custom,
}

impl Default for PetTheme {
    fn default() -> Self {
        Self::HudGauge
    }
}

impl<'de> Deserialize<'de> for PetTheme {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = Option::<String>::deserialize(deserializer)?;
        Ok(match raw.as_deref() {
            Some("custom") => Self::Custom,
            // Removed themes (e.g. legacy "desk_cat" / Muse) and unknown values fall back to default.
            _ => Self::HudGauge,
        })
    }
}

/// Per-account display / alert preferences, keyed by account id.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AccountPref {
    pub alias: Option<String>,
    pub hidden: bool,
    /// Keep the account visible but leave it out of the overall score / mood.
    pub exclude_score: bool,
    /// Low-quota alert line for this account; None = global setting.
    pub notify_threshold: Option<i32>,
    /// Custom avatar as a small `data:image/...` URL; None = provider letter.
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub pet_size: u32,
    pub working_threshold: i32,
    pub sleeping_threshold: i32,
    pub score_mode: ScoreMode,
    pub refresh_interval_secs: u64,
    pub notify_enabled: bool,
    pub show_antigravity_extra: bool,
    pub launch_at_startup: bool,
    #[serde(default = "default_true")]
    pub show_pet: bool,
    pub pet_x: Option<i32>,
    pub pet_y: Option<i32>,
    #[serde(default)]
    pub pet_theme: PetTheme,
    #[serde(default)]
    pub custom_image_working: Option<String>,
    #[serde(default)]
    pub custom_image_sweating: Option<String>,
    #[serde(default)]
    pub custom_image_sleeping: Option<String>,
    // ---- Display customisation (all optional for backward compatibility)
    /// Panel text scale in percent (80-125).
    #[serde(default = "default_ui_scale")]
    pub ui_scale: u32,
    /// "system" | "light" | "dark"
    #[serde(default = "default_appearance")]
    pub appearance: String,
    /// "used" (Claude style) | "remaining"
    #[serde(default = "default_usage_display")]
    pub usage_display: String,
    /// "absolute" (於 下午7:00 重設) | "relative" (3 小時後重設)
    #[serde(default = "default_reset_format")]
    pub reset_format: String,
    /// Time tick on the bars: "on" | "ahead" (only when used faster than time) | "off".
    #[serde(default = "default_pace_tick")]
    pub pace_tick: String,
    /// UI language: "system" | "en" | "zh-TW" | "zh-CN" | "ja" | "ko".
    #[serde(default = "default_language")]
    pub language: String,
    /// Per-model price overrides (USD per million tokens), keyed by model id.
    #[serde(default)]
    pub model_prices: HashMap<String, crate::usage_stats::Price>,
    #[serde(default = "default_true")]
    pub show_picks: bool,
    /// Pet particle effects (music notes, Zzz, sweat, sparks)
    #[serde(default = "default_true")]
    pub pet_effects: bool,

    // ---- Accounts
    #[serde(default)]
    pub account_prefs: HashMap<String, AccountPref>,
    /// Display order of account ids (unknown ids go last).
    #[serde(default)]
    pub account_order: Vec<String>,

    // ---- Notifications
    /// Notify when a used-up window resets.
    #[serde(default = "default_true")]
    pub notify_on_reset: bool,
    #[serde(default)]
    pub quiet_hours_enabled: bool,
    /// Minutes after local midnight.
    #[serde(default = "default_quiet_start")]
    pub quiet_start_min: u32,
    #[serde(default = "default_quiet_end")]
    pub quiet_end_min: u32,

    // ---- Pet
    /// "slow" | "normal" | "fast"
    #[serde(default = "default_anim_speed")]
    pub pet_anim_speed: String,
    /// 30-100 (%)
    #[serde(default = "default_pet_opacity")]
    pub pet_opacity: u32,
    /// Fade the pet out while the mouse is elsewhere.
    #[serde(default)]
    pub pet_idle_fade: bool,
    /// "single" | "double" click to open the panel
    #[serde(default = "default_click_action")]
    pub pet_click_action: String,
    #[serde(default = "default_true")]
    pub pet_snap_edge: bool,

    // ---- Panel
    /// "pet" | "remember" | "top_right" | "bottom_right" | "top_left" | "bottom_left" | "center"
    #[serde(default = "default_panel_position")]
    pub panel_position: String,
    /// Dashboard visual layout: "classic" (cards) | "dense" (high-density dual-column)
    #[serde(default = "default_panel_layout")]
    pub panel_layout: String,
    /// Remembered desktop pinned state (stays open, non-always-on-top, shown on taskbar).
    #[serde(default)]
    pub panel_pinned: bool,
    /// Remembered panel outer position (physical px).
    #[serde(default)]
    pub panel_x: Option<i32>,
    #[serde(default)]
    pub panel_y: Option<i32>,
    /// Remembered panel logical size (px).
    #[serde(default)]
    pub panel_width: Option<u32>,
    #[serde(default)]
    pub panel_height: Option<u32>,
    /// Global shortcut that toggles the panel ("" = off).
    #[serde(default = "default_hotkey")]
    pub hotkey: String,
    /// One (tightest) limit per account.
    #[serde(default)]
    pub compact_accounts: bool,

    // ---- Data
    /// Minimum seconds between Claude usage calls per account.
    #[serde(default = "default_claude_interval")]
    pub claude_min_interval_secs: u64,

    // ---- Forecast / stats / tray
    /// "Runs out at 16:40" warnings.
    #[serde(default = "default_true")]
    pub show_forecast: bool,
    /// Today's tokens / equivalent API cost from the local CLI logs.
    #[serde(default)]
    pub show_usage_stats: bool,
    /// System tray icon: "number" | "ring" | "icon"
    #[serde(default = "default_tray_style")]
    pub tray_style: String,

    // ---- Phone
    /// Serve the read-only quota page on this PC's Tailscale address.
    #[serde(default)]
    pub mobile_enabled: bool,
    #[serde(default = "default_mobile_port")]
    pub mobile_port: u16,

    // ---- Accounts
    /// Extra folders to scan for accounts (a Claude `CLAUDE_CONFIG_DIR`, a `CODEX_HOME`,
    /// or a folder holding an Antigravity token), on top of the automatic ones.
    #[serde(default)]
    pub extra_account_dirs: Vec<String>,
}

fn default_mobile_port() -> u16 {
    8765
}

fn default_tray_style() -> String {
    "number".to_string()
}

fn default_quiet_start() -> u32 {
    23 * 60
}
fn default_quiet_end() -> u32 {
    9 * 60
}
fn default_anim_speed() -> String {
    "normal".to_string()
}
fn default_pet_opacity() -> u32 {
    100
}
fn default_click_action() -> String {
    "single".to_string()
}
fn default_panel_position() -> String {
    "pet".to_string()
}
fn default_panel_layout() -> String {
    "classic".to_string()
}
fn default_hotkey() -> String {
    "Ctrl+Alt+Q".to_string()
}
fn default_claude_interval() -> u64 {
    90
}

fn default_ui_scale() -> u32 {
    90
}
fn default_appearance() -> String {
    "system".to_string()
}
fn default_usage_display() -> String {
    "used".to_string()
}
fn default_reset_format() -> String {
    "absolute".to_string()
}
fn default_pace_tick() -> String {
    "ahead".to_string()
}
fn default_language() -> String {
    "system".to_string()
}
fn default_true() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            pet_size: 64,
            working_threshold: 70,
            sleeping_threshold: 20,
            score_mode: ScoreMode::MaxAvg,
            refresh_interval_secs: 120,
            notify_enabled: true,
            show_antigravity_extra: false,
            launch_at_startup: false,
            show_pet: true,
            pet_x: None,
            pet_y: None,
            pet_theme: PetTheme::HudGauge,
            custom_image_working: None,
            custom_image_sweating: None,
            custom_image_sleeping: None,
            ui_scale: default_ui_scale(),
            appearance: default_appearance(),
            usage_display: default_usage_display(),
            reset_format: default_reset_format(),
            pace_tick: default_pace_tick(),
            language: default_language(),
            model_prices: HashMap::new(),
            show_picks: true,
            pet_effects: true,
            account_prefs: HashMap::new(),
            account_order: Vec::new(),
            notify_on_reset: true,
            quiet_hours_enabled: false,
            quiet_start_min: default_quiet_start(),
            quiet_end_min: default_quiet_end(),
            pet_anim_speed: default_anim_speed(),
            pet_opacity: default_pet_opacity(),
            pet_idle_fade: false,
            pet_click_action: default_click_action(),
            pet_snap_edge: true,
            panel_position: default_panel_position(),
            panel_layout: default_panel_layout(),
            panel_pinned: false,
            panel_x: None,
            panel_y: None,
            panel_width: None,
            panel_height: None,
            hotkey: default_hotkey(),
            compact_accounts: false,
            claude_min_interval_secs: default_claude_interval(),
            show_forecast: true,
            show_usage_stats: false,
            tray_style: default_tray_style(),
            mobile_enabled: false,
            mobile_port: default_mobile_port(),
            extra_account_dirs: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSnapshot {
    pub accounts: Vec<AccountQuota>,
    pub picks: Vec<SmartPick>,
    pub overall_score: i32,
    pub mood: CatMood,
    pub tooltip_text: String,
    pub last_refreshed_at: i64,
    pub settings: AppSettings,
    /// No visible account returned fresh data this round (network down / all expired).
    #[serde(default)]
    pub offline: bool,
    /// Per account id.
    #[serde(default)]
    pub forecasts: HashMap<String, Forecast>,
    /// Per account id.
    #[serde(default)]
    pub usage_today: HashMap<String, crate::usage_stats::UsageToday>,
    /// Per account id: current burn rate of its shortest limit window, % per hour.
    #[serde(default)]
    pub burn_rates: HashMap<String, f64>,
}

impl AppSettings {
    pub fn pref(&self, id: &str) -> Option<&AccountPref> {
        self.account_prefs.get(id)
    }
    pub fn is_hidden(&self, id: &str) -> bool {
        self.pref(id).map(|p| p.hidden).unwrap_or(false)
    }
    pub fn counts_in_score(&self, id: &str) -> bool {
        self.pref(id).map(|p| !p.hidden && !p.exclude_score).unwrap_or(true)
    }
    pub fn display_name(&self, acc: &AccountQuota) -> String {
        self.pref(&acc.id)
            .and_then(|p| p.alias.as_deref())
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| acc.name.clone())
    }
    pub fn low_threshold_for(&self, id: &str) -> i32 {
        self.pref(id)
            .and_then(|p| p.notify_threshold)
            .unwrap_or(self.sleeping_threshold)
    }
    /// Whether `minute_of_day` (local) falls in the do-not-disturb window.
    pub fn in_quiet_hours(&self, minute_of_day: u32) -> bool {
        if !self.quiet_hours_enabled || self.quiet_start_min == self.quiet_end_min {
            return false;
        }
        let (s, e, m) = (self.quiet_start_min, self.quiet_end_min, minute_of_day);
        if s < e {
            m >= s && m < e
        } else {
            m >= s || m < e
        }
    }
}
