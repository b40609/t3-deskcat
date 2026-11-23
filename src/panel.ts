import { mainWindows } from "./focus";
import { applyI18n, LANGUAGES, locale, setLang, t, weekday } from "./i18n";
import { call as invoke, isRemote, subscribe } from "./bridge";
import { createAnalyticsView } from "./analyticsView";
import { getVersion } from "@tauri-apps/api/app";
import type {
  AccountPref,
  AccountQuota,
  AppSettings,
  DashboardSnapshot,
  Forecast,
  PanelPosition,
  PetTheme,
  ProviderKind,
  UsageToday,
} from "./types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const shell = $("app");
const picksSection = $("picks-section");
const accountsSection = $("accounts-section");
const accountsAlert = $("accounts-alert");
const dashTabs = $("dash-tabs");
const dashQuota = $("dash-quota");
const dashAnalytics = $("dash-analytics");

const btnRefresh = $("btn-refresh");
const btnPin = $("btn-pin");
const btnSettings = $("btn-settings");
const btnBack = $("btn-back");

const themeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".theme-btn"));
const customCard = $("custom-images-card");
const prevSlotWorking = $("prev-slot-working");
const prevSlotSweating = $("prev-slot-sweating");
const prevSlotSleeping = $("prev-slot-sleeping");
const fileWorking = $<HTMLInputElement>("file-working");
const fileSweating = $<HTMLInputElement>("file-sweating");
const fileSleeping = $<HTMLInputElement>("file-sleeping");
const btnClearCustom = $("btn-clear-custom");

const inpPetSize = $<HTMLInputElement>("inp-pet-size");
const valPetSize = $("val-pet-size");
const inpWorkTh = $<HTMLInputElement>("inp-work-th");
const valWorkTh = $("val-work-th");
const inpSleepTh = $<HTMLInputElement>("inp-sleep-th");
const valSleepTh = $("val-sleep-th");
const valSweatRange = $("val-sweat-range");
const inpNotify = $<HTMLInputElement>("inp-notify");
const inpAutostart = $<HTMLInputElement>("inp-autostart");
const inpShowPicks = $<HTMLInputElement>("inp-show-picks");
const inpShowPet = $<HTMLInputElement>("inp-show-pet");
const petOptions = $("pet-options");
const rowPetEffects = $("row-pet-effects");
const inpPetEffects = $<HTMLInputElement>("inp-pet-effects");
const segControls = Array.from(document.querySelectorAll<HTMLElement>(".segmented[data-key]"));
const segAccDetail = $("seg-acc-detail");
const accDetailHint = $("acc-detail-hint");
const inpPetOpacity = $<HTMLInputElement>("inp-pet-opacity");
const valPetOpacity = $("val-pet-opacity");
const inpPetIdleFade = $<HTMLInputElement>("inp-pet-idle-fade");
const inpShowForecast = $<HTMLInputElement>("inp-show-forecast");
const inpShowUsage = $<HTMLInputElement>("inp-show-usage");
const offlineNote = $("offline-note");
const inpMobile = $<HTMLInputElement>("inp-mobile");
const btnMobileUrl = $<HTMLButtonElement>("btn-mobile-url");
const mobileHint = $("mobile-hint");
const mobileHintText = () => t("只透過 Tailscale 連線，區網與網際網路都看不到");
const selPanelPos = $<HTMLSelectElement>("sel-panel-pos");
const btnHotkey = $<HTMLButtonElement>("btn-hotkey");
const btnHotkeyClear = $<HTMLButtonElement>("btn-hotkey-clear");
const hotkeyHint = $("hotkey-hint");
const accSettingsEl = $("acc-settings");
const inpNotifyReset = $<HTMLInputElement>("inp-notify-reset");
const inpQuiet = $<HTMLInputElement>("inp-quiet");
const rowQuietTimes = $("row-quiet-times");
const inpQuietStart = $<HTMLInputElement>("inp-quiet-start");
const inpQuietEnd = $<HTMLInputElement>("inp-quiet-end");

let currentSnapshot: DashboardSnapshot | null = null;
let currentSettings: AppSettings | null = null;
let showingSettings = false;
let activeDashTab: "quota" | "analytics" = "quota";
let refreshing = false;
let pinned = false;
let expandedAcc: string | null = null;
let accSettingsSig = "";
let recordingHotkey = false;
const hotkeyHintText = () => t("點快捷鍵後按下新的組合鍵，Esc 取消、Backspace 清除");

const fallbackSettings: AppSettings = {
  petSize: 64,
  workingThreshold: 70,
  sleepingThreshold: 20,
  scoreMode: "max_avg",
  refreshIntervalSecs: 120,
  notifyEnabled: true,
  showAntigravityExtra: false,
  launchAtStartup: false,
  showPet: true,
  petX: null,
  petY: null,
  petTheme: "desk_cat",
  uiScale: 90,
  appearance: "system",
  usageDisplay: "used",
  resetFormat: "absolute",
  paceTick: "ahead",
  showPicks: true,
  petEffects: true,
  accountPrefs: {},
  accountOrder: [],
  notifyOnReset: true,
  quietHoursEnabled: false,
  quietStartMin: 23 * 60,
  quietEndMin: 9 * 60,
  petAnimSpeed: "normal",
  petOpacity: 100,
  petIdleFade: false,
  petClickAction: "single",
  petSnapEdge: true,
  panelPosition: "pet",
  hotkey: "Ctrl+Alt+Q",
  compactAccounts: false,
  claudeMinIntervalSecs: 90,
  showForecast: true,
  showUsageStats: false,
  trayStyle: "number",
};

const cfg = () => currentSettings ?? fallbackSettings;

function prefOf(id: string): AccountPref {
  return cfg().accountPrefs?.[id] ?? {};
}

function displayName(acc: AccountQuota): string {
  return prefOf(acc.id).alias?.trim() || acc.name;
}

/** Accounts in the user's chosen order (unknown ids keep discovery order, at the end). */
function orderedAccounts(accounts: AccountQuota[]): AccountQuota[] {
  const order = cfg().accountOrder ?? [];
  const rank = (a: AccountQuota, i: number) => {
    const r = order.indexOf(a.id);
    return r < 0 ? order.length + i : r;
  };
  return accounts
    .map((a, i) => ({ a, r: rank(a, i) }))
    .sort((x, y) => x.r - y.r)
    .map((x) => x.a);
}

function visibleAccounts(accounts: AccountQuota[]): AccountQuota[] {
  return orderedAccounts(accounts).filter((a) => !prefOf(a.id).hidden);
}

// ------------------------------------------------------------------ helpers

const PROVIDERS: { kind: ProviderKind; label: string; color: string }[] = [
  { kind: "claude", label: "Claude", color: "var(--claude)" },
  { kind: "antigravity", label: "Antigravity", color: "var(--ag)" },
  { kind: "codex", label: "ChatGPT", color: "var(--codex)" },
];

function providerLabel(p: ProviderKind): string {
  return PROVIDERS.find((x) => x.kind === p)?.label ?? p;
}

/** Custom avatar if set, else the provider letter tile. */
function avatarHtml(id: string, provider: ProviderKind): string {
  const av = cfg().accountPrefs?.[id]?.avatar;
  if (av && av.startsWith("data:image/")) {
    return `<span class="p-icon has-img"><img src="${escapeHtml(av)}" alt="" /></span>`;
  }
  return `<span class="p-icon ${provider}"><svg><use href="#m-${provider}" /></svg></span>`;
}

