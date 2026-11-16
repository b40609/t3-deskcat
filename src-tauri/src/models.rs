use serde::{Deserialize, Serialize};

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
    pub status: String, // "ok" | "error" | "expired"
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PetTheme {
    HudGauge,
    DeskCat,
    Custom,
}

impl Default for PetTheme {
    fn default() -> Self {
        Self::HudGauge
    }
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
    pub notify_low_threshold: i32,
    pub show_antigravity_extra: bool,
    pub launch_at_startup: bool,
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
            notify_low_threshold: 20,
            show_antigravity_extra: false,
            launch_at_startup: false,
            pet_x: None,
            pet_y: None,
            pet_theme: PetTheme::HudGauge,
            custom_image_working: None,
            custom_image_sweating: None,
            custom_image_sleeping: None,
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
}
