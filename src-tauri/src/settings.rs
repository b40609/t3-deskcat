use crate::models::{AccountPref, AppSettings};
use std::fs;
use std::path::PathBuf;

pub fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("t3-deskcat").join("settings.json"))
}

pub fn load_settings() -> AppSettings {
    let Some(path) = config_path() else {
        return AppSettings::default();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return AppSettings::default();
    };
    let mut parsed: AppSettings = serde_json::from_str(&raw).unwrap_or_default();
    sanitize(&mut parsed);
    parsed
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
    let mut clean = settings.clone();
    sanitize(&mut clean);

    let path = config_path().ok_or_else(|| "Unable to resolve config directory".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create settings directory: {err}"))?;
    }
    let body = serde_json::to_string_pretty(&clean)
        .map_err(|err| format!("Failed to serialize settings: {err}"))?;
    // Write to a temp file then rename, so a crash or shutdown mid-write cannot
    // leave a truncated settings.json (which would silently reset everything).
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|err| format!("Failed to write settings: {err}"))?;
    fs::rename(&tmp, &path).map_err(|err| format!("Failed to replace settings: {err}"))
}

pub fn sanitize(s: &mut AppSettings) {
    s.pet_size = s.pet_size.clamp(48, 128);
    s.sleeping_threshold = s.sleeping_threshold.clamp(0, 90);
    s.working_threshold = s.working_threshold.clamp(s.sleeping_threshold + 1, 99);
    s.refresh_interval_secs = s.refresh_interval_secs.clamp(30, 3600);
    s.ui_scale = s.ui_scale.clamp(80, 125);
    if !matches!(s.appearance.as_str(), "system" | "light" | "dark") {
        s.appearance = "system".to_string();
    }
    if !matches!(s.usage_display.as_str(), "used" | "remaining") {
        s.usage_display = "used".to_string();
    }
    if !matches!(s.reset_format.as_str(), "absolute" | "relative") {
        s.reset_format = "absolute".to_string();
    }
    if !matches!(s.language.as_str(), "system" | "en" | "zh-TW" | "zh-CN" | "ja" | "ko") {
        s.language = "system".to_string();
    }
    if !matches!(s.pace_tick.as_str(), "on" | "ahead" | "off") {
        s.pace_tick = "ahead".to_string();
    }
    s.quiet_start_min %= 24 * 60;
    s.quiet_end_min %= 24 * 60;
    if !matches!(s.pet_anim_speed.as_str(), "slow" | "normal" | "fast") {
        s.pet_anim_speed = "normal".to_string();
    }
    s.pet_opacity = s.pet_opacity.clamp(30, 100);
    if !matches!(s.pet_click_action.as_str(), "single" | "double") {
        s.pet_click_action = "single".to_string();
    }
    if !matches!(
        s.panel_position.as_str(),
        "pet" | "remember" | "top_right" | "bottom_right" | "top_left" | "bottom_left" | "center"
    ) {
        s.panel_position = "pet".to_string();
    }
    if !matches!(s.panel_layout.as_str(), "classic" | "dense") {
        s.panel_layout = "classic".to_string();
    }
    if !matches!(s.panel_theme.as_str(), "glass" | "ios" | "default") {
        s.panel_theme = "glass".to_string();
    }
    s.panel_opacity = s.panel_opacity.clamp(45, 100);
    s.panel_width = s.panel_width.map(|w| w.clamp(320, 680));
    s.panel_height = s.panel_height.map(|h| h.clamp(420, 1080));
    s.hotkey = s.hotkey.trim().to_string();
    s.claude_min_interval_secs = s.claude_min_interval_secs.clamp(60, 1800);
    if s.mobile_port < 1024 {
        s.mobile_port = 8765;
    }
    if !matches!(s.tray_style.as_str(), "number" | "ring" | "icon") {
        s.tray_style = "number".to_string();
    }
    s.picks_strategy = crate::ranking::normalize_strategy(&s.picks_strategy).to_string();
    if !crate::ranking::SCOPES.contains(&s.picks_scope.as_str()) {
        s.picks_scope = "per_provider".to_string();
    }
    s.picks_count = s.picks_count.clamp(1, 4);
    s.hud_count = s.hud_count.clamp(1, 4);
    if !matches!(s.hud_layout.as_str(), "vertical" | "horizontal") {
        s.hud_layout = "vertical".to_string();
    }
    s.hud_strategy = crate::ranking::normalize_strategy(&s.hud_strategy).to_string();
    if !crate::ranking::SCOPES.contains(&s.hud_scope.as_str()) {
        s.hud_scope = "global".to_string();
    }
    {
        let mut seen_p = std::collections::HashSet::new();
        s.picks_pinned_ids.retain(|id| !id.trim().is_empty() && seen_p.insert(id.clone()));
        let mut seen_h = std::collections::HashSet::new();
        s.hud_pinned_ids.retain(|id| !id.trim().is_empty() && seen_h.insert(id.clone()));
    }
    for p in s.account_prefs.values_mut() {
        if let Some(a) = p.alias.as_mut() {
            *a = a.trim().chars().take(40).collect();
        }
        if p.alias.as_deref() == Some("") {
            p.alias = None;
        }
        p.notify_threshold = p.notify_threshold.map(|t| t.clamp(1, 90));
        if p.avatar.as_ref().is_some_and(|a| !a.starts_with("data:image/") || a.len() > 300_000) {
            p.avatar = None;
        }
    }
    // Drop prefs that carry no information.
    s.account_prefs.retain(|_, p| *p != AccountPref::default());
    let mut seen = std::collections::HashSet::new();
    s.account_order.retain(|id| seen.insert(id.clone()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_hours_wrap_midnight() {
        let mut s = AppSettings::default();
        s.quiet_hours_enabled = true;
        s.quiet_start_min = 23 * 60;
        s.quiet_end_min = 9 * 60;
        assert!(s.in_quiet_hours(23 * 60 + 30));
        assert!(s.in_quiet_hours(3 * 60));
        assert!(!s.in_quiet_hours(9 * 60));
        assert!(!s.in_quiet_hours(14 * 60));
        s.quiet_start_min = 13 * 60;
        s.quiet_end_min = 14 * 60;
        assert!(s.in_quiet_hours(13 * 60 + 5));
        assert!(!s.in_quiet_hours(12 * 60));
    }

    #[test]
    fn old_settings_file_gets_new_defaults() {
        let raw = r#"{"petSize":64,"workingThreshold":70,"sleepingThreshold":20,"scoreMode":"max_avg",
            "refreshIntervalSecs":120,"notifyEnabled":true,"notifyLowThreshold":20,"showHistory":true,
            "showAntigravityExtra":false,"launchAtStartup":false,"petX":null,"petY":null}"#;
        let s: AppSettings = serde_json::from_str(raw).unwrap();
        assert_eq!(s.hotkey, "Ctrl+Alt+Q");
        assert_eq!(s.panel_layout, "classic");
        assert_eq!(s.panel_theme, "glass");
        assert_eq!(s.panel_opacity, 100);
        assert!(!s.panel_pinned);
        assert!(s.panel_x.is_none() && s.panel_width.is_none());
        assert_eq!(s.claude_min_interval_secs, 90);
        assert!(s.notify_on_reset && s.show_pet && s.pet_snap_edge);
        assert!(!s.show_usage_stats);
        assert!(s.account_prefs.is_empty());
    }

    #[test]
    fn sanitize_drops_empty_prefs_and_trims_alias() {
        let mut s = AppSettings::default();
        s.account_prefs.insert("a".into(), AccountPref { alias: Some("  ".into()), ..Default::default() });
        s.account_prefs.insert("b".into(), AccountPref { alias: Some(" Kai ".into()), ..Default::default() });
        sanitize(&mut s);
        assert!(!s.account_prefs.contains_key("a"));
        assert_eq!(s.account_prefs["b"].alias.as_deref(), Some("Kai"));
    }

    #[test]
    fn sanitize_clamps_and_validates_all_fields() {
        let mut s = AppSettings {
            pet_size: 10,
            sleeping_threshold: 95,
            working_threshold: 10,
            refresh_interval_secs: 5,
            ui_scale: 200,
            appearance: "neon".into(),
            usage_display: "percent".into(),
            reset_format: "epoch".into(),
            language: "fr".into(),
            pace_tick: "always".into(),
            quiet_start_min: 1500,
            quiet_end_min: 2000,
            pet_anim_speed: "turbo".into(),
            pet_opacity: 5,
            pet_click_action: "triple".into(),
            panel_position: "floating".into(),
            panel_layout: "grid".into(),
            panel_theme: "vaporwave".into(),
            panel_opacity: 10,
            panel_width: Some(120),
            panel_height: Some(2500),
            hotkey: "  Ctrl+Alt+K  ".into(),
            claude_min_interval_secs: 10,
            mobile_port: 80,
            tray_style: "rainbow".into(),
            account_order: vec!["a".into(), "b".into(), "a".into()],
            ..Default::default()
        };
        s.account_prefs.insert(
            "x".into(),
            AccountPref {
                alias: Some("x".repeat(60)),
                notify_threshold: Some(0),
                avatar: Some("https://evil.invalid/x.png".into()),
                ..Default::default()
            },
        );
        sanitize(&mut s);
        assert_eq!(s.pet_size, 48);
        assert_eq!(s.sleeping_threshold, 90);
        assert_eq!(s.working_threshold, 91);
        assert_eq!(s.refresh_interval_secs, 30);
        assert_eq!(s.ui_scale, 125);
        assert_eq!(s.appearance, "system");
        assert_eq!(s.usage_display, "used");
        assert_eq!(s.reset_format, "absolute");
        assert_eq!(s.language, "system");
        assert_eq!(s.pace_tick, "ahead");
        assert_eq!(s.quiet_start_min, 60);
        assert_eq!(s.quiet_end_min, 560);
        assert_eq!(s.pet_anim_speed, "normal");
        assert_eq!(s.pet_opacity, 30);
        assert_eq!(s.pet_click_action, "single");
        assert_eq!(s.panel_position, "pet");
        assert_eq!(s.panel_layout, "classic");
        assert_eq!(s.panel_theme, "glass");
        assert_eq!(s.panel_opacity, 45);
        assert_eq!(s.panel_width, Some(320));
        assert_eq!(s.panel_height, Some(1080));
        assert_eq!(s.hotkey, "Ctrl+Alt+K");
        assert_eq!(s.claude_min_interval_secs, 60);
        assert_eq!(s.mobile_port, 8765);
        assert_eq!(s.tray_style, "number");
        assert_eq!(s.account_order, vec!["a", "b"]);
        assert_eq!(s.account_prefs["x"].alias.as_ref().unwrap().chars().count(), 40);
        assert_eq!(s.account_prefs["x"].notify_threshold, Some(1));
        assert!(s.account_prefs["x"].avatar.is_none());
    }

    #[test]
    fn removed_muse_theme_falls_back_to_hud_gauge_without_losing_settings() {
        use crate::models::PetTheme;

        let raw = r#"{"petSize":80,"workingThreshold":65,"sleepingThreshold":15,"scoreMode":"all_avg",
            "refreshIntervalSecs":180,"notifyEnabled":false,"showAntigravityExtra":true,
            "launchAtStartup":false,"petX":100,"petY":200,"petTheme":"desk_cat","language":"en"}"#;
        let mut parsed: AppSettings = serde_json::from_str(raw).unwrap();
        sanitize(&mut parsed);
        assert_eq!(parsed.pet_theme, PetTheme::HudGauge);
        assert_eq!(parsed.pet_size, 80);
        assert_eq!(parsed.language, "en");
        assert_eq!(parsed.pet_x, Some(100));

        let muse_raw = raw.replace("\"desk_cat\"", "\"muse\"");
        let muse_parsed: AppSettings = serde_json::from_str(&muse_raw).unwrap();
        assert_eq!(muse_parsed.pet_theme, PetTheme::HudGauge);

        let null_raw = raw.replace("\"desk_cat\"", "null");
        let null_parsed: AppSettings = serde_json::from_str(&null_raw).unwrap();
        assert_eq!(null_parsed.pet_theme, PetTheme::HudGauge);

        let custom_raw = raw.replace("\"desk_cat\"", "\"custom\"");
        let custom_parsed: AppSettings = serde_json::from_str(&custom_raw).unwrap();
        assert_eq!(custom_parsed.pet_theme, PetTheme::Custom);
    }
}