/** Downscale a picked image to a 96px square JPEG/PNG data URL. */
function loadAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const S = 96;
      const c = document.createElement("canvas");
      c.width = c.height = S;
      const g = c.getContext("2d")!;
      const side = Math.min(img.width, img.height);
      g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(t("無法讀取圖片")));
    };
    img.src = url;
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Bar color for a remaining %: above the notice line, between, or under the danger line (per-account override). */
function getTone(pct: number, accId?: string): "good" | "warn" | "bad" {
  const s = currentSettings ?? fallbackSettings;
  const danger = (accId && s.accountPrefs?.[accId]?.notifyThreshold) || s.sleepingThreshold;
  if (pct < danger) return "bad";
  if (pct > s.workingThreshold) return "good";
  if (pct >= danger) return "warn";
  return "bad";
}


/** Claude-style reset text: "於 下午7:00 重設" / "週六上午2:00 重設", or a countdown. */
function formatResetAt(resetAt: number | null): string {
  if (!resetAt) return "";
  const diffSec = resetAt - Math.floor(Date.now() / 1000);
  if (diffSec <= 0) return t("即將重設");
  const fmt = (currentSettings ?? fallbackSettings).resetFormat ?? "absolute";
  if (fmt === "relative") {
    const hours = Math.floor(diffSec / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    if (hours >= 24) return t("{d} 天 {h} 小時後重設", { d: Math.floor(hours / 24), h: hours % 24 });
    if (hours > 0) return t("{h} 小時 {m} 分後重設", { h: hours, m: mins });
    return t("{m} 分鐘後重設", { m: Math.max(1, mins) });
  }
  const d = new Date(resetAt * 1000);
  const now = new Date();
  const time = d.toLocaleTimeString(locale(), { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return t("於 {time} 重設", { time });
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return t("明天{time} 重設", { time });
  if (diffSec < 6.5 * 86400) return t("{day}{time} 重設", { day: weekday(d), time });
  return t("{date} {time} 重設", { date: `${d.getMonth() + 1}/${d.getDate()}`, time });
}

/** Window label → Claude-style name ("5 小時限制", "每週 · 所有模型", "每週 · Sonnet") */
function windowName(label: string, provider: ProviderKind): string {
  const [base, ...rest] = label.split(" ");
  const pool = rest.join(" ");
  if (/^(Argon|3P)$/.test(base) && rest.length) return `${base === "3P" ? "Claude/GPT" : base} · ${windowName(pool, provider)}`;
  return pool ? `${base === "週" ? "Wk" : base} · ${pool}` : base === "週" ? "Wk" : base;
}

/** Length of a limit window in seconds, from its label ("5h", "Wk", "3P Wk"). */
function windowSeconds(label: string): number | null {
  if (/(^|\s)5h(\s|$)/.test(label)) return 5 * 3600;
  if (/(^|\s)(Wk|週)(\s|$)/.test(label)) return 7 * 86400;
  return null;
}

/** Share of the window's time already gone (0–100), or null when unknown. */
function elapsedPercent(label: string, resetAt: number | null): number | null {
  const len = windowSeconds(label);
  if (!len || !resetAt) return null;
  const left = resetAt - Date.now() / 1000;
  if (left <= 0 || left > len) return null;
  return Math.round((1 - left / len) * 100);
}

function renderWindow(
  w: { label: string; remainingPercent: number; resetAt: number | null },
  provider: ProviderKind,
  accId?: string,
) {
  const showUsed = ((currentSettings ?? fallbackSettings).usageDisplay ?? "used") === "used";
  const remaining = Math.max(0, Math.min(100, w.remainingPercent));
  const value = showUsed ? 100 - remaining : remaining;
  const tone = getTone(remaining, accId);
  const reset = formatResetAt(w.resetAt);
  const elapsed = elapsedPercent(w.label, w.resetAt);
  // The tick sits where the fill would be if usage kept pace with time,
  // shown only when usage runs ahead of elapsed time.
  const ahead = elapsed != null && 100 - remaining > elapsed;
  const pace =
    elapsed == null || !ahead
      ? ""
      : `<i class="pace" style="left:${showUsed ? elapsed : 100 - elapsed}%" title="${t("時間已過 {p}%：{hint}", { p: elapsed, hint: showUsed ? t("填色超過刻度代表用得比時間快") : t("填色短於刻度代表用得比時間快") })}"></i>`;
  return `
    <div class="win">
      <div class="win-line">
        <span class="win-name">${escapeHtml(windowName(w.label, provider))}</span>
        <span class="win-meta">${reset ? `<span class="win-reset">${reset}</span>` : ""}<span class="win-val ${tone === "good" ? "" : tone}">${value}%</span></span>
      </div>
      <div class="bar"><span class="${tone === "good" ? "" : tone}" style="width:${value}%"></span>${pace}</div>
    </div>`;
}

/** "下午4:40" today, "明天上午9:10", "週四上午10:00" later. */
function formatWhen(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const time = d.toLocaleTimeString(locale(), { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return t("明天{time}", { time });
  return `${weekday(d)} ${time}`;
}

/** Idle time between running out and the reset, in seconds (null when unknown). */
function forecastGap(f: Forecast): number | null {
  return f.resetAt ? Math.max(0, f.resetAt - f.exhaustAt) : null;
}

/** Red when you'd sit idle 2h+ (or run dry within the hour), else orange. */
function forecastLevel(f: Forecast): "bad" | "warn" {
  const gap = forecastGap(f);
  const mins = (f.exhaustAt - Date.now() / 1000) / 60;
  return (gap != null && gap >= 2 * 3600) || mins < 60 ? "bad" : "warn";
}

function fmtGap(secs: number): string {
  const m = Math.round(secs / 60);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = secs / 3600;
  return h < 10 ? `${(Math.round(h * 2) / 2).toString()}h` : `${Math.round(h)}h`;
}

/** "11:18", "明天 11:18", "週四 11:18" (24h, compact). */
function shortWhen(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const tmr = new Date(now);
  tmr.setDate(now.getDate() + 1);
  return `${d.toDateString() === tmr.toDateString() ? t("明天") : weekday(d)} ${hm}`;
}

function forecastHtml(f: Forecast | undefined, provider: ProviderKind): string {
  if (!f || cfg().showForecast === false) return "";
  const mins = Math.round((f.exhaustAt - Date.now() / 1000) / 60);
  if (mins < 0) return "";
  const name = escapeHtml(windowName(f.label, provider));
  const short = name.split(" · ")[0];
  const when = mins < 60 ? t("{m} 分鐘後", { m: Math.max(1, mins) }) : shortWhen(f.exhaustAt);
  const gap = forecastGap(f);
  const text = t("{label} 照目前速度 {when} 用完", { label: short, when }) + (gap != null ? t("，比重設早 {gap}", { gap: fmtGap(gap) }) : "");
  const tip =
    t("依近期用量推算，{name} 預計 {when} 耗盡", { name, when }) +
    (gap != null ? t("，早於重設 {gap}", { gap: fmtGap(gap) }) : "") +
    (f.resetAt ? t("；{reset}", { reset: formatResetAt(f.resetAt) }) : "") +
    t("。消耗速率 {rate}%/h", { rate: f.ratePerHour });
  return `<div class="acc-line fc-${forecastLevel(f)}" title="${escapeHtml(tip)}"><svg><use href="#i-alert" /></svg><span>${text}</span></div>`;
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function usageHtml(u: UsageToday | undefined): string {
  if (!u || cfg().showUsageStats === false || u.requests === 0) return "";
  const parts = [t("今日 {n}", { n: fmtTokens(u.totalTokens) }), t("{n} 次", { n: u.requests })];
  if (u.costUsd != null) parts.push(`$${u.costUsd < 10 ? u.costUsd.toFixed(2) : u.costUsd.toFixed(1)}`);
  const tip = [
    t("輸入 {n}", { n: fmtTokens(u.inputTokens) }),
    t("輸出 {n}", { n: fmtTokens(u.outputTokens) }),
    t("快取讀取 {n}", { n: fmtTokens(u.cacheReadTokens) }),
    t("快取寫入 {n}", { n: fmtTokens(u.cacheWriteTokens) }),
  ].join(" · ");
  const note = u.costUsd != null ? "\n" + t("花費是換算成 API 牌價的估計，訂閱方案不會另外收費。") : "";
  return `<div class="acc-line" title="${escapeHtml(tip + note)}"><svg><use href="#i-activity" /></svg><span>${parts.join(" · ")}</span></div>`;
}

function ageLabel(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
  if (mins < 1) return t("剛剛");
  if (mins < 60) return t("{m} 分鐘前", { m: mins });
  return t("{h} 小時前", { h: Math.floor(mins / 60) });
}

// ------------------------------------------------------------------ rendering

function renderAccountRow(acc: AccountQuota, snap: DashboardSnapshot): string {
  const showExtra = snap.settings.showAntigravityExtra;
  const isStale = acc.status === "stale";
  const isCooldown = acc.status === "cooldown";
  const isExpired = acc.status === "expired";
  // Expired but with last-known numbers: show them, marked.
  const isLastKnown = isExpired && acc.primaryWindows.length > 0;
  const isErr = acc.status !== "ok" && !isStale && !isCooldown && !isLastKnown;
  const plan = acc.plan ? `<span class="plan">${escapeHtml(acc.plan)}</span>` : "";
  const extras = forecastHtml(snap.forecasts?.[acc.id], acc.provider) + usageHtml(snap.usageToday?.[acc.id]);

  let body: string;
  let note = "";
  if (isExpired && !isLastKnown) {
    body = `<span class="status expired">${escapeHtml(acc.error ?? t("授權已過期，請重新登入這個帳號"))}</span>`;
  } else if (isErr) {
    body = `<span class="status error">${escapeHtml(acc.error ?? t("讀取失敗"))}</span>`;
  } else if (isCooldown) {
    body = `<span class="status cooldown">${escapeHtml(acc.error ?? t("查詢受限，稍後自動重試"))}</span>`;
  } else {
    let wins = [...acc.primaryWindows, ...(showExtra ? acc.extraWindows : [])];
    if (cfg().compactAccounts) {
      // Only the 5-hour and weekly limits; model and pool limits are dropped.
      const { short, long } = mainWindows(acc);
      const main = [short, long].filter((w): w is NonNullable<typeof w> => !!w);
      if (main.length) wins = main;
    }
    body = wins.length
      ? wins.map((w) => renderWindow(w, acc.provider, acc.id)).join("")
      : `<span class="status stale">${t("沒有用量資料")}</span>`;
    if (isLastKnown) {
      note = `<span class="acc-note warn" title="${escapeHtml(acc.error ?? "")}">${t("憑證過期")} · ${ageLabel(acc.updatedAt)}</span>`;
    } else if (isStale && Date.now() / 1000 - acc.updatedAt >= 600) {
      note = `<span class="acc-note" title="${escapeHtml(acc.error ?? "")}">${ageLabel(acc.updatedAt)}</span>`;
    }
  }

  return `
    <div class="row acc ${isErr ? "dim" : ""} ${isLastKnown ? "last-known" : ""}">
      ${avatarHtml(acc.id, acc.provider)}
      <div class="row-main">
        <div class="row-title"><span class="name" title="${escapeHtml(acc.name)}">${escapeHtml(displayName(acc))}</span>${plan}${note}</div>
        <div class="wins">${body}</div>
        ${extras ? `<div class="acc-extras">${extras}</div>` : ""}
      </div>
    </div>`;
}

function renderAccounts(snap: DashboardSnapshot) {
  const visible = visibleAccounts(snap.accounts);
  const badCount = visible.filter((a) => a.status !== "ok" && a.status !== "stale").length;
  accountsAlert.classList.toggle("hidden", badCount === 0);
  if (badCount > 0) accountsAlert.textContent = t("{n} 個帳號異常", { n: badCount });

  accountsSection.innerHTML =
    snap.accounts.length === 0
      ? `<div class="empty">${t("尚未找到 Claude / Antigravity / ChatGPT 的登入憑證")}</div>`
      : visible.length === 0
        ? `<div class="empty">${t("所有帳號都已隱藏，可在設定 → 帳號中開啟")}</div>`
        : visible.map((acc) => renderAccountRow(acc, snap)).join("");
}

function renderDashboard(snap: DashboardSnapshot) {
  currentSnapshot = snap;
  currentSettings = snap.settings;
  syncSettingsForm(snap.settings);

  offlineNote.classList.toggle("hidden", !snap.offline);
  const secPicks = $("sec-picks");
  secPicks.classList.toggle("hidden", snap.picks.length === 0 || snap.settings.showPicks === false);
  picksSection.innerHTML = snap.picks
    .map((pick) => {
      const reset = pick.resetAt ? `
${formatResetAt(pick.resetAt)}` : "";
      const sub = `${providerLabel(pick.provider)} · ${escapeHtml(pick.reason)}`;
      return `
      <div class="row ${pick.useBeforeReset ? "pick-soon" : ""}">
        ${avatarHtml(pick.accountId, pick.provider)}
        <div class="row-main">
          <div class="row-title"><span class="name" title="${escapeHtml(pick.accountName)}">${escapeHtml(pick.accountName)}</span></div>
          <span class="row-sub" title="${escapeHtml(pick.reason + reset)}">${sub}</span>
          ${pick.note ? `<span class="row-sub muted">${escapeHtml(pick.note)}</span>` : ""}
        </div>
        <span class="pct tone-${getTone(pick.effectiveRemaining, pick.accountId)}"><small class="pct-cap">${t("剩餘")}</small>${pick.effectiveRemaining}<small>%</small></span>
      </div>`;
    })
    .join("");

  renderAccounts(snap);
  $("mobile-summary").textContent = snap.settings.mobileEnabled ? t("已開啟") : t("未開啟");

  const timeStr = new Date(snap.lastRefreshedAt * 1000).toLocaleTimeString(locale(), {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  btnRefresh.title = `${t("立即刷新")} · ${t("{time} 更新", { time: timeStr })}`;
  analyticsView.syncContext(snap, snap.settings);
}

// ------------------------------------------------------------------ settings form

function paintSlider(inp: HTMLInputElement) {
  const min = Number(inp.min);
  const max = Number(inp.max);
  const pct = ((Number(inp.value) - min) / (max - min)) * 100;
  inp.style.setProperty("--p", `${pct}%`);
}

function setRangeIfIdle(inp: HTMLInputElement, value: number) {
  if (document.activeElement !== inp) inp.value = String(value);
  paintSlider(inp);
}

function slotHtml(src: string | null | undefined, fallback: string, alt: string) {
  return src ? `<img src="${src}" alt="${alt}" />` : `<svg><use href="#${fallback}" /></svg>`;
}

const selLanguage = $<HTMLSelectElement>("sel-language");

function syncSettingsForm(s: AppSettings) {
  if (setLang(s.language)) {
    applyI18n();
    analyticsView.retranslate();
  }
  selLanguage.innerHTML = LANGUAGES.map(
    (l) => `<option value="${l.value}">${l.value === "system" ? t("跟隨系統") : l.label}</option>`,
  ).join("");
  selLanguage.value = s.language ?? "system";
  const showPet = s.showPet !== false;
  inpShowPet.checked = showPet;
  petOptions.classList.toggle("hidden", !showPet);
  const activeTheme = s.petTheme ?? "hud_gauge";
  themeButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.theme === activeTheme));
  customCard.classList.toggle("hidden", activeTheme !== "custom");
  rowPetEffects.classList.toggle("hidden", activeTheme !== "desk_cat");

  prevSlotWorking.innerHTML = slotHtml(s.customImageWorking, "i-image", "Working");
  prevSlotSweating.innerHTML = slotHtml(s.customImageSweating, "i-image", "Sweating");
  prevSlotSleeping.innerHTML = slotHtml(s.customImageSleeping, "i-image", "Sleeping");

  setRangeIfIdle(inpPetSize, s.petSize);
  valPetSize.textContent = `${s.petSize} px`;
  setRangeIfIdle(inpWorkTh, s.workingThreshold);
  valWorkTh.textContent = `${s.workingThreshold}%`;
  setRangeIfIdle(inpSleepTh, s.sleepingThreshold);
  valSleepTh.textContent = `${s.sleepingThreshold}%`;
  valSweatRange.textContent = t("剩餘低於 {warn}% 額度條轉琥珀色、貓開始冒汗；低於 {bad}% 轉紅色、發通知、貓趴睡", { warn: s.workingThreshold, bad: s.sleepingThreshold });
  const th = $("th-preview");
  th.style.setProperty("--bad", `${s.sleepingThreshold}%`);
  th.style.setProperty("--warn", `${s.workingThreshold - s.sleepingThreshold}%`);
  renderDirList(s);

  inpNotify.checked = s.notifyEnabled;
  inpAutostart.checked = s.launchAtStartup;

  setRangeIfIdle(inpPetOpacity, s.petOpacity ?? 100);
  valPetOpacity.textContent = `${s.petOpacity ?? 100}%`;
  inpPetIdleFade.checked = !!s.petIdleFade;
  const detailMode = s.compactAccounts ? "compact" : s.showAntigravityExtra ? "all" : "standard";
  const detailBtns = Array.from(segAccDetail.querySelectorAll<HTMLButtonElement>(".seg-btn"));
  const detailIdx = Math.max(0, detailBtns.findIndex((b) => b.dataset.value === detailMode));
  detailBtns.forEach((b, i) => b.classList.toggle("active", i === detailIdx));
  segAccDetail.style.setProperty("--n", String(detailBtns.length));
  segAccDetail.style.setProperty("--i", String(detailIdx));
  accDetailHint.textContent =
    detailMode === "compact"
      ? t("每個帳號只顯示 5 小時與每週限制")
      : detailMode === "all"
        ? t("顯示主要限制與 Antigravity 次要池")
        : t("顯示每個帳號的主要限制");
  inpShowForecast.checked = s.showForecast !== false;
  inpShowUsage.checked = s.showUsageStats === true;
  inpMobile.checked = s.mobileEnabled === true;
  if (document.activeElement !== selPanelPos) selPanelPos.value = s.panelPosition ?? "pet";
  if (!recordingHotkey) btnHotkey.innerHTML = hotkeyLabel(s.hotkey ?? "");
  btnHotkeyClear.classList.toggle("hidden", !s.hotkey);
  inpNotifyReset.checked = s.notifyOnReset !== false;
  inpQuiet.checked = !!s.quietHoursEnabled;
  rowQuietTimes.classList.toggle("hidden", !s.quietHoursEnabled);
  if (document.activeElement !== inpQuietStart) inpQuietStart.value = minToTime(s.quietStartMin ?? 23 * 60);
  if (document.activeElement !== inpQuietEnd) inpQuietEnd.value = minToTime(s.quietEndMin ?? 9 * 60);
  if (currentSnapshot) renderAccountSettings(currentSnapshot.accounts);

  inpShowPicks.checked = s.showPicks !== false;
  inpPetEffects.checked = s.petEffects !== false;

  segControls.forEach((seg) => {
    const key = seg.dataset.key as keyof AppSettings;
    const btns = Array.from(seg.querySelectorAll<HTMLButtonElement>(".seg-btn"));
    const value = String(s[key] ?? btns[0].dataset.value);
    const idx = Math.max(0, btns.findIndex((b) => b.dataset.value === value));
    btns.forEach((b, i) => b.classList.toggle("active", i === idx));
    seg.style.setProperty("--n", String(btns.length));
    seg.style.setProperty("--i", String(idx));
  });
  applyDisplay(s);
}

function minToTime(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function timeToMin(v: string): number {
  const [h, m] = v.split(":").map(Number);
  return ((h || 0) * 60 + (m || 0)) % 1440;
}

function hotkeyLabel(hk: string): string {
  if (!hk) return `<span class="hk-off">${t("未設定")}</span>`;
  return hk
    .split("+")
    .map((k) => `<kbd>${escapeHtml(k === "Super" ? "Win" : k)}</kbd>`)
    .join("");
}

// ------------------------------------------------------------ account settings

function setPref(id: string, patch: Partial<AccountPref>) {
  const prefs = { ...(cfg().accountPrefs ?? {}) };
  prefs[id] = { ...(prefs[id] ?? {}), ...patch };
  commitSettings({ accountPrefs: prefs }, true);
}

function accSettingRow(acc: AccountQuota): string {
  const s = cfg();
  const p = prefOf(acc.id);
  const open = expandedAcc === acc.id;
  const tags = [providerLabel(acc.provider)];
  if (p.alias?.trim()) tags.push(t("原名 {name}", { name: acc.name }));
  if (p.hidden) tags.push(t("已隱藏"));
  if (p.notifyThreshold != null) tags.push(t("危險線 {n}%", { n: p.notifyThreshold }));
  const src = accountSources[acc.id];
  const thOpts = [
    `<option value="">${t("跟隨全域（{n}%）", { n: s.sleepingThreshold })}</option>`,
    ...[5, 10, 15, 20, 25, 30, 40, 50].map(
      (v) => `<option value="${v}" ${p.notifyThreshold === v ? "selected" : ""}>${v}%</option>`,
    ),
  ].join("");
  const body = open
    ? `
      <div class="acc-set-body">
        <div class="row"><span>${t("顯示名稱")}</span><input class="text-input" data-f="alias" maxlength="40" placeholder="${escapeHtml(acc.name)}" value="${escapeHtml(p.alias ?? "")}" /></div>
        <div class="row"><span>${t("危險線")}</span><select class="select" data-f="th">${thOpts}</select></div>
        <div class="row"><span>${t("頭像")}</span><span class="av-actions">${p.avatar ? `<button class="link-btn" data-act="av-clear">${t("還原預設")}</button>` : ""}<label class="link-btn">${t("選擇圖片")}<input type="file" accept="image/*" class="hidden-file-input" data-f="avatar" /></label></span></div>
      </div>`
    : "";
  return `
    <div class="acc-set ${open ? "open" : ""} ${p.hidden ? "is-hidden" : ""}" data-id="${escapeHtml(acc.id)}">
      <div class="row acc-set-head" data-act="toggle">
        <span class="grip" title="${t("拖曳排序")}"><svg><use href="#i-grip" /></svg></span>
        ${avatarHtml(acc.id, acc.provider)}
        <div class="row-main">
          <div class="row-title"><span class="name">${escapeHtml(displayName(acc))}</span></div>
          <span class="row-sub">${escapeHtml(tags.join(" · "))}</span>
          ${src ? `<span class="row-sub muted src" title="${escapeHtml(src)}">${escapeHtml(sourceLabel(src))}</span>` : ""}
        </div>
        <button class="icon-btn acc-vis-btn${p.hidden ? " is-off" : ""}" data-act="vis" title="${t(p.hidden ? "顯示此帳號" : "隱藏此帳號")}"><svg><use href="#${p.hidden ? "i-eye-off" : "i-eye"}" /></svg></button>
        <svg class="chev"><use href="#i-chev" /></svg>
      </div>${body}
    </div>`;
}

function renderAccountSettings(accounts: AccountQuota[]) {
  const s = cfg();
  const accs = orderedAccounts(accounts);
  const sig = JSON.stringify([
    accs.map((a) => [a.id, a.name, a.provider]),
    s.accountPrefs ?? {},
    expandedAcc,
    s.sleepingThreshold,
    accountSources,
  ]);
  if (sig === accSettingsSig) return;
  const active = document.activeElement as HTMLElement | null;
  if (active && accSettingsEl.contains(active) && active.classList.contains("text-input")) return; // typing
  accSettingsSig = sig;
  accSettingsEl.innerHTML = accs.length
    ? accs.map(accSettingRow).join("")
    : `<div class="empty">${t("尚未偵測到帳號")}</div>`;
}

function applyDisplay(s: AppSettings) {
  const root = document.documentElement;
  const appearance = s.appearance ?? "system";
  if (appearance === "system") delete root.dataset.theme;
  else root.dataset.theme = appearance;
  root.style.setProperty("--ui-zoom", String((s.uiScale ?? 90) / 100));
}

let saveTimer: number | undefined;
function commitSettings(patch: Partial<AppSettings>, immediate = false) {
  if (!currentSettings) return;
  const next: AppSettings = { ...currentSettings, ...patch };
  if (next.workingThreshold <= next.sleepingThreshold) {
    next.workingThreshold = Math.min(99, next.sleepingThreshold + 5);
  }
  currentSettings = next;
  syncSettingsForm(next);

  const send = async () => {
    try {
      const updated = await invoke<DashboardSnapshot>("update_settings", { newSettings: next });
      renderDashboard(updated);
    } catch {
      // snapshot not ready yet
    }
  };

  if (saveTimer) window.clearTimeout(saveTimer);
  if (immediate) void send();
  else saveTimer = window.setTimeout(() => void send(), 120);
}

// ------------------------------------------------------------------ events

function setSettingsVisible(show: boolean) {
  showingSettings = show;
  shell.classList.toggle("show-settings", show);
  if (!show) closeSub();
  if (show && !isRemote) {
    void showHotkeyStatus();
    void showMobileStatus();
  }
  else if (recordingHotkey) stopRecording();
}
btnSettings.addEventListener("click", () => setSettingsVisible(!showingSettings));
btnBack.addEventListener("click", () => setSettingsVisible(false));

document.querySelectorAll<HTMLInputElement>(".slider").forEach((inp) => {
  paintSlider(inp);
  inp.addEventListener("input", () => paintSlider(inp));
});

btnPin.addEventListener("click", async () => {
  pinned = !pinned;
  btnPin.classList.toggle("active", pinned);
  await invoke("set_panel_pinned", { pinned });
});

const analyticsView = createAnalyticsView({
  onSettingsSaved: (snap) => renderDashboard(snap),
});

function setDashTab(tab: "quota" | "analytics") {
  activeDashTab = tab;
  const btns = Array.from(dashTabs.querySelectorAll<HTMLButtonElement>(".seg-btn"));
  const idx = Math.max(0, btns.findIndex((b) => b.dataset.dash === tab));
  btns.forEach((b, i) => {
    const on = i === idx;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  dashTabs.style.setProperty("--n", String(btns.length));
  dashTabs.style.setProperty("--i", String(idx));
  dashQuota.classList.toggle("hidden", tab !== "quota");
  dashAnalytics.classList.toggle("hidden", tab !== "analytics");
  if (tab === "analytics") {
    analyticsView.syncContext(currentSnapshot, currentSettings);
    analyticsView.activate();
  } else {
    analyticsView.deactivate();
  }
}

dashTabs.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((btn) =>
  btn.addEventListener("click", () => setDashTab((btn.dataset.dash as "quota" | "analytics") ?? "quota")),
);

let stopSpinTimer: number | undefined;
function stopSpinSmoothly() {
  const svg = btnRefresh.querySelector("svg");
  if (!svg || !btnRefresh.classList.contains("spinning")) {
    btnRefresh.classList.remove("spinning");
    return;
  }
  const finish = () => {
    if (stopSpinTimer) {
      window.clearTimeout(stopSpinTimer);
      stopSpinTimer = undefined;
    }
    svg.removeEventListener("animationiteration", finish);
    if (!refreshing) btnRefresh.classList.remove("spinning");
  };
  svg.addEventListener("animationiteration", finish, { once: true });
  stopSpinTimer = window.setTimeout(finish, 900);
}

btnRefresh.addEventListener("click", async () => {
  if (refreshing) return;
  refreshing = true;
  if (stopSpinTimer) {
    window.clearTimeout(stopSpinTimer);
    stopSpinTimer = undefined;
  }
  btnRefresh.classList.add("spinning");
  try {
    const snap = await invoke<DashboardSnapshot>("refresh_now");
    renderDashboard(snap);
    if (activeDashTab === "analytics") await analyticsView.refresh();
  } finally {
    refreshing = false;
    stopSpinSmoothly();
  }
});

themeButtons.forEach((btn) => {
  btn.addEventListener("click", () => commitSettings({ petTheme: btn.dataset.theme as PetTheme }, true));
});

function handleImageUpload(
  input: HTMLInputElement,
  key: "customImageWorking" | "customImageSweating" | "customImageSleeping",
) {
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => commitSettings({ [key]: reader.result as string }, true);
    reader.readAsDataURL(file);
    input.value = "";
  });
}
handleImageUpload(fileWorking, "customImageWorking");
handleImageUpload(fileSweating, "customImageSweating");
handleImageUpload(fileSleeping, "customImageSleeping");

btnClearCustom.addEventListener("click", async () => {
  try {
    renderDashboard(await invoke<DashboardSnapshot>("clear_custom_images"));
  } catch {
    commitSettings({ customImageWorking: null, customImageSweating: null, customImageSleeping: null }, true);
  }
});

inpPetSize.addEventListener("input", () => commitSettings({ petSize: Number(inpPetSize.value) }));

inpWorkTh.addEventListener("input", () => {
  const work = Number(inpWorkTh.value);
  const sleep = Math.min(Number(inpSleepTh.value), work - 5);
  commitSettings({ workingThreshold: work, sleepingThreshold: Math.max(0, sleep) });
});

inpSleepTh.addEventListener("input", () => {
  const sleep = Number(inpSleepTh.value);
  const work = Math.max(Number(inpWorkTh.value), sleep + 5);
  commitSettings({ sleepingThreshold: sleep, workingThreshold: Math.min(99, work) });
});

segControls.forEach((seg) => {
  seg.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = seg.dataset.number !== undefined ? Number(btn.dataset.value) : btn.dataset.value;
      commitSettings({ [seg.dataset.key as string]: v } as Partial<AppSettings>, true);
    });
  });
});

inpShowPicks.addEventListener("change", () => commitSettings({ showPicks: inpShowPicks.checked }, true));
inpShowPet.addEventListener("change", () => commitSettings({ showPet: inpShowPet.checked }, true));
inpPetEffects.addEventListener("change", () => commitSettings({ petEffects: inpPetEffects.checked }, true));

segAccDetail.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.value;
    if (mode === "compact") commitSettings({ compactAccounts: true, showAntigravityExtra: false }, true);
    else if (mode === "all") commitSettings({ compactAccounts: false, showAntigravityExtra: true }, true);
    else commitSettings({ compactAccounts: false, showAntigravityExtra: false }, true);
  });
});

