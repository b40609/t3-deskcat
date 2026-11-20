//! Quota page for the phone, reachable only over Tailscale.
//!
//! The server binds to this PC's Tailscale address (100.64.0.0/10) only, so it
//! is invisible on the LAN / internet; only devices on your tailnet can open it.
//! It never serves credentials.
//!
//! The phone gets the same panel and analytics pages as the desktop (the built
//! frontend assets), talking back through `POST /api/invoke/<command>`; only the
//! commands `remote_invoke` in lib.rs allows are answered.
//!
//! Routes: `/` (panel), `/analytics.html`, `/assets/*`, `/api/invoke/<cmd>`,
//! `/api/snapshot` (compact JSON, kept for older home-screen shortcuts),
//! `/manifest.webmanifest`, `/icon.png`.

use crate::models::{AppSettings, DashboardSnapshot, Forecast, QuotaWindow, SmartPick};
use crate::usage_stats::UsageToday;
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Fallback page when the built panel is not embedded (dev builds).
const PAGE: &str = include_str!("mobile.html");
const MAX_BODY: usize = 12 * 1024 * 1024;

/// What the server needs from the app.
pub struct Remote {
    pub snapshot: Box<dyn Fn() -> Option<DashboardSnapshot> + Send + Sync>,
    /// Embedded frontend file by path ("panel.html", "assets/x.js") -> (bytes, mime).
    pub asset: Box<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>,
    /// Runs an allowed command: Ok(json) or Err((http status, message)).
    pub invoke: Box<
        dyn Fn(String, serde_json::Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<serde_json::Value, (u16, String)>> + Send>>
            + Send
            + Sync,
    >,
}
const ICON: &[u8] = include_bytes!("../icons/touch-icon.png");

/// This PC's Tailscale IPv4 (CGNAT range 100.64.0.0/10), if Tailscale is up.
pub fn tailscale_ip() -> Option<Ipv4Addr> {
    if_addrs::get_if_addrs().ok()?.into_iter().find_map(|i| match i.ip() {
        IpAddr::V4(v4) if is_tailscale(v4) => Some(v4),
        _ => None,
    })
}

fn is_tailscale(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (64..128).contains(&o[1])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileWindow {
    label: String,
    remaining_percent: i32,
    reset_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileAccount {
    id: String,
    provider: crate::models::ProviderKind,
    name: String,
    plan: Option<String>,
    status: String,
    error: Option<String>,
    updated_at: i64,
    windows: Vec<MobileWindow>,
    /// Secondary pools (Antigravity Argon / 3P), always sent for the detail view.
    extra_windows: Vec<MobileWindow>,
    forecast: Option<Forecast>,
    usage: Option<UsageToday>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileView {
    updated_at: i64,
    offline: bool,
    overall_score: i32,
    usage_display: String,
    reset_format: String,
    refresh_interval_secs: u64,
    working_threshold: i32,
    sleeping_threshold: i32,
    picks: Vec<SmartPick>,
    accounts: Vec<MobileAccount>,
    total_cost_usd: Option<f64>,
    hidden: usize,
    /// Custom avatars by account id (picks reference accounts by id).
    avatars: std::collections::HashMap<String, String>,
}

fn win(w: &QuotaWindow) -> MobileWindow {
    MobileWindow { label: w.label.clone(), remaining_percent: w.remaining_percent, reset_at: w.reset_at }
}

/// Snapshot as the phone should see it: hidden accounts dropped, aliases and
/// the user's order applied, display options respected. No settings blob.
fn view(snap: &DashboardSnapshot) -> MobileView {
    let s: &AppSettings = &snap.settings;
    let rank = |id: &str, i: usize| {
        s.account_order.iter().position(|x| x == id).unwrap_or(s.account_order.len() + i)
    };
    let mut accs: Vec<(usize, &crate::models::AccountQuota)> = snap
        .accounts
        .iter()
        .enumerate()
        .filter(|(_, a)| !s.is_hidden(&a.id))
        .map(|(i, a)| (rank(&a.id, i), a))
        .collect();
    accs.sort_by_key(|(r, _)| *r);
    let hidden = snap.accounts.len() - accs.len();

    let accounts: Vec<MobileAccount> = accs
        .into_iter()
        .map(|(_, a)| {
            let windows: Vec<MobileWindow> = a.primary_windows.iter().map(win).collect();
            let extra_windows: Vec<MobileWindow> = a.extra_windows.iter().map(win).collect();
            MobileAccount {
                id: a.id.clone(),
                provider: a.provider,
                name: s.display_name(a),
                plan: a.plan.clone(),
                status: a.status.clone(),
                error: a.error.clone(),
                updated_at: a.updated_at,
                windows,
                extra_windows,
                forecast: s.show_forecast.then(|| snap.forecasts.get(&a.id).cloned()).flatten(),
                usage: s.show_usage_stats.then(|| snap.usage_today.get(&a.id).cloned()).flatten(),
            }
        })
        .collect();

    let total_cost_usd = s.show_usage_stats.then(|| {
        accounts.iter().filter_map(|a| a.usage.as_ref()?.cost_usd).sum::<f64>()
    });

    MobileView {
        updated_at: snap.last_refreshed_at,
        offline: snap.offline,
        overall_score: snap.overall_score,
        usage_display: s.usage_display.clone(),
        reset_format: s.reset_format.clone(),
        refresh_interval_secs: s.refresh_interval_secs,
        working_threshold: s.working_threshold,
        sleeping_threshold: s.sleeping_threshold,
        picks: if s.show_picks { snap.picks.clone() } else { Vec::new() },
        accounts,
        total_cost_usd,
        hidden,
        avatars: s
            .account_prefs
            .iter()
            .filter(|(id, _)| !s.is_hidden(id))
            .filter_map(|(id, p)| Some((id.clone(), p.avatar.clone()?)))
            .collect(),
    }
}

const MANIFEST: &str = r##"{"name":"T3 DeskCat","short_name":"額度","start_url":"/","display":"standalone","background_color":"#f3f3f3","theme_color":"#f3f3f3","icons":[{"src":"/icon.png","sizes":"256x256","type":"image/png"}]}"##;

async fn respond(stream: &mut TcpStream, status: &str, ctype: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.shutdown().await;
}

async fn handle(mut stream: TcpStream, remote: std::sync::Arc<Remote>) {
    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    let mut chunk = vec![0u8; 16384];
    let mut head_end = None;
    // Read the request head.
    while head_end.is_none() && buf.len() < 16384 {
        match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk)).await {
            Ok(Ok(0)) | Err(_) | Ok(Err(_)) => break,
            Ok(Ok(k)) => {
                buf.extend_from_slice(&chunk[..k]);
                head_end = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4);
            }
        }
    }
    let Some(head_end) = head_end else { return };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut parts = head.split_whitespace();
    let (method, target) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
    let path = target.split('?').next().unwrap_or("").to_string();

    if method == "POST" {
        let Some(cmd) = path.strip_prefix("/api/invoke/") else {
            return respond(&mut stream, "404 Not Found", "text/plain", b"not found").await;
        };
        let len: usize = head
            .lines()
            .find_map(|l| {
                let (k, v) = l.split_once(':')?;
                k.trim().eq_ignore_ascii_case("content-length").then(|| v.trim().parse().ok())?
            })
            .unwrap_or(0);
        if len > MAX_BODY {
            return respond(&mut stream, "413 Payload Too Large", "text/plain", b"too large").await;
        }
        let mut body = buf[head_end..].to_vec();
        while body.len() < len {
            match tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk)).await {
                Ok(Ok(0)) | Err(_) | Ok(Err(_)) => break,
                Ok(Ok(k)) => body.extend_from_slice(&chunk[..k]),
            }
        }
        let args: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
        return match (remote.invoke)(cmd.to_string(), args).await {
            Ok(v) => {
                let out = serde_json::to_vec(&v).unwrap_or_default();
                respond(&mut stream, "200 OK", "application/json; charset=utf-8", &out).await
            }
            Err((code, msg)) => {
                let status = match code {
                    403 => "403 Forbidden",
                    400 => "400 Bad Request",
                    503 => "503 Service Unavailable",
                    _ => "500 Internal Server Error",
                };
                respond(&mut stream, status, "text/plain; charset=utf-8", msg.as_bytes()).await
            }
        };
    }
    if method != "GET" {
        return respond(&mut stream, "405 Method Not Allowed", "text/plain", b"GET or POST").await;
    }
    match path.as_str() {
        "/" | "/index.html" | "/panel.html" => match (remote.asset)("panel.html") {
            Some((b, mime)) => respond(&mut stream, "200 OK", &mime, &b).await,
            None => respond(&mut stream, "200 OK", "text/html; charset=utf-8", PAGE.as_bytes()).await,
        },
        "/api/snapshot" => match (remote.snapshot)() {
            Some(snap) => {
                let body = serde_json::to_vec(&view(&snap)).unwrap_or_default();
                respond(&mut stream, "200 OK", "application/json; charset=utf-8", &body).await
            }
            None => respond(&mut stream, "503 Service Unavailable", "application/json", b"{\"loading\":true}").await,
        },
        "/manifest.webmanifest" => {
            respond(&mut stream, "200 OK", "application/manifest+json", MANIFEST.as_bytes()).await
        }
        "/icon.png" | "/apple-touch-icon.png" => respond(&mut stream, "200 OK", "image/png", ICON).await,
        p if p == "/analytics.html" || p.starts_with("/assets/") => {
            let rel = p.trim_start_matches('/');
            if rel.contains("..") {
                return respond(&mut stream, "404 Not Found", "text/plain", b"not found").await;
            }
            match (remote.asset)(rel) {
                Some((b, mime)) => respond(&mut stream, "200 OK", &mime, &b).await,
                None => respond(&mut stream, "404 Not Found", "text/plain", b"not found").await,
            }
        }
        _ => respond(&mut stream, "404 Not Found", "text/plain", b"not found").await,
    }
}

