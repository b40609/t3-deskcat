//! Notification bookkeeping that must survive restarts / redeploys:
//!
//! * which accounts were already warned (low / empty), so a restart doesn't
//!   repeat the same alert;
//! * windows waiting for their reset, so "已重設" still fires after a restart;
//! * alerts raised during quiet hours, sent as one summary when they end.
//!
//! Persisted to `%APPDATA%\t3-deskcat\notify_state.json`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const BACKLOG_MAX: usize = 30;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NotifyState {
    pub low_notified: HashMap<String, bool>,
    pub zero_notified: HashMap<String, bool>,
    pub prev_effective: HashMap<String, i32>,
    /// key "id|label" -> (reset_at, account id, window label)
    pub pending_resets: HashMap<String, (i64, String, String)>,
    /// (title, body) raised while in quiet hours.
    pub quiet_backlog: Vec<(String, String)>,
}

fn state_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("t3-deskcat").join("notify_state.json"))
}

impl NotifyState {
    pub fn load() -> Self {
        state_path()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) {
        let Some(path) = state_path() else { return };
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(body) = serde_json::to_string(self) {
            let tmp = path.with_extension("json.tmp");
            if fs::write(&tmp, body).is_ok() {
                let _ = fs::rename(&tmp, &path);
            }
        }
    }

    /// Queue alerts raised during quiet hours (same title only once).
    pub fn defer(&mut self, items: Vec<(String, String)>) {
        for (title, body) in items {
            self.quiet_backlog.retain(|(t, _)| *t != title);
            self.quiet_backlog.push((title, body));
        }
        let extra = self.quiet_backlog.len().saturating_sub(BACKLOG_MAX);
        self.quiet_backlog.drain(..extra);
    }

    /// One summary notification for everything queued during quiet hours.
    pub fn take_backlog_summary(&mut self) -> Option<(String, String)> {
        if self.quiet_backlog.is_empty() {
            return None;
        }
        let items = std::mem::take(&mut self.quiet_backlog);
        if items.len() == 1 {
            let (t, b) = items.into_iter().next().unwrap();
            return Some((crate::tr!("🌙 勿擾期間：{t}", t = t), b));
        }
        let mut body = String::new();
        for (i, (t, _)) in items.iter().enumerate() {
            let line = strip_emoji_prefix(t);
            if body.chars().count() + line.chars().count() > 180 {
                body.push_str(&crate::tr!("…等 {n} 則", n = items.len()));
                break;
            }
            if i > 0 {
                body.push('\n');
            }
            body.push_str(line);
        }
        Some((crate::tr!("🌙 勿擾期間有 {n} 則通知", n = items.len()), body))
    }
}

/// "✨ Kai_ 的 5 小時限制已重設" -> "Kai_ 的 5 小時限制已重設"
fn strip_emoji_prefix(s: &str) -> &str {
    match s.split_once(' ') {
        Some((head, rest)) if !head.chars().any(|c| c.is_alphanumeric()) => rest,
        _ => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backlog_dedupes_and_summarises() {
        let mut n = NotifyState::default();
        n.defer(vec![("✨ A 已重設".into(), "x".into()), ("⚠️ B 額度偏低".into(), "y".into())]);
        n.defer(vec![("✨ A 已重設".into(), "x2".into())]);
        assert_eq!(n.quiet_backlog.len(), 2);
        let (title, body) = n.take_backlog_summary().unwrap();
        assert_eq!(title, "🌙 勿擾期間有 2 則通知");
        assert_eq!(body, "B 額度偏低\nA 已重設");
        assert!(n.take_backlog_summary().is_none());
    }

    #[test]
    fn single_backlog_item_keeps_its_body() {
        let mut n = NotifyState::default();
        n.defer(vec![("✨ A 已重設".into(), "可以用了".into())]);
        assert_eq!(
            n.take_backlog_summary(),
            Some(("🌙 勿擾期間：✨ A 已重設".to_string(), "可以用了".to_string()))
        );
    }

    #[test]
    fn old_file_without_backlog_still_loads() {
        let n: NotifyState = serde_json::from_str(r#"{"pending_resets":{"a|5h":[10,"a","5h"]}}"#).unwrap();
        assert_eq!(n.pending_resets["a|5h"].0, 10);
        assert!(n.quiet_backlog.is_empty());
    }
}