inpNotify.addEventListener("change", () => commitSettings({ notifyEnabled: inpNotify.checked }, true));
inpNotifyReset.addEventListener("change", () => commitSettings({ notifyOnReset: inpNotifyReset.checked }, true));
inpQuiet.addEventListener("change", () => commitSettings({ quietHoursEnabled: inpQuiet.checked }, true));
inpQuietStart.addEventListener("change", () => commitSettings({ quietStartMin: timeToMin(inpQuietStart.value) }, true));
inpQuietEnd.addEventListener("change", () => commitSettings({ quietEndMin: timeToMin(inpQuietEnd.value) }, true));
inpPetOpacity.addEventListener("input", () => commitSettings({ petOpacity: Number(inpPetOpacity.value) }));
inpPetIdleFade.addEventListener("change", () => commitSettings({ petIdleFade: inpPetIdleFade.checked }, true));
inpShowForecast.addEventListener("change", () => commitSettings({ showForecast: inpShowForecast.checked }, true));
inpShowUsage.addEventListener("change", () => {
  commitSettings({ showUsageStats: inpShowUsage.checked }, true);
  // Stats are only scanned while enabled: fetch them now instead of at the next poll.
  if (inpShowUsage.checked) window.setTimeout(() => invoke("refresh_now").catch(() => {}), 300);
});
selPanelPos.addEventListener("change", () =>
  commitSettings({ panelPosition: selPanelPos.value as PanelPosition }, true),
);

