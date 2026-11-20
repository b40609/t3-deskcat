//! Settings-page helpers: where each account came from, diagnostics for bug
//! reports, the phone-page QR code, and Tailscale setup detection.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

static SOURCES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// Remember where each discovered account was read from (shown in settings).
pub fn set_sources(map: HashMap<String, String>) {
    *SOURCES.lock().unwrap_or_else(|e| e.into_inner()) = Some(map);
}

/// id -> source, with the home folder shortened to `~`.
pub fn sources() -> HashMap<String, String> {
    let home = dirs::home_dir().map(|h| h.display().to_string());
    SOURCES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|(id, src)| (id, shorten_home(&src, home.as_deref())))
        .collect()
}

fn shorten_home(path: &str, home: Option<&str>) -> String {
    match home {
        Some(h) if !h.is_empty() && path.to_lowercase().starts_with(&h.to_lowercase()) => {
            format!("~{}", &path[h.len()..])
        }
        _ => path.to_string(),
    }
}

/// Phone setup progress: what the guide should show next.
#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleState {
    /// Tailscale is installed on this PC.
    pub installed: bool,
    /// This PC has a Tailscale address (installed, running and signed in).
    pub connected: bool,
}

fn tailscale_gui() -> Option<PathBuf> {
    let mut roots = Vec::new();
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Ok(p) = std::env::var(var) {
            roots.push(PathBuf::from(p));
        }
    }
    roots
        .into_iter()
        .map(|r| r.join("Tailscale").join("tailscale-ipn.exe"))
        .find(|p| p.is_file())
}

pub fn tailscale_state() -> TailscaleState {
    let connected = crate::mobile::tailscale_ip().is_some();
    TailscaleState {
        installed: connected || tailscale_gui().is_some(),
        connected,
    }
}

/// Open one of a fixed set of targets. Nothing caller-supplied is executed.
pub fn open_target(target: &str) -> Result<(), String> {
    let arg: String = match target {
        "logs" => crate::logging::log_path()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .ok_or("找不到記錄檔資料夾")?
            .display()
            .to_string(),
        "tailscale-download" => "https://tailscale.com/download/windows".into(),
        "tailscale-app" => tailscale_gui().ok_or("找不到 Tailscale")?.display().to_string(),
        _ => return Err("unknown target".into()),
    };
    let mut cmd = if target == "tailscale-app" {
        std::process::Command::new(&arg)
    } else {
        let mut c = std::process::Command::new("explorer");
        c.arg(&arg);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// QR code for a URL, as an SVG string drawn in `currentColor`-free black on white.
pub fn qr_svg(text: &str) -> Result<String, String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::new(text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(code
        .render::<svg::Color>()
        .min_dimensions(168, 168)
        .quiet_zone(true)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

/// Plain-text report for bug reports. Holds no tokens: only ids, statuses,
/// credential file locations and the tail of the log.
pub fn diagnostics(snapshot: Option<&crate::models::DashboardSnapshot>, mobile: &str) -> String {
    let mut out = vec![
        format!("T3 DeskCat {}", env!("CARGO_PKG_VERSION")),
        format!("OS: {} {}", std::env::consts::OS, std::env::consts::ARCH),
        format!("Phone page: {mobile}"),
    ];
    let ts = tailscale_state();
    out.push(format!("Tailscale: installed={} connected={}", ts.installed, ts.connected));
    let src = sources();
    out.push(String::new());
    match snapshot {
        Some(s) => {
            out.push(format!("Accounts ({}):", s.accounts.len()));
            for a in &s.accounts {
                out.push(format!(
                    "  {} [{}] status={}{} <- {}",
                    a.id,
                    a.plan.clone().unwrap_or_default(),
                    a.status,
                    a.error.as_ref().map(|e| format!(" ({e})")).unwrap_or_default(),
                    src.get(&a.id).cloned().unwrap_or_else(|| "?".into())
                ));
            }
            let dirs = &s.settings.extra_account_dirs;
            if !dirs.is_empty() {
                out.push(format!("Extra folders: {}", dirs.join("; ")));
            }
        }
        None => out.push("Accounts: no snapshot yet".into()),
    }
    if let Some(log) = crate::logging::log_path().and_then(|p| std::fs::read_to_string(p).ok()) {
        let lines: Vec<&str> = log.lines().collect();
        out.push(String::new());
        out.push("Log (last 40 lines):".into());
        out.extend(lines[lines.len().saturating_sub(40)..].iter().map(|l| l.to_string()));
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_is_shortened_case_insensitively() {
        assert_eq!(
            shorten_home(r"C:\Users\Me\.claude\.credentials.json", Some(r"c:\users\me")),
            r"~\.claude\.credentials.json"
        );
        assert_eq!(shorten_home("/opt/x", Some("/home/me")), "/opt/x");
    }

    #[test]
    fn qr_renders_svg() {
        let svg = qr_svg("http://100.64.0.1:8765").unwrap();
        assert!(svg.contains("<svg"));
    }
}
