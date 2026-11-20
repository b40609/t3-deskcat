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
    s.notify_low_threshold = s.notify_low_threshold.clamp(1, 90);
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
        "pet" | "top_right" | "bottom_right" | "top_left" | "bottom_left" | "center"
    ) {
        s.panel_position = "pet".to_string();
    }
    s.hotkey = s.hotkey.trim().to_string();
    s.claude_min_interval_secs = s.claude_min_interval_secs.clamp(60, 1800);
    if s.mobile_port < 1024 {
        s.mobile_port = 8765;
    }
    if !matches!(s.tray_style.as_str(), "number" | "ring" | "icon") {
        s.tray_style = "number".to_string();
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
            "refreshIntervalSecs":120,"notifyEnabled":true,"notifyLowThreshold":20,
            "showAntigravityExtra":false,"launchAtStartup":false,"petX":null,"petY":null}"#;
        let s: AppSettings = serde_json::from_str(raw).unwrap();
        assert_eq!(s.hotkey, "Ctrl+Alt+Q");
        assert_eq!(s.claude_min_interval_secs, 90);
        assert!(s.notify_on_reset && s.show_history && s.pet_snap_edge);
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
}