// ---- settings tabs
const settingsScroll = $("settings-scroll");
function showTab(name: string) {
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll<HTMLElement>(".pane").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== name));
  settingsScroll.scrollTop = 0;
  if (name === "accounts") void loadSources();
}
document.querySelectorAll<HTMLElement>(".tab").forEach((t) =>
  t.addEventListener("click", () => showTab(t.dataset.tab ?? "general")),
);

// ---- account sources, extra folders, rescan
/** Where an account was read from, in words: T3 Code, the agy CLI, or a folder. */
function sourceLabel(src: string): string {
  if (/[\\/]\.t3[\\/]|t3code/i.test(src)) return t("來自 T3 Code");
  if (src.includes("-p /usage")) return t("來自 agy CLI");
  const dir = src.replace(/[\\/][^\\/]+$/, "");
  return tailPath(dir);
}

/** Keep the end of a long path, where the account-specific part is. */
function tailPath(p: string, max = 44): string {
  return p.length <= max ? p : `…${p.slice(p.length - max + 1)}`;
}

let accountSources: Record<string, string> = {};
async function loadSources() {
  try {
    accountSources = await invoke<Record<string, string>>("account_sources");
  } catch {
    accountSources = {};
  }
  accSettingsSig = "";
  if (currentSnapshot) renderAccountSettings(currentSnapshot.accounts);
}

