import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";

/**
 * UI languages. The Traditional Chinese text is the key; each locale file maps
 * it to a translation ("{name}" placeholders are filled by t()). A missing entry
 * falls back to English, then to the key itself. The Rust side reads the same
 * files for notifications, the tray menu and error messages.
 */

export type Lang = "zh-TW" | "zh-CN" | "en" | "ja" | "ko";
export type LangPref = Lang | "system";

/** Shown in each language's own name, so anyone can find theirs. */
export const LANGUAGES: { value: LangPref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "en", label: "English" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "zh-CN", label: "简体中文" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
];

const DICTS: Record<Lang, Record<string, string> | null> = {
  "zh-TW": null,
  "zh-CN": zhCN,
  en,
  ja,
  ko,
};

const LOCALES: Record<Lang, string> = { "zh-TW": "zh-TW", "zh-CN": "zh-CN", en: "en-US", ja: "ja-JP", ko: "ko-KR" };

export function resolveLang(pref?: string | null): Lang {
  const raw = !pref || pref === "system" ? navigator.language || "en" : pref;
  const l = raw.toLowerCase();
  if (l === "zh-tw" || l === "zh-hk" || l === "zh-mo" || l.startsWith("zh-hant")) return "zh-TW";
  if (l.startsWith("zh")) return "zh-CN";
  if (l.startsWith("ja")) return "ja";
  if (l.startsWith("ko")) return "ko";
  return "en";
}

let lang: Lang = resolveLang("system");

export function setLang(pref?: string | null): boolean {
  const next = resolveLang(pref);
  const changed = next !== lang;
  lang = next;
  document.documentElement.lang = LOCALES[lang];
  return changed;
}

export function getLang(): Lang {
  return lang;
}

/** BCP 47 tag for Intl date and number formatting. */
export function locale(): string {
  return LOCALES[lang];
}

export function t(src: string, vars?: Record<string, string | number>): string {
  const dict = DICTS[lang];
  let s = dict ? (dict[src] ?? (lang === "zh-CN" ? src : en[src as keyof typeof en] ?? src)) : src;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Translate the static markup: `data-i18n` (text) and `data-i18n-attr="title,…"`. */
export function applyI18n(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    if (el.dataset.i18nSrc == null) el.dataset.i18nSrc = el.textContent?.trim() ?? "";
    el.textContent = t(el.dataset.i18nSrc);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-attr]").forEach((el) => {
    for (const a of el.dataset.i18nAttr!.split(",")) {
      const key = `i18nSrc${a.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase())}`;
      if (el.dataset[key] == null) el.dataset[key] = el.getAttribute(a) ?? "";
      el.setAttribute(a, t(el.dataset[key]!));
    }
  });
}

/** Short weekday in the UI language ("週四", "Thu", "木", "목"). */
export function weekday(d: Date): string {
  return d.toLocaleDateString(locale(), { weekday: "short" });
}
