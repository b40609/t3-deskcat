//! UI language for the native side (notifications, tray menu, tooltip, error
//! messages). Uses the same locale files as the panel: the Traditional Chinese
//! text is the key, `{name}` placeholders are filled by the `tr!` macro.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

static EN: &str = include_str!("../../src/locales/en.json");
static ZH_CN: &str = include_str!("../../src/locales/zh-CN.json");
static JA: &str = include_str!("../../src/locales/ja.json");
static KO: &str = include_str!("../../src/locales/ko.json");

type Dict = HashMap<String, String>;

fn dicts() -> &'static HashMap<&'static str, Dict> {
    static D: OnceLock<HashMap<&'static str, Dict>> = OnceLock::new();
    D.get_or_init(|| {
        let parse = |s: &str| serde_json::from_str::<Dict>(s).unwrap_or_default();
        HashMap::from([("en", parse(EN)), ("zh-CN", parse(ZH_CN)), ("ja", parse(JA)), ("ko", parse(KO))])
    })
}

fn lang_cell() -> &'static RwLock<&'static str> {
    static L: OnceLock<RwLock<&'static str>> = OnceLock::new();
    L.get_or_init(|| RwLock::new("zh-TW"))
}

/// "system" | "en" | "zh-TW" | "zh-CN" | "ja" | "ko" → the language actually used.
pub fn resolve(pref: &str) -> &'static str {
    let raw = if pref.is_empty() || pref == "system" {
        sys_locale::get_locale().unwrap_or_else(|| "en".to_string())
    } else {
        pref.to_string()
    };
    let l = raw.to_ascii_lowercase();
    if l == "zh-tw" || l == "zh-hk" || l == "zh-mo" || l.starts_with("zh-hant") {
        "zh-TW"
    } else if l.starts_with("zh") {
        "zh-CN"
    } else if l.starts_with("ja") {
        "ja"
    } else if l.starts_with("ko") {
        "ko"
    } else {
        "en"
    }
}

/// Returns true when the language changed.
pub fn set_lang(pref: &str) -> bool {
    let next = resolve(pref);
    let mut cur = lang_cell().write().unwrap_or_else(|e| e.into_inner());
    let changed = *cur != next;
    *cur = next;
    changed
}

pub fn lang() -> &'static str {
    *lang_cell().read().unwrap_or_else(|e| e.into_inner())
}

/// The translation of `src` (falls back to English, then to `src`).
pub fn lookup(src: &str) -> String {
    let l = lang();
    if l == "zh-TW" {
        return src.to_string();
    }
    let d = dicts();
    d.get(l)
        .and_then(|m| m.get(src))
        .or_else(|| if l == "zh-CN" { None } else { d.get("en").and_then(|m| m.get(src)) })
        .cloned()
        .unwrap_or_else(|| src.to_string())
}

/// `tr!("{n} 分鐘後重設", n = mins)`
#[macro_export]
macro_rules! tr {
    ($s:expr) => { $crate::i18n::lookup($s) };
    ($s:expr, $($k:ident = $v:expr),+ $(,)?) => {{
        let mut out = $crate::i18n::lookup($s);
        $( out = out.replace(concat!("{", stringify!($k), "}"), &format!("{}", $v)); )+
        out
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_files_parse_and_resolve() {
        for (k, d) in dicts() {
            assert!(d.len() > 50, "{k} has only {} entries", d.len());
        }
        assert_eq!(resolve("zh-Hant-TW"), "zh-TW");
        assert_eq!(resolve("zh-Hans"), "zh-CN");
        assert_eq!(resolve("ja-JP"), "ja");
        assert_eq!(resolve("ko"), "ko");
        assert_eq!(resolve("fr-FR"), "en");
    }

    #[test]
    fn placeholders_survive_translation() {
        // Every translation keeps the same {placeholders} as its key.
        let re = |s: &str| {
            let mut v: Vec<String> = s.split('{').skip(1).filter_map(|p| p.split_once('}').map(|x| x.0.to_string())).collect();
            v.sort();
            v
        };
        for (k, d) in dicts() {
            for (src, dst) in d {
                assert_eq!(re(src), re(dst), "{k}: {src} -> {dst}");
            }
        }
    }
}