const dirList = $("dir-list");
let dirSig = "";
function renderDirList(s: AppSettings) {
  const dirs = s.extraAccountDirs ?? [];
  const sig = JSON.stringify(dirs);
  if (sig === dirSig) return;
  dirSig = sig;
  dirList.innerHTML = dirs
    .map(
      (d, i) => `
      <div class="row dir-row">
        <span class="dir-path" title="${escapeHtml(d)}">${escapeHtml(tailPath(d))}</span>
        <button class="icon-btn" data-rm="${i}" title="${t("移除")}"><svg><use href="#i-x" /></svg></button>
      </div>`,
    )
    .join("");
}
dirList.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-rm]");
  if (!btn) return;
  const dirs = [...(cfg().extraAccountDirs ?? [])];
  dirs.splice(Number(btn.dataset.rm), 1);
  commitSettings({ extraAccountDirs: dirs }, true);
  void rescan();
});
async function rescan() {
  const b = $("btn-rescan");
  b.textContent = t("掃描中");
  try {
    renderDashboard(await invoke<DashboardSnapshot>("refresh_now"));
    await loadSources();
    const n = currentSnapshot?.accounts.length ?? 0;
    b.textContent = t("找到 {n} 個帳號", { n });
  } catch {
    b.textContent = t("掃描失敗");
  }
  window.setTimeout(() => (b.textContent = t("重新掃描帳號")), 2500);
}
$("btn-rescan").addEventListener("click", () => void rescan());
$("btn-add-dir").addEventListener("click", async () => {
  const dir = await invoke<string | null>("pick_folder").catch(() => null);
  if (!dir) return;
  const dirs = cfg().extraAccountDirs ?? [];
  if (dirs.includes(dir)) return;
  commitSettings({ extraAccountDirs: [...dirs, dir] }, true);
  window.setTimeout(() => void rescan(), 300);
});