/// Serve until the listener fails.
pub async fn serve(addr: SocketAddr, remote: std::sync::Arc<Remote>) -> std::io::Result<()> {
    let listener = TcpListener::bind(addr).await?;
    loop {
        let (stream, peer) = listener.accept().await?;
        // Defence in depth: only tailnet peers (the bind address already ensures this).
        if !matches!(peer.ip(), IpAddr::V4(v4) if is_tailscale(v4)) {
            continue;
        }
        let r = remote.clone();
        tokio::spawn(async move { handle(stream, r).await });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AccountPref, AccountQuota, CatMood, ProviderKind};
    use std::collections::HashMap;

    fn acc(id: &str, name: &str) -> AccountQuota {
        AccountQuota {
            id: id.into(),
            provider: ProviderKind::Claude,
            name: name.into(),
            plan: None,
            effective_remaining: 50,
            primary_windows: vec![QuotaWindow { label: "5h".into(), remaining_percent: 50, reset_at: None }],
            extra_windows: vec![QuotaWindow { label: "Argon 5h".into(), remaining_percent: 10, reset_at: None }],
            status: "ok".into(),
            error: None,
            updated_at: 0,
        }
    }

    #[test]
    fn tailscale_range() {
        assert!(is_tailscale(Ipv4Addr::new(100, 99, 191, 41)));
        assert!(!is_tailscale(Ipv4Addr::new(100, 128, 0, 1)));
        assert!(!is_tailscale(Ipv4Addr::new(192, 168, 50, 80)));
    }

    #[test]
    fn view_applies_hidden_alias_order_and_drops_settings() {
        let mut s = AppSettings::default();
        s.account_prefs.insert("b".into(), AccountPref { alias: Some("Work".into()), ..Default::default() });
        s.account_prefs.insert("c".into(), AccountPref { hidden: true, ..Default::default() });
        s.account_order = vec!["b".into(), "a".into()];
        s.custom_image_working = Some("data:image/png;base64,AAAA".into());
        let snap = DashboardSnapshot {
            accounts: vec![acc("a", "A"), acc("b", "B"), acc("c", "C")],
            picks: vec![],
            overall_score: 50,
            mood: CatMood::Working,
            tooltip_text: String::new(),
            last_refreshed_at: 7,
            settings: s,
            offline: false,
            forecasts: HashMap::new(),
            usage_today: HashMap::new(),
            burn_rates: HashMap::new(),
        };
        let v = view(&snap);
        let names: Vec<&str> = v.accounts.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["Work", "A"]);
        assert_eq!(v.hidden, 1);
        assert_eq!(v.accounts[0].windows.len(), 1);
        assert_eq!(v.accounts[0].extra_windows.len(), 1);
        let json = serde_json::to_string(&v).unwrap();
        assert!(!json.contains("base64"));
    }
}
