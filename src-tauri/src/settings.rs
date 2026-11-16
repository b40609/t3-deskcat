use crate::models::AppSettings;
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
    fs::write(&path, body).map_err(|err| format!("Failed to write settings: {err}"))
}

fn sanitize(s: &mut AppSettings) {
    s.pet_size = s.pet_size.clamp(48, 128);
    s.sleeping_threshold = s.sleeping_threshold.clamp(0, 90);
    s.working_threshold = s.working_threshold.clamp(s.sleeping_threshold + 1, 99);
    s.notify_low_threshold = s.notify_low_threshold.clamp(1, 90);
    s.refresh_interval_secs = s.refresh_interval_secs.clamp(30, 3600);
}