// ---- support
document.querySelectorAll<HTMLElement>("[data-open]").forEach((el) =>
  el.addEventListener("click", () => {
    invoke("open_target", { target: el.dataset.open }).catch(() => {});
    if (el.dataset.open?.startsWith("tailscale")) startTailscaleWatch();
  }),
);
$("btn-diag").addEventListener("click", async () => {
  const state = $("diag-state");
  try {
    await navigator.clipboard.writeText(await invoke<string>("diagnostics"));
    state.textContent = t("已複製");
  } catch {
    state.textContent = t("複製失敗");
  }
  window.setTimeout(() => (state.textContent = ""), 2500);
});
if (!isRemote) {
  getVersion()
    .then((v) => ($("app-version").textContent = `T3 DeskCat ${v}`))
    .catch(() => {});
}

// ---- phone page: a four-step guide; each step is detected, not ticked by hand
const mobileSteps = $("mobile-steps");
const mobileQr = $("mobile-qr");
const qrImg = $("qr-img");
const rowMobileToggle = $("row-mobile-toggle");
let qrFor = "";
let tsWatch: number | undefined;

function setStep(name: string, state: "done" | "current" | "todo") {
  const el = mobileSteps.querySelector<HTMLElement>(`[data-step="${name}"]`);
  if (el) el.dataset.state = state;
}

async function showMobileStatus() {
  let st: { url: string | null; error: string | null } = { url: null, error: null };
  let ts = { installed: false, connected: false };
  try {
    [st, ts] = await Promise.all([invoke<typeof st>("mobile_status"), invoke<typeof ts>("tailscale_state")]);
  } catch {
    // preview
  }
  const on = cfg().mobileEnabled === true;
  const live = on && !!st.url;
  setStep("install", ts.installed ? "done" : "current");
  setStep("signin", ts.connected ? "done" : ts.installed ? "current" : "todo");
  setStep("phone", live ? "done" : ts.connected ? "current" : "todo");
  setStep("scan", live ? "done" : ts.connected ? "current" : "todo");
  mobileSteps.classList.toggle("is-live", live);
  rowMobileToggle.classList.toggle("hidden", !on);
  inpMobile.checked = on;

  mobileQr.classList.toggle("hidden", !live);
  if (live && st.url && qrFor !== st.url) {
    qrFor = st.url;
    qrImg.innerHTML = await invoke<string>("qr_svg", { text: st.url }).catch(() => "");
  }
  btnMobileUrl.textContent = st.url ?? "";
  btnMobileUrl.dataset.url = st.url ?? "";
  const err = on && !live ? st.error : null;
  mobileHint.textContent = err ?? (on && !live ? t("啟動中") : mobileHintText());
  mobileHint.classList.toggle("error", !!err);
  if (ts.connected && tsWatch) {
    window.clearInterval(tsWatch);
    tsWatch = undefined;
  }
}

/** After sending the user to install or sign in, re-check every few seconds. */
function startTailscaleWatch() {
  if (tsWatch) return;
  let n = 0;
  tsWatch = window.setInterval(() => {
    if (++n > 100 || !showingSettings) {
      window.clearInterval(tsWatch);
      tsWatch = undefined;
      return;
    }
    void showMobileStatus();
  }, 3000);
}

