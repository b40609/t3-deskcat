//! 24-hour usage history per account, for the sparkline in the panel.
//!
//! One sample (timestamp, effective remaining %) at most every 5 minutes per
//! account; within that bucket the value is updated in place. Persisted to
//! `%APPDATA%\t3-deskcat\history.json`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const BUCKET_SECS: i64 = 300;
const KEEP_SECS: i64 = 24 * 3600;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct History {
    pub samples: HashMap<String, Vec<(i64, i32)>>,
}

fn history_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("t3-deskcat").join("history.json"))
}

impl History {
    pub fn load() -> Self {
        history_path()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) {
        let Some(path) = history_path() else { return };
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

    pub fn record(&mut self, id: &str, ts: i64, value: i32) {
        let series = self.samples.entry(id.to_string()).or_default();
        match series.last_mut() {
            // Same 5-minute bucket: keep the timestamp, update the value.
            Some(last) if ts - last.0 < BUCKET_SECS => last.1 = value,
            _ => series.push((ts, value)),
        }
        series.retain(|(t, _)| ts - *t <= KEEP_SECS);
    }

    pub fn prune(&mut self, now: i64) {
        for series in self.samples.values_mut() {
            series.retain(|(t, _)| now - *t <= KEEP_SECS);
        }
        self.samples.retain(|_, s| !s.is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_and_prunes() {
        let mut h = History::default();
        h.record("a", 0, 90);
        h.record("a", 120, 80); // same bucket -> updated
        h.record("a", 240, 70);
        assert_eq!(h.samples["a"], vec![(0, 70)]);
        h.record("a", 360, 60); // new bucket
        assert_eq!(h.samples["a"].len(), 2);
        h.record("a", 361 + KEEP_SECS, 50); // first two fall out of 24h
        assert_eq!(h.samples["a"], vec![(361 + KEEP_SECS, 50)]);
    }
}