function setMobile(on: boolean) {
  commitSettings({ mobileEnabled: on }, true);
  mobileHint.textContent = on ? t("啟動中") : mobileHintText();
  // The server picks the change up within ~10 s.
  [800, 2500, 6000, 11000].forEach((ms) => window.setTimeout(() => void showMobileStatus(), ms));
}
$("btn-mobile-on").addEventListener("click", () => setMobile(true));
inpMobile.addEventListener("change", () => setMobile(inpMobile.checked));
btnMobileUrl.addEventListener("click", async () => {
  const url = btnMobileUrl.dataset.url;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    btnMobileUrl.textContent = t("已複製網址");
    window.setTimeout(() => (btnMobileUrl.textContent = url), 1500);
  } catch {
    // ignore
  }
});

// ---- sub pages: phone, advanced, support, add account
let showingSub = "";
function openSub(name: string) {
  showingSub = name;
  document.querySelectorAll<HTMLElement>(".subpane").forEach((p) => p.classList.toggle("hidden", p.dataset.subpane !== name));
  const pane = document.querySelector<HTMLElement>(`.subpane[data-subpane="${name}"]`);
  $("sub-title").textContent = t(pane?.dataset.title ?? "");
  $("sub-scroll").scrollTop = 0;
  shell.classList.add("show-sub");
  if (name === "mobile") void showMobileStatus();
  if (name === "advanced") void loadSources();
  if (name === "add-account") resetAddAccount();
}
function closeSub() {
  showingSub = "";
  shell.classList.remove("show-sub");
  stopLoginWatch();
}
document.querySelectorAll<HTMLElement>("[data-sub]").forEach((el) => el.addEventListener("click", () => openSub(el.dataset.sub!)));
$("btn-sub-back").addEventListener("click", closeSub);

// ---- add account: make a fresh config folder, run the CLI's own login in a
// terminal, then pick the new account up when the login file appears.
type AddProvider = "claude" | "codex" | "antigravity";
let addProvider: AddProvider = "claude";
let loginWatch: number | undefined;
const inpAccName = $<HTMLInputElement>("inp-acc-name");
function stopLoginWatch() {
  if (loginWatch) window.clearInterval(loginWatch);
  loginWatch = undefined;
}
function accSlug(): string {
  return inpAccName.value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}
function renderAddAccount() {
  document.querySelectorAll<HTMLElement>(".provider-btn").forEach((b) => b.classList.toggle("active", b.dataset.provider === addProvider));
  const ag = addProvider === "antigravity";
  inpAccName.closest(".group")!.querySelector(".list")!.classList.toggle("hidden", ag);
  inpAccName.closest(".group")!.querySelector(".group-header")!.classList.toggle("hidden", ag);
  const slug = accSlug();
  const folder = addProvider === "claude" ? `.claude-${slug || "…"}` : `.codex-${slug || "…"}`;
  $("add-acc-hint").textContent = ag
    ? t("在終端機開啟 agy，照畫面登入 Google 帳號。登入後會自動出現")
    : t("會在使用者資料夾建立 {folder}，再開終端機執行官方登入。登入完成後會自動出現", { folder });
  ($("btn-acc-login") as HTMLButtonElement).disabled = !ag && !slug;
}
function resetAddAccount() {
  stopLoginWatch();
  inpAccName.value = "";
  $("add-acc-status").textContent = "";
  renderAddAccount();
}
document.querySelectorAll<HTMLElement>(".provider-btn").forEach((b) =>
  b.addEventListener("click", () => {
    addProvider = b.dataset.provider as AddProvider;
    renderAddAccount();
  }),
);
inpAccName.addEventListener("input", renderAddAccount);
$("btn-acc-login").addEventListener("click", async () => {
  const status = $("add-acc-status");
  status.classList.remove("error");
  try {
    const before = new Set((currentSnapshot?.accounts ?? []).map((a) => a.id));
    await invoke<string>("add_account_login", { provider: addProvider, name: accSlug() });
    status.textContent = t("已開啟終端機，請在那裡完成登入");
    stopLoginWatch();
    let n = 0;
    loginWatch = window.setInterval(async () => {
      if (++n > 100 || showingSub !== "add-account") return stopLoginWatch();
      const snap = await invoke<DashboardSnapshot>("refresh_now").catch(() => null);
      if (!snap) return;
      renderDashboard(snap);
      const added = snap.accounts.find((a) => !before.has(a.id) && a.provider === addProvider);
      if (added) {
        stopLoginWatch();
        status.textContent = t("已加入 {name}", { name: added.name });
      }
    }, 6000);
  } catch (e) {
    status.textContent = String((e as Error)?.message ?? e);
    status.classList.add("error");
  }
});

// ---- hotkey recorder
async function showHotkeyStatus() {
  try {
    const err = await invoke<string | null>("hotkey_status");
    if (err) {
      hotkeyHint.textContent = err;
      hotkeyHint.classList.add("error");
      hotkeyHint.classList.remove("hidden");
    } else if (!recordingHotkey) {
      hotkeyHint.textContent = "";
      hotkeyHint.classList.remove("error");
      hotkeyHint.classList.add("hidden");
    }
  } catch {
    if (!recordingHotkey) hotkeyHint.classList.add("hidden");
  }
}

function stopRecording() {
  recordingHotkey = false;
  btnHotkey.classList.remove("recording");
  btnHotkey.innerHTML = hotkeyLabel(cfg().hotkey ?? "");
  hotkeyHint.classList.remove("error");
  hotkeyHint.classList.add("hidden");
}

function saveHotkey(hk: string) {
  stopRecording();
  commitSettings({ hotkey: hk }, true);
  btnHotkey.innerHTML = hotkeyLabel(hk);
  window.setTimeout(() => void showHotkeyStatus(), 400);
}

/** KeyboardEvent → "Ctrl+Alt+Q"; null = only modifiers so far; "" = missing modifier. */
function comboFromEvent(e: KeyboardEvent): string | null {
  const code = e.code;
  if (/^(Control|Alt|Shift|Meta|OS)/.test(code) || !code) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  let key = code;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (code.startsWith("Arrow")) key = code.slice(5);
  const isFn = /^F\d{1,2}$/.test(key);
  if (!mods.length && !isFn) return "";
  return [...mods, key].join("+");
}

btnHotkey.addEventListener("click", () => {
  if (recordingHotkey) return stopRecording();
  recordingHotkey = true;
  btnHotkey.classList.add("recording");
  btnHotkey.textContent = t("按下組合鍵…");
  hotkeyHint.textContent = hotkeyHintText();
  hotkeyHint.classList.remove("error", "hidden");
});
btnHotkey.addEventListener("blur", () => recordingHotkey && stopRecording());
btnHotkeyClear.addEventListener("click", () => saveHotkey(""));

window.addEventListener(
  "keydown",
  (e) => {
    if (!recordingHotkey) return;
    e.preventDefault();
    e.stopPropagation();
    const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
    if (plain && e.key === "Escape") return stopRecording();
    if (plain && (e.key === "Backspace" || e.key === "Delete")) return saveHotkey("");
    const combo = comboFromEvent(e);
    if (combo === null) {
      btnHotkey.textContent = t("按下組合鍵…");
      return;
    }
    if (combo === "") {
      hotkeyHint.textContent = t("需要搭配 Ctrl / Alt / Shift / Win（F1～F12 除外）");
      hotkeyHint.classList.add("error");
      return;
    }
    saveHotkey(combo);
  },
  true,
);

// ---- account settings: expand / edit / drag-sort
accSettingsEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest(".grip")) return;
  const vis = target.closest<HTMLElement>("[data-act='vis']");
  if (vis) {
    const id = vis.closest<HTMLElement>(".acc-set")!.dataset.id!;
    setPref(id, { hidden: !prefOf(id).hidden });
    return;
  }
  const clear = target.closest<HTMLElement>("[data-act='av-clear']");
  if (clear) {
    setPref(clear.closest<HTMLElement>(".acc-set")!.dataset.id!, { avatar: null });
    return;
  }
  const head = target.closest<HTMLElement>("[data-act='toggle']");
  if (!head) return;
  const id = head.closest<HTMLElement>(".acc-set")!.dataset.id!;
  expandedAcc = expandedAcc === id ? null : id;
  accSettingsSig = "";
  if (currentSnapshot) renderAccountSettings(currentSnapshot.accounts);
});

accSettingsEl.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  const f = el.dataset.f;
  const id = el.closest<HTMLElement>(".acc-set")?.dataset.id;
  if (!f || !id) return;
  if (f === "avatar") {
    const file = (el as HTMLInputElement).files?.[0];
    if (file) void loadAvatar(file).then((avatar) => setPref(id, { avatar })).catch(() => {});
    return;
  }
  if (f === "alias") setPref(id, { alias: el.value.trim() || null });
  else if (f === "th") setPref(id, { notifyThreshold: el.value ? Number(el.value) : null });
});

accSettingsEl.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t.classList.contains("text-input") && e.key === "Enter") t.blur();
});

let drag: { id: string; pointerId: number; target: string | null; after: boolean; lastX: number; lastY: number } | null = null;
let autoScrollRaf = 0;
let autoScrollSpeed = 0;

function stopAutoScroll() {
  autoScrollSpeed = 0;
  if (autoScrollRaf) {
    cancelAnimationFrame(autoScrollRaf);
    autoScrollRaf = 0;
  }
}

function stepAutoScroll() {
  if (!drag || autoScrollSpeed === 0) {
    autoScrollRaf = 0;
    return;
  }
  const prev = settingsScroll.scrollTop;
  settingsScroll.scrollTop += autoScrollSpeed;
  if (settingsScroll.scrollTop !== prev) updateDragTarget(drag.lastX, drag.lastY);
  autoScrollRaf = requestAnimationFrame(stepAutoScroll);
}

function clearDropMarks() {
  accSettingsEl
    .querySelectorAll(".drop-before, .drop-after, .dragging")
    .forEach((el) => el.classList.remove("drop-before", "drop-after", "dragging"));
}

function updateDragTarget(clientX: number, clientY: number) {
  if (!drag) return;
  drag.lastX = clientX;
  drag.lastY = clientY;
  const rows = Array.from(accSettingsEl.querySelectorAll<HTMLElement>(".acc-set"));
  if (!rows.length) return;

  // Hit-test via viewport coordinates so touch implicit pointer capture on the
  // starting `.grip` never pins target resolution to the original row.
  const hit = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  let row = hit?.closest<HTMLElement>(".acc-set") ?? null;
  if (!row || !accSettingsEl.contains(row)) {
    const firstRect = rows[0].getBoundingClientRect();
    const lastRect = rows[rows.length - 1].getBoundingClientRect();
    if (clientY <= firstRect.top) row = rows[0];
    else if (clientY >= lastRect.bottom) row = rows[rows.length - 1];
    else {
      // Fallback: nearest row vertically when pointer is in a gap or outside X bounds.
      let best: HTMLElement | null = null;
      let bestDist = Infinity;
      for (const r of rows) {
        const rect = r.getBoundingClientRect();
        const mid = (rect.top + rect.bottom) / 2;
        const d = Math.abs(clientY - mid);
        if (d < bestDist) {
          bestDist = d;
          best = r;
        }
      }
      row = best;
    }
  }
  if (!row) return;

  const from = rows.findIndex((r) => r.dataset.id === drag!.id);
  const to = rows.indexOf(row);
  accSettingsEl.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
  drag.target = row.dataset.id!;
  drag.after = to > from;
  if (to !== from) row.classList.add(drag.after ? "drop-after" : "drop-before");

  // Auto-scroll when dragging near the top or bottom edge of the scroll viewport.
  const scRect = settingsScroll.getBoundingClientRect();
  const edge = 48;
  if (clientY < scRect.top + edge) autoScrollSpeed = -6;
  else if (clientY > scRect.bottom - edge) autoScrollSpeed = 6;
  else autoScrollSpeed = 0;
  if (autoScrollSpeed !== 0 && !autoScrollRaf) autoScrollRaf = requestAnimationFrame(stepAutoScroll);
}

accSettingsEl.addEventListener("pointerdown", (e) => {
  const grip = (e.target as HTMLElement).closest<HTMLElement>(".grip");
  if (!grip || (e.pointerType === "mouse" && e.button !== 0)) return;
  const row = grip.closest<HTMLElement>(".acc-set")!;
  e.preventDefault();
  try {
    grip.setPointerCapture(e.pointerId);
  } catch {
    // ignore if synthetic pointer
  }
  drag = { id: row.dataset.id!, pointerId: e.pointerId, target: null, after: false, lastX: e.clientX, lastY: e.clientY };
  row.classList.add("dragging");
  accSettingsEl.classList.add("sorting");
});

window.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  e.preventDefault();
  updateDragTarget(e.clientX, e.clientY);
});

window.addEventListener(
  "touchmove",
  (e) => {
    if (drag) e.preventDefault();
  },
  { passive: false },
);

function endDrag(e?: PointerEvent) {
  if (!drag) return;
  if (e && e.pointerId !== drag.pointerId) return;
  const { id, target, after } = drag;
  drag = null;
  stopAutoScroll();
  clearDropMarks();
  accSettingsEl.classList.remove("sorting");
  if (!target || target === id || !currentSnapshot) return;
  const ids = orderedAccounts(currentSnapshot.accounts).map((a) => a.id).filter((x) => x !== id);
  const at = ids.indexOf(target) + (after ? 1 : 0);
  ids.splice(at, 0, id);
  commitSettings({ accountOrder: ids }, true);
}
window.addEventListener("pointerup", endDrag);
window.addEventListener("pointercancel", (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag = null;
  stopAutoScroll();
  clearDropMarks();
  accSettingsEl.classList.remove("sorting");
});

inpAutostart.addEventListener("change", () => commitSettings({ launchAtStartup: inpAutostart.checked }, true));

$("btn-test-notify").addEventListener("click", () => {
  invoke("test_notification").catch(() => {});
});


window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (showingSub) closeSub();
  else if (showingSettings) setSettingsVisible(false);
  else if (activeDashTab === "analytics") setDashTab("quota");
  else if (!isRemote) invoke("hide_panel").catch(() => {});
});

selLanguage.addEventListener("change", () =>
  commitSettings({ language: selLanguage.value as AppSettings["language"] }, true),
);

async function init() {
  setLang(null);
  applyI18n();
  document.body.classList.toggle("remote", isRemote);
  document.documentElement.classList.toggle("remote", isRemote);
  await subscribe<DashboardSnapshot>("snapshot-updated", (snap) => renderDashboard(snap), { cmd: "get_snapshot", everyMs: 30000 });
  await subscribe<string>("open-dash-tab", (tab) => {
    setSettingsVisible(false);
    setDashTab(tab === "analytics" ? "analytics" : "quota");
  });

  const existing = await invoke<DashboardSnapshot | null>("get_snapshot");
  if (existing) {
    renderDashboard(existing);
  } else {
    currentSettings = await invoke<AppSettings>("get_settings");
    syncSettingsForm(currentSettings);
    analyticsView.syncContext(null, currentSettings);
  }
}

init().catch(() => {});
