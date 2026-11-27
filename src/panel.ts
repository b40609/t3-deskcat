import { mainWindows, normalizeStrategy } from "./focus";
import { applyI18n, LANGUAGES, locale, setLang, t, weekday } from "./i18n";
import { call as invoke, isRemote, subscribe } from "./bridge";
import { createAnalyticsView } from "./analyticsView";
import { providerBadgeLabel } from "./modelFormat";
import { normalizePetTheme } from "./themeRenderer";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  AccountPref,
  AccountQuota,
  AppSettings,
  DashboardSnapshot,
  Forecast,
  PanelLayout,
  PanelPosition,
  PanelTheme,
  ProviderKind,
  UsageToday,
} from "./types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const shell = $("app");
const picksSection = $("picks-section");
const accountsSection = $("accounts-section");
// Freeze the list order while the pointer is over it (see displayOrder).
accountsSection.addEventListener("pointerenter", () => (accountListHovered = true));
accountsSection.addEventListener("pointerleave", () => (accountListHovered = false));
const accountsAlert = $("accounts-alert");
const dashTabs = $("dash-tabs");
const dashQuota = $("dash-quota");
const dashAnalytics = $("dash-analytics");
const denseToolbar = $("dense-toolbar");
const provFilterPills = $("prov-filter-pills");
const btnQuickDisplay = $<HTMLButtonElement>("btn-quick-display");
const secAccounts = $("sec-accounts");
const secExpired = $("sec-expired");
const expiredCount = $("expired-count");
const expiredSection = $("expired-section");
const accCtxMenu = $("acc-ctx-menu");
const renameModal = $("rename-modal");
const renameForm = $<HTMLFormElement>("rename-form");
const renameOrig = $("rename-orig");
const inpRename = $<HTMLInputElement>("inp-rename");
const btnRenameCancel = $("btn-rename-cancel");

const btnLayout = $("btn-layout");
const btnRefresh = $("btn-refresh");
const btnPin = $("btn-pin");
const btnSettings = $("btn-settings");
const btnClose = $("btn-close");
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
const btnPicksStrategy = $<HTMLButtonElement>("btn-picks-strategy");
const picksOptions = $("picks-options");
const selPicksStrategy = $<HTMLSelectElement>("sel-picks-strategy");
const rowPicksScope = $("row-picks-scope");
const lblPicksCount = $("lbl-picks-count");
const inpPicksPinActive = $<HTMLInputElement>("inp-picks-pin-active");
const picksPinnedWrap = $("picks-pinned-wrap");
const picksPinnedList = $("picks-pinned-list");
const picksHint = $("picks-hint");
const hudOptions = $("hud-options");
const rowHudLayout = $("row-hud-layout");
const rowHudScope = $("row-hud-scope");
const selHudStrategy = $<HTMLSelectElement>("sel-hud-strategy");
const inpHudPinActive = $<HTMLInputElement>("inp-hud-pin-active");
const hudPinnedWrap = $("hud-pinned-wrap");
const hudPinnedList = $("hud-pinned-list");
const hudHint = $("hud-hint");
const inpShowPet = $<HTMLInputElement>("inp-show-pet");
const petOptions = $("pet-options");
const segControls = Array.from(document.querySelectorAll<HTMLElement>(".segmented[data-key]"));
const segAccDetail = $("seg-acc-detail");
const accDetailHint = $("acc-detail-hint");
const inpPetOpacity = $<HTMLInputElement>("inp-pet-opacity");
const valPetOpacity = $("val-pet-opacity");
const inpPanelOpacity = $<HTMLInputElement>("inp-panel-opacity");
const valPanelOpacity = $("val-panel-opacity");
const rowPanelTheme = $("row-panel-theme");
const rowPanelLayout = $("row-panel-layout");
const noteFrozenLook = $("note-frozen-look");
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
let providerFilter: "all" | ProviderKind = "all";
let ctxAccId: string | null = null;
let renameAccId: string | null = null;
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
  petTheme: "hud_gauge",
  uiScale: 90,
  appearance: "dark",
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
  panelLayout: "classic",
  panelTheme: "glass",
  panelOpacity: 45,
  panelPinned: false,
  panelX: null,
  panelY: null,
  panelWidth: null,
  panelHeight: null,
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

/**
 * Display order for the quota list (settings keep the pure manual order).
 * 1. Providers stay together (Claude and Antigravity are not interchangeable), in the
 *    order their first account appears in the manual order.
 * 2. Within a provider: usable -> low -> out of quota -> error.
 *    - usable / low: tightest remaining %, in 10% steps so small changes don't reshuffle;
 *      ties keep the manual order.
 *    - out of quota: the one that comes back first goes first.
 * While the pointer is over the list the previous order is kept, so rows don't move under it.
 */
let lastDisplayOrder: string[] = [];
let accountListHovered = false;

function accountTier(a: AccountQuota, snap: DashboardSnapshot): number {
  if (a.status === "error" || a.status === "expired") return 3;
  if (a.status === "cooldown" || a.effectiveRemaining <= 0) return 2;
  const s = cfg();
  const danger = s.accountPrefs?.[a.id]?.notifyThreshold || s.sleepingThreshold;
  const fc = snap.forecasts?.[a.id];
  const runsOutSoon = !!fc && fc.exhaustAt - Date.now() / 1000 < 2 * 3600;
  if (a.effectiveRemaining < danger || runsOutSoon) return 1;
  return 0;
}

function recoverAt(a: AccountQuota): number {
  const empty = a.primaryWindows.filter((w) => w.remainingPercent <= 0 && w.resetAt);
  if (empty.length) return Math.max(...empty.map((w) => w.resetAt as number));
  const resets = a.primaryWindows.map((w) => w.resetAt).filter((r): r is number => !!r);
  return resets.length ? Math.min(...resets) : Number.MAX_SAFE_INTEGER;
}

function displayOrder(list: AccountQuota[], snap: DashboardSnapshot): AccountQuota[] {
  if (accountListHovered && lastDisplayOrder.length) {
    const pos = new Map(lastDisplayOrder.map((id, i) => [id, i]));
    return [...list].sort((x, y) => (pos.get(x.id) ?? 1e9) - (pos.get(y.id) ?? 1e9));
  }
  const manual = new Map(list.map((a, i) => [a.id, i]));
  const provRank = new Map<string, number>();
  list.forEach((a) => {
    if (!provRank.has(a.provider)) provRank.set(a.provider, provRank.size);
  });
  const sorted = [...list].sort((x, y) => {
    const p = (provRank.get(x.provider) ?? 0) - (provRank.get(y.provider) ?? 0);
    if (p) return p;
    const tx = accountTier(x, snap);
    const ty = accountTier(y, snap);
    if (tx !== ty) return tx - ty;
    if (tx === 2) {
      const r = recoverAt(x) - recoverAt(y);
      if (r) return r;
    } else if (tx < 2) {
      const b = Math.floor(y.effectiveRemaining / 10) - Math.floor(x.effectiveRemaining / 10);
      if (b) return b;
    }
    return (manual.get(x.id) ?? 0) - (manual.get(y.id) ?? 0);
  });
  lastDisplayOrder = sorted.map((a) => a.id);
  return sorted;
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

/** Short reset text for dense dual-column cells ("3小時後", "4天後", "19:00", "明天 09:00"). */
function formatResetShort(resetAt: number | null): string {
  if (!resetAt) return "";
  const diffSec = resetAt - Math.floor(Date.now() / 1000);
  if (diffSec <= 0) return t("即將重設");
  const fmt = (currentSettings ?? fallbackSettings).resetFormat ?? "absolute";
  if (fmt === "relative") {
    const hours = Math.floor(diffSec / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    if (hours >= 24) return t("{d}天後", { d: Math.floor(hours / 24) });
    if (hours > 0) return t("{h}小時後", { h: hours });
    return t("{m}分後", { m: Math.max(1, mins) });
  }
  const d = new Date(resetAt * 1000);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return t("明天 {time}", { time: hm });
  if (diffSec < 6.5 * 86400) return `${weekday(d)} ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Window label → localized readable name ("5 小時", "每週", "每週 · Fable"). */
function windowName(label: string, provider: ProviderKind, dense = false): string {
  const [base, ...rest] = label.split(" ");
  const pool = rest.join(" ");
  if (/^(Argon|3P)$/.test(base) && rest.length) {
    return `${base === "3P" ? "Claude/GPT" : base} · ${windowName(pool, provider, dense)}`;
  }
  const head =
    base === "5h"
      ? dense
        ? t("5小時")
        : t("5 小時")
      : base === "Wk" || base === "週"
        ? t("每週")
        : base === "Mo"
          ? t("每月")
          : base;
  return pool ? `${head} · ${pool}` : head;
}

function panelLayout(): PanelLayout {
  return cfg().panelLayout === "dense" ? "dense" : "classic";
}

function panelTheme(): PanelTheme {
  const th = cfg().panelTheme;
  return th === "ios" || th === "default" ? th : "glass";
}

/**
 * iOS and default (including dense) themes are frozen: they still render for anyone
 * already on them, but are no longer maintained and are hidden from the menus once left.
 * New installs default to the maintained combination: glass + classic + dark.
 */
function isFrozenLook(s: AppSettings): boolean {
  return s.panelTheme === "ios" || s.panelTheme === "default";
}

function duplicateNameSet(accounts: AccountQuota[]): Set<string> {
  const counts = new Map<string, number>();
  for (const a of accounts) {
    const k = displayName(a).trim().toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const dups = new Set<string>();
  for (const [k, c] of counts) {
    if (c > 1) dups.add(k);
  }
  return dups;
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
  // shown only when usage runs ahead of elapsed time and away from 0/100 extremes.
  const ahead = elapsed != null && remaining > 0 && remaining < 100 && 100 - remaining > elapsed;
  const pacePos = elapsed == null ? -1 : showUsed ? elapsed : 100 - elapsed;
  const pace =
    !ahead || pacePos < 4 || pacePos > 96
      ? ""
      : `<i class="pace" style="left:${pacePos}%" title="${t("時間已過 {p}%：{hint}", { p: elapsed, hint: showUsed ? t("填色超過刻度代表用得比時間快") : t("填色短於刻度代表用得比時間快") })}"></i>`;
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
  if (m < 60) return t("{m} 分", { m: Math.max(1, m) });
  const h = secs / 3600;
  if (h < 24) {
    const val = h < 10 ? Math.round(h * 2) / 2 : Math.round(h);
    return t("{h} 小時", { h: val });
  }
  let days = Math.floor(secs / 86400);
  let remH = Math.round((secs % 86400) / 3600);
  if (remH === 24) {
    days += 1;
    remH = 0;
  }
  return days >= 2 || remH === 0 ? t("{d} 天", { d: days }) : t("{d} 天 {h} 小時", { d: days, h: remH });
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

function pickWindows(acc: AccountQuota, showExtra: boolean) {
  let wins = [...acc.primaryWindows, ...(showExtra ? acc.extraWindows : [])];
  if (cfg().compactAccounts) {
    // One tightest limit per account (from 5h/weekly main windows; ties keep the shorter window).
    const { short, long } = mainWindows(acc);
    const main = [short, long].filter((w): w is NonNullable<typeof w> => !!w);
    const candidates = main.length ? main : wins;
    if (candidates.length) {
      let tightest = candidates[0];
      for (const w of candidates.slice(1)) {
        if (w.remainingPercent < tightest.remainingPercent) {
          tightest = w;
        }
      }
      wins = [tightest];
    }
  }
  return wins;
}

function accountNameTitle(acc: AccountQuota): string {
  const base = `${acc.name} · ${ageLabel(acc.updatedAt)}`;
  return acc.status === "idle" && acc.error ? `${base}\n${acc.error}` : base;
}

function renderAccountRow(acc: AccountQuota, snap: DashboardSnapshot, dupNames: Set<string>): string {
  const showExtra = snap.settings.showAntigravityExtra;
  const isStale = acc.status === "stale";
  const isCooldown = acc.status === "cooldown";
  const isExpired = acc.status === "expired";
  // Unused account (token lapsed): quota doesn't move while unused (resets applied locally),
  // so render cached numbers at full clarity without a stale/idle banner; sync time stays in tooltip.
  const isIdle = acc.status === "idle";
  const hasIdleData = isIdle && acc.primaryWindows.length > 0;
  const isExpiredLastKnown = isExpired && acc.primaryWindows.length > 0;
  const isErr = acc.status !== "ok" && !isStale && !isCooldown && !isExpiredLastKnown && !isIdle;
  const nameKey = displayName(acc).trim().toLowerCase();
  const provChip = dupNames.has(nameKey)
    ? `<span class="prov-chip ${acc.provider}">${providerBadgeLabel(acc.provider)}</span>`
    : "";
  const plan = acc.plan ? `<span class="plan">${escapeHtml(acc.plan)}</span>` : "";
  const extras = forecastHtml(snap.forecasts?.[acc.id], acc.provider) + usageHtml(snap.usageToday?.[acc.id]);

  let body: string;
  let note = "";
  if (isExpired && !isExpiredLastKnown) {
    body = `<span class="status expired">${escapeHtml(acc.error ?? t("授權已過期，請重新登入這個帳號"))}</span>`;
  } else if (isIdle && !hasIdleData) {
    body = `<span class="status stale">${escapeHtml(acc.error ?? t("閒置中，用一次即更新"))}</span>`;
  } else if (isErr) {
    body = `<span class="status error">${escapeHtml(acc.error ?? t("讀取失敗"))}</span>`;
  } else if (isCooldown) {
    body = `<span class="status cooldown">${escapeHtml(acc.error ?? t("查詢受限，稍後自動重試"))}</span>`;
  } else {
    const wins = pickWindows(acc, showExtra);
    body = wins.length
      ? wins.map((w) => renderWindow(w, acc.provider, acc.id)).join("")
      : `<span class="status stale">${t("沒有用量資料")}</span>`;
    if (isExpiredLastKnown) {
      note = `<span class="acc-note warn" title="${escapeHtml(acc.error ?? "")}">${t("憑證過期")} · ${ageLabel(acc.updatedAt)}</span>`;
    } else if (isStale && acc.error) {
      const tag = /429|冷卻|受限/i.test(acc.error) ? t("冷卻中") : t("快取");
      note = `<span class="acc-note warn" title="${escapeHtml(acc.error)}">${tag} · ${ageLabel(acc.updatedAt)}</span>`;
    } else if (isStale && Date.now() / 1000 - acc.updatedAt >= 600) {
      note = `<span class="acc-note" title="${escapeHtml(acc.error ?? "")}">${ageLabel(acc.updatedAt)}</span>`;
    }
  }

  return `
    <div class="row acc ${isErr ? "dim" : ""} ${isExpiredLastKnown ? "last-known" : ""}" data-acc-id="${escapeHtml(acc.id)}">
      ${avatarHtml(acc.id, acc.provider)}
      <div class="row-main">
        <div class="row-title">
          <span class="name" title="${escapeHtml(accountNameTitle(acc))}">${escapeHtml(displayName(acc))}</span>
          ${provChip}${plan}${note}
          <button type="button" class="row-more-btn" data-acc-more="${escapeHtml(acc.id)}" title="${t("更多操作")}"><svg><use href="#i-more" /></svg></button>
        </div>
        <div class="wins">${body}</div>
        ${extras ? `<div class="acc-extras">${extras}</div>` : ""}
      </div>
    </div>`;
}

function renderDenseWindow(
  w: { label: string; remainingPercent: number; resetAt: number | null },
  provider: ProviderKind,
  accId: string,
): string {
  const showUsed = (cfg().usageDisplay ?? "used") === "used";
  const remaining = Math.max(0, Math.min(100, w.remainingPercent));
  const value = showUsed ? 100 - remaining : remaining;
  // Used up: grey instead of a second amber, so "out" reads apart from "low" at a glance.
  const tone = remaining <= 0 ? "out" : getTone(remaining, accId);
  const reset = formatResetShort(w.resetAt);
  const elapsed = elapsedPercent(w.label, w.resetAt);
  const ahead = elapsed != null && remaining > 0 && remaining < 100 && 100 - remaining > elapsed;
  const pacePos = elapsed == null ? -1 : showUsed ? elapsed : 100 - elapsed;
  const pace =
    !ahead || pacePos < 4 || pacePos > 96
      ? ""
      : `<i class="pace" style="left:${pacePos}%" title="${t("時間已過 {p}%：{hint}", { p: elapsed, hint: showUsed ? t("填色超過刻度代表用得比時間快") : t("填色短於刻度代表用得比時間快") })}"></i>`;
  const valTitle = showUsed ? t("用 {p}%", { p: value }) : t("剩 {p}%", { p: value });
  return `
    <div class="d-cell">
      <div class="d-wline">
        <span class="d-wleft"><span class="d-wname">${escapeHtml(windowName(w.label, provider, true))}</span>${reset ? `<span class="d-wreset">· ${escapeHtml(reset)}</span>` : ""}</span>
        <span class="d-wval ${tone === "good" ? "" : tone}" title="${escapeHtml(valTitle)}">${value}<span class="d-wunit">%</span></span>
      </div>
      <div class="bar d-bar"><span class="${tone === "good" ? "" : tone}" style="width:${value}%"></span>${pace}</div>
    </div>`;
}

function compactZhSpacing(s: string): string {
  // Tighten extra spaces around digits/units in CJK compact badges ("每週 早 5 天 用完" -> "每週早5天用完", "55 分鐘後" -> "55分後").
  if (!/[\u4e00-\u9fff]/.test(s)) return s;
  return s
    .replace(/分鐘後/g, "分後")
    .replace(/([\u4e00-\u9fff])\s+(\d)/g, "$1$2")
    .replace(/(\d)\s+([\u4e00-\u9fff])/g, "$1$2")
    .replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, "$1$2");
}

interface ForecastParts {
  shortText: string;
  tip: string;
  level: "bad" | "warn";
  urgent: boolean;
}

function denseForecastParts(f: Forecast | undefined, provider: ProviderKind): ForecastParts | null {
  if (!f || cfg().showForecast === false) return null;
  const mins = Math.round((f.exhaustAt - Date.now() / 1000) / 60);
  if (mins < 0) return null;
  const label = windowName(f.label, provider, true).split(" · ")[0];
  const gap = forecastGap(f);
  const when = mins < 60 ? t("{m} 分鐘後", { m: Math.max(1, mins) }) : shortWhen(f.exhaustAt);
  const rawShort =
    mins < 180
      ? t("{label} {when}用完", { label, when })
      : gap != null
        ? t("{label} 早 {gap} 用完", { label, gap: fmtGap(gap) })
        : t("{label} {when}用完", { label, when });
  const shortText = compactZhSpacing(rawShort);
  const tip =
    t("依近期用量推算，{name} 預計 {when} 耗盡", { name: windowName(f.label, provider), when }) +
    (gap != null ? t("，早於重設 {gap}", { gap: fmtGap(gap) }) : "") +
    (f.resetAt ? t("；{reset}", { reset: formatResetAt(f.resetAt) }) : "") +
    t("。消耗速率 {rate}%/h", { rate: f.ratePerHour });
  const level = forecastLevel(f);
  const urgent = mins < 120;
  return { shortText, tip, level, urgent };
}

function denseForecastBadge(f: Forecast | undefined, provider: ProviderKind): string {
  const p = denseForecastParts(f, provider);
  if (!p) return "";
  return `<span class="d-badge ${p.level}${p.urgent ? " urgent" : ""}" title="${escapeHtml(p.tip)}"><i class="d-bdot"></i><span>${escapeHtml(p.shortText)}</span></span>`;
}

function denseUsageChip(u: UsageToday | undefined): string {
  if (!u || cfg().showUsageStats !== true || u.requests === 0) return "";
  const label =
    u.costUsd != null
      ? `$${u.costUsd < 10 ? u.costUsd.toFixed(2) : u.costUsd.toFixed(1)}`
      : fmtTokens(u.totalTokens);
  const tip = [
    t("今日 {n}", { n: fmtTokens(u.totalTokens) }),
    t("{n} 次", { n: u.requests }),
    t("輸入 {n}", { n: fmtTokens(u.inputTokens) }),
    t("輸出 {n}", { n: fmtTokens(u.outputTokens) }),
    t("快取讀取 {n}", { n: fmtTokens(u.cacheReadTokens) }),
  ].join(" · ");
  return `<span class="d-cost" title="${escapeHtml(tip)}">${escapeHtml(label)}</span>`;
}

/** Neutral pill naming which quota window hit 0% (prioritizes longer bottleneck: Mo > Wk > 5h). */
function exhaustedChip(acc: AccountQuota, wins: AccountQuota["primaryWindows"]): string {
  const pool = wins.length ? wins : acc.primaryWindows;
  const zeros = pool.filter((w) => w.remainingPercent <= 0);
  const rank = (label: string) => {
    const base = label.split(" ")[0];
    if (base === "Mo") return 0;
    if (base === "Wk" || base === "週") return 1;
    if (base === "5h") return 2;
    return 3;
  };
  zeros.sort((a, b) => rank(a.label) - rank(b.label));
  const hit = zeros[0];
  const label = hit
    ? t("{win}用完", { win: windowName(hit.label, acc.provider, true) })
    : t("已用完");
  const reset = hit?.resetAt ? formatResetAt(hit.resetAt) : "";
  const tip = reset ? `${label} · ${reset}` : label;
  return `<span class="exhausted-chip" title="${escapeHtml(tip)}">${escapeHtml(label)}</span>`;
}

function renderDenseAccountRow(acc: AccountQuota, snap: DashboardSnapshot, dupNames: Set<string>): string {
  const showExtra = snap.settings.showAntigravityExtra;
  const isStale = acc.status === "stale";
  const isCooldown = acc.status === "cooldown";
  const isExpired = acc.status === "expired";
  const isIdle = acc.status === "idle";
  const hasIdleData = isIdle && acc.primaryWindows.length > 0;
  const isExpiredLastKnown = isExpired && acc.primaryWindows.length > 0;
  const isErr = acc.status !== "ok" && !isStale && !isCooldown && !isExpiredLastKnown && !isIdle;
  // Out of quota (same rule as the "out of quota" sort tier): keep full brightness and show an explicit pill.
  const isExhausted = !isErr && !isCooldown && acc.primaryWindows.length > 0 && acc.effectiveRemaining <= 0;
  const nameKey = displayName(acc).trim().toLowerCase();
  const provChip =
    dupNames.has(nameKey) && providerFilter === "all"
      ? `<span class="prov-chip ${acc.provider}">${providerBadgeLabel(acc.provider)}</span>`
      : "";

  let badge = "";
  if (isExpiredLastKnown) {
    badge = `<span class="d-badge warn urgent" title="${escapeHtml(acc.error ?? "")}"><i class="d-bdot"></i><span>${t("憑證過期")}</span></span>`;
  } else if (isStale && acc.error) {
    const tag = /429|冷卻|受限/i.test(acc.error) ? t("冷卻中") : t("快取");
    badge = `<span class="d-badge warn urgent" title="${escapeHtml(acc.error)}"><i class="d-bdot"></i><span>${tag} · ${ageLabel(acc.updatedAt)}</span></span>`;
  } else if (isExhausted) {
    badge = exhaustedChip(acc, pickWindows(acc, showExtra));
  } else if (!isErr && !isCooldown && !(isIdle && !hasIdleData)) {
    badge = denseForecastBadge(snap.forecasts?.[acc.id], acc.provider);
  }
  const costChip = denseUsageChip(snap.usageToday?.[acc.id]);

  let body: string;
  if (isExpired && !isExpiredLastKnown) {
    body = `<span class="status expired">${escapeHtml(acc.error ?? t("授權已過期，請重新登入這個帳號"))}</span>`;
  } else if (isIdle && !hasIdleData) {
    body = `<span class="status stale">${escapeHtml(acc.error ?? t("閒置中，用一次即更新"))}</span>`;
  } else if (isErr) {
    body = `<span class="status error">${escapeHtml(acc.error ?? t("讀取失敗"))}</span>`;
  } else if (isCooldown) {
    body = `<span class="status cooldown">${escapeHtml(acc.error ?? t("查詢受限，稍後自動重試"))}</span>`;
  } else {
    const wins = pickWindows(acc, showExtra);
    body = wins.length
      ? `<div class="d-wins ${wins.length === 1 ? "single" : ""}">${wins.map((w) => renderDenseWindow(w, acc.provider, acc.id)).join("")}</div>`
      : `<span class="status stale">${t("沒有用量資料")}</span>`;
  }

  return `
    <div class="dense-acc ${isErr ? "dim" : ""} ${isExpiredLastKnown ? "last-known" : ""} ${isExhausted ? "exhausted" : ""}" data-acc-id="${escapeHtml(acc.id)}">
      <div class="d-head">
        ${avatarHtml(acc.id, acc.provider)}
        <span class="d-name" title="${escapeHtml(accountNameTitle(acc))}">${escapeHtml(displayName(acc))}</span>
        ${provChip}
        ${badge}
        <span class="d-spacer"></span>
        ${costChip}
        <button type="button" class="row-more-btn" data-acc-more="${escapeHtml(acc.id)}" title="${t("更多操作")}"><svg><use href="#i-more" /></svg></button>
      </div>
      ${body}
    </div>`;
}

/** Short tag inside a circular iOS ring ("5h", "週", "月"). */
function ringShortLabel(label: string): string {
  const [base] = label.split(" ");
  if (base === "5h") return "5h";
  if (base === "Wk" || base === "週") return t("週");
  if (base === "Mo") return t("月");
  return base.slice(0, 3);
}

function renderIosRing(
  w: { label: string; remainingPercent: number; resetAt: number | null },
  provider: ProviderKind,
  accId: string,
  large = false,
): string {
  const showUsed = (cfg().usageDisplay ?? "used") === "used";
  const remaining = Math.max(0, Math.min(100, w.remainingPercent));
  const value = showUsed ? 100 - remaining : remaining;
  const tone = getTone(remaining, accId);
  const r = large ? 17.5 : 15.5;
  const vb = large ? 42 : 38;
  const cx = vb / 2;
  const circ = +(2 * Math.PI * r).toFixed(2);
  const offset = +(circ * (1 - value / 100)).toFixed(2);
  const reset = formatResetShort(w.resetAt);
  const valTitle = `${windowName(w.label, provider, true)} · ${showUsed ? t("用 {p}%", { p: value }) : t("剩 {p}%", { p: value })}${reset ? ` · ${reset}` : ""}`;
  return `
    <div class="ios-ring${large ? " lg" : ""}" title="${escapeHtml(valTitle)}">
      <svg viewBox="0 0 ${vb} ${vb}">
        <circle class="rk" cx="${cx}" cy="${cx}" r="${r}" />
        <circle class="rv ${tone}" cx="${cx}" cy="${cx}" r="${r}" stroke-dasharray="${circ}" stroke-dashoffset="${offset}" />
      </svg>
      <span class="ios-rtxt">
        <span class="ios-rnum ${tone === "good" ? "" : tone}">${value}</span>
        <span class="ios-rlbl">${escapeHtml(ringShortLabel(w.label))}</span>
      </span>
    </div>`;
}

function renderIosAccountRow(acc: AccountQuota, snap: DashboardSnapshot, dupNames: Set<string>): string {
  const showExtra = snap.settings.showAntigravityExtra;
  const showUsed = (cfg().usageDisplay ?? "used") === "used";
  const isStale = acc.status === "stale";
  const isCooldown = acc.status === "cooldown";
  const isExpired = acc.status === "expired";
  const isIdle = acc.status === "idle";
  const hasIdleData = isIdle && acc.primaryWindows.length > 0;
  const isExpiredLastKnown = isExpired && acc.primaryWindows.length > 0;
  const isErr = acc.status !== "ok" && !isStale && !isCooldown && !isExpiredLastKnown && !isIdle;
  const nameKey = displayName(acc).trim().toLowerCase();
  const provChip =
    dupNames.has(nameKey) && providerFilter === "all"
      ? `<span class="prov-chip ${acc.provider}">${providerBadgeLabel(acc.provider)}</span>`
      : "";
  const costChip = denseUsageChip(snap.usageToday?.[acc.id]);
  const fc = !isErr && !isCooldown ? denseForecastParts(snap.forecasts?.[acc.id], acc.provider) : null;
  const wins = isErr || isCooldown || (isExpired && !isExpiredLastKnown) || (isIdle && !hasIdleData) ? [] : pickWindows(acc, showExtra);
  const primaryTone = getTone(acc.effectiveRemaining, acc.id);
  const iconTone = isErr || isCooldown || primaryTone === "bad" || fc?.urgent ? "tone-bad" : primaryTone === "warn" ? "tone-warn" : "";

  let subHtml = "";
  if (isExpired && !isExpiredLastKnown) {
    subHtml = `<span class="ios-sub bad">${escapeHtml(acc.error ?? t("授權已過期，請重新登入這個帳號"))}</span>`;
  } else if (isIdle && !hasIdleData) {
    subHtml = `<span class="ios-sub">${escapeHtml(acc.error ?? t("閒置中，用一次即更新"))}</span>`;
  } else if (isErr) {
    subHtml = `<span class="ios-sub bad">${escapeHtml(acc.error ?? t("讀取失敗"))}</span>`;
  } else if (isCooldown) {
    subHtml = `<span class="ios-sub warn">${escapeHtml(acc.error ?? t("查詢受限，稍後自動重試"))}</span>`;
  } else {
    const resetShort = wins[0]?.resetAt
      ? formatResetShort(wins[0].resetAt)
      : wins[1]?.resetAt
        ? `${windowName(wins[1].label, acc.provider, true)} · ${formatResetShort(wins[1].resetAt)}`
        : "";
    const statusParts: string[] = [];
    if (isExpiredLastKnown) {
      statusParts.push(`<span class="ios-fc warn urgent"><i class="d-bdot"></i><span>${t("憑證過期")}</span></span>`);
    } else if (isStale && acc.error) {
      const tag = /429|冷卻|受限/i.test(acc.error) ? t("冷卻中") : t("快取");
      statusParts.push(`<span class="ios-fc warn urgent" title="${escapeHtml(acc.error)}"><i class="d-bdot"></i><span>${tag} · ${ageLabel(acc.updatedAt)}</span></span>`);
    }
    if (fc) {
      statusParts.push(
        `<span class="ios-fc ${fc.level}${fc.urgent ? " urgent" : ""}" title="${escapeHtml(fc.tip)}"><i class="d-bdot"></i><span>${escapeHtml(fc.shortText)}</span></span>`,
      );
    }
    const resetSpan = resetShort
      ? `<span class="ios-reset${primaryTone === "bad" ? " bad" : ""}">${escapeHtml(resetShort)}</span>`
      : "";
    if (resetSpan && statusParts.length) {
      subHtml = `<div class="ios-sub-row">${resetSpan}<span class="ios-sep-dot">·</span>${statusParts[0]}</div>`;
    } else if (statusParts.length) {
      subHtml = `<div class="ios-sub-row">${statusParts[0]}</div>`;
    } else if (resetSpan) {
      subHtml = `<div class="ios-sub-row">${resetSpan}</div>`;
    } else if (wins.length > 0) {
      subHtml = `<div class="ios-sub-row"><span class="ios-reset">${escapeHtml(showUsed ? t("已使用") : t("剩餘"))}</span></div>`;
    } else {
      subHtml = `<span class="ios-sub">${t("沒有用量資料")}</span>`;
    }
  }

  const ringWins = wins.slice(0, 2);
  const extraWins = wins.slice(2);
  const ringsHtml = ringWins.length
    ? `<div class="ios-rings">${ringWins.map((w) => renderIosRing(w, acc.provider, acc.id, ringWins.length === 1)).join("")}</div>`
    : "";
  const extraBarsHtml = extraWins.length
    ? `<div class="ios-extra-wins">${extraWins.map((w) => renderDenseWindow(w, acc.provider, acc.id)).join("")}</div>`
    : "";

  return `
    <div class="ios-acc ${isErr ? "dim" : ""} ${isExpiredLastKnown ? "last-known" : ""} ${iconTone}" data-acc-id="${escapeHtml(acc.id)}">
      <div class="ios-acc-main">
        ${avatarHtml(acc.id, acc.provider)}
        <div class="ios-info">
          <div class="ios-title-line">
            <span class="ios-name" title="${escapeHtml(accountNameTitle(acc))}">${escapeHtml(displayName(acc))}</span>
            ${provChip}
            ${costChip}
          </div>
          ${subHtml}
        </div>
        ${ringsHtml}
        <button type="button" class="row-more-btn ios-more-btn" data-acc-more="${escapeHtml(acc.id)}" title="${t("更多操作")}"><svg><use href="#i-more" /></svg></button>
      </div>
      ${extraBarsHtml}
    </div>`;
}

function renderGlassAccountCard(
  acc: AccountQuota,
  snap: DashboardSnapshot,
  dupNames: Set<string>,
  wide: boolean,
): string {
  const showExtra = snap.settings.showAntigravityExtra;
  const showUsed = (cfg().usageDisplay ?? "used") === "used";
  const isStale = acc.status === "stale";
  const isCooldown = acc.status === "cooldown";
  const isExpired = acc.status === "expired";
  const isIdle = acc.status === "idle";
  const hasIdleData = isIdle && acc.primaryWindows.length > 0;
  const isExpiredLastKnown = isExpired && acc.primaryWindows.length > 0;
  const isErr = acc.status !== "ok" && !isStale && !isCooldown && !isExpiredLastKnown && !isIdle;
  const nameKey = displayName(acc).trim().toLowerCase();
  const provChip =
    dupNames.has(nameKey) && providerFilter === "all"
      ? `<span class="prov-chip ${acc.provider}">${providerBadgeLabel(acc.provider)}</span>`
      : "";
  const costChip = denseUsageChip(snap.usageToday?.[acc.id]);
  const fc = !isErr && !isCooldown ? denseForecastParts(snap.forecasts?.[acc.id], acc.provider) : null;
  const wins = isErr || isCooldown || (isExpired && !isExpiredLastKnown) || (isIdle && !hasIdleData) ? [] : pickWindows(acc, showExtra);
  const primaryTone = getTone(acc.effectiveRemaining, acc.id);
  // Out of quota: keep full card legibility; show a neutral pill naming the depleted window and grey out 0% values.
  const isExhausted = wins.length > 0 && acc.effectiveRemaining <= 0;
  const outChip = isExhausted ? exhaustedChip(acc, wins) : "";
  const isAlert = !isExhausted && (isErr || primaryTone === "bad" || fc?.urgent === true);
  const iconTone = isAlert ? "tone-bad" : primaryTone === "warn" && !isExhausted ? "tone-warn" : "";

  let statusHtml = "";
  if (isExpiredLastKnown) {
    statusHtml = `<div class="g-fc warn urgent" title="${escapeHtml(acc.error ?? "")}"><i class="d-bdot"></i><span>${t("憑證過期")}</span></div>`;
  } else if (isStale && acc.error) {
    const tag = /429|冷卻|受限/i.test(acc.error) ? t("冷卻中") : t("快取");
    statusHtml = `<div class="g-fc warn urgent" title="${escapeHtml(acc.error)}"><i class="d-bdot"></i><span>${tag} · ${ageLabel(acc.updatedAt)}</span></div>`;
  } else if (fc) {
    statusHtml = `<div class="g-fc ${fc.level}${fc.urgent ? " urgent" : ""}" title="${escapeHtml(fc.tip)}"><i class="d-bdot"></i><span>${escapeHtml(fc.shortText)}</span></div>`;
  }

  let bodyHtml = "";
  if (isExpired && !isExpiredLastKnown) {
    bodyHtml = `<div class="status expired g-status">${escapeHtml(acc.error ?? t("授權已過期，請重新登入這個帳號"))}</div>`;
  } else if (isIdle && !hasIdleData) {
    bodyHtml = `<div class="status stale g-status">${escapeHtml(acc.error ?? t("閒置中，用一次即更新"))}</div>`;
  } else if (isErr) {
    bodyHtml = `<div class="status error g-status">${escapeHtml(acc.error ?? t("讀取失敗"))}</div>`;
  } else if (isCooldown) {
    bodyHtml = `<div class="status cooldown g-status">${escapeHtml(acc.error ?? t("查詢受限，稍後自動重試"))}</div>`;
  } else if (wins.length === 0) {
    bodyHtml = `<div class="status stale g-status">${t("沒有用量資料")}</div>`;
  } else {
    const mainW = wins[0];
    const mainRem = Math.max(0, Math.min(100, mainW.remainingPercent));
    const mainVal = showUsed ? 100 - mainRem : mainRem;
    const mainTone = mainRem <= 0 ? "out" : getTone(mainRem, acc.id);
    const mainReset = formatResetShort(mainW.resetAt);
    const mainElapsed = elapsedPercent(mainW.label, mainW.resetAt);
    const mainAhead = mainElapsed != null && mainRem > 0 && mainRem < 100 && 100 - mainRem > mainElapsed;
    const mainPacePos = mainElapsed == null ? -1 : showUsed ? mainElapsed : 100 - mainElapsed;
    const mainPace =
      !mainAhead || mainPacePos < 4 || mainPacePos > 96
        ? ""
        : `<i class="pace" style="left:${mainPacePos}%" title="${t("時間已過 {p}%：{hint}", { p: mainElapsed, hint: showUsed ? t("填色超過刻度代表用得比時間快") : t("填色短於刻度代表用得比時間快") })}"></i>`;
    const mainTitle = showUsed ? t("用 {p}%", { p: mainVal }) : t("剩 {p}%", { p: mainVal });
    const mainWinLabel = windowName(mainW.label, acc.provider, true);
    const mainWinText = showUsed
      ? t("{win}已用", { win: mainWinLabel })
      : t("{win}剩餘", { win: mainWinLabel });

    const subRows = wins
      .slice(1)
      .map((w) => {
        const rem = Math.max(0, Math.min(100, w.remainingPercent));
        const val = showUsed ? 100 - rem : rem;
        const tone = rem <= 0 ? "out" : getTone(rem, acc.id);
        const rst = formatResetShort(w.resetAt);
        const wTitle = showUsed ? t("用 {p}%", { p: val }) : t("剩 {p}%", { p: val });
        return `
          <div class="g-sub-win">
            <div class="g-sub-line">
              <span class="g-sub-lbl">${escapeHtml(windowName(w.label, acc.provider, true))}${rst ? ` · ${escapeHtml(rst)}` : ""}</span>
              <span class="g-sub-val ${tone === "good" ? "" : tone}" title="${escapeHtml(wTitle)}">${val}%</span>
            </div>
            <div class="bar g-sub-bar"><span class="${tone === "good" ? "" : tone}" style="width:${val}%"></span></div>
          </div>`;
      })
      .join("");

    bodyHtml = `
      <div class="g-main-metric">
        <span class="g-big-pct ${mainTone}" title="${escapeHtml(mainTitle)}">${mainVal}<small>%</small></span>
        <span class="g-main-meta">
          <span class="g-main-win">${escapeHtml(mainWinText)}</span>
          ${mainReset ? `<span class="g-main-reset${mainTone === "bad" ? " bad" : ""}">${escapeHtml(mainReset)}</span>` : ""}
        </span>
      </div>
      <div class="bar g-main-bar"><span class="${mainTone === "good" ? "" : mainTone}" style="width:${mainVal}%"></span>${mainPace}</div>
      ${subRows ? `<div class="g-sub-wins">${subRows}</div>` : ""}`;
  }

  return `
    <div class="glass-tile ${wide ? "wide" : ""} ${isAlert ? "is-alert" : ""} ${isExhausted ? "exhausted" : ""} ${isErr ? "dim" : ""} ${isExpiredLastKnown ? "last-known" : ""} ${iconTone}" data-acc-id="${escapeHtml(acc.id)}">
      <div class="g-head">
        ${avatarHtml(acc.id, acc.provider)}
        <span class="g-name" title="${escapeHtml(accountNameTitle(acc))}">${escapeHtml(displayName(acc))}</span>
        ${provChip}
        <span class="d-spacer"></span>
        ${outChip}
        ${costChip}
        <button type="button" class="row-more-btn g-more-btn" data-acc-more="${escapeHtml(acc.id)}" title="${t("更多操作")}"><svg><use href="#i-more" /></svg></button>
      </div>
      ${bodyHtml}
      ${statusHtml}
    </div>`;
}

function renderDenseToolbar(visible: AccountQuota[]) {
  const th = panelTheme();
  const showToolbar = (th !== "default" || panelLayout() === "dense") && visible.length > 0;
  denseToolbar.classList.toggle("hidden", !showToolbar);
  if (!showToolbar) return;

  const counts: Partial<Record<ProviderKind, number>> = {};
  for (const a of visible) counts[a.provider] = (counts[a.provider] ?? 0) + 1;
  const activeProviders = PROVIDERS.filter((p) => (counts[p.kind] ?? 0) > 0);

  if (providerFilter !== "all" && !(counts[providerFilter] ?? 0)) {
    providerFilter = "all";
  }

  if (activeProviders.length >= 2) {
    const pills = [
      `<button type="button" class="prov-pill ${providerFilter === "all" ? "active" : ""}" data-pf="all"><span>${t("全部")}</span><span class="pill-cnt">${visible.length}</span></button>`,
      ...activeProviders.map(
        (p) =>
          `<button type="button" class="prov-pill ${providerFilter === p.kind ? "active" : ""}" data-pf="${p.kind}"><span>${providerBadgeLabel(p.kind)}</span><span class="pill-cnt">${counts[p.kind]}</span></button>`,
      ),
    ];
    provFilterPills.innerHTML = pills.join("");
    provFilterPills.classList.remove("hidden");
  } else {
    provFilterPills.innerHTML = "";
    provFilterPills.classList.add("hidden");
  }

  const showUsed = (cfg().usageDisplay ?? "used") === "used";
  btnQuickDisplay.innerHTML = `<span>${showUsed ? t("已使用%") : t("剩餘%")}</span><svg><use href="#i-swap" /></svg>`;
  btnQuickDisplay.title = t("點此切換剩餘 / 已使用百分比");
}

function renderAccounts(snap: DashboardSnapshot) {
  const visible = displayOrder(visibleAccounts(snap.accounts), snap);
  // Idle expired tokens already show per-row badges and the bottom expired group;
  // reserve the top red alert banner for real fetch / connection failures and name them.
  const badAccounts = visible.filter(
    (a) => a.status !== "ok" && a.status !== "stale" && a.status !== "expired" && a.status !== "idle",
  );
  accountsAlert.classList.toggle("hidden", badAccounts.length === 0);
  if (badAccounts.length > 0) {
    const names = badAccounts.map((a) => displayName(a)).join("、");
    accountsAlert.textContent = `${t("{n} 個帳號異常", { n: badAccounts.length })}：${names}`;
  }

  renderDenseToolbar(visible);
  const dupNames = duplicateNameSet(visible);

  if (snap.accounts.length === 0) {
    secAccounts.classList.remove("hidden");
    secExpired.classList.add("hidden");
    accountsSection.className = "list";
    accountsSection.innerHTML = `<div class="empty">${t("尚未找到 Claude / Antigravity / ChatGPT 的登入憑證")}</div>`;
    return;
  }
  if (visible.length === 0) {
    secAccounts.classList.remove("hidden");
    secExpired.classList.add("hidden");
    accountsSection.className = "list";
    accountsSection.innerHTML = `<div class="empty">${t("所有帳號都已隱藏，可在設定 → 帳號中開啟")}</div>`;
    return;
  }

  const th = panelTheme();
  if (th === "glass") {
    const filtered = providerFilter === "all" ? visible : visible.filter((a) => a.provider === providerFilter);
    const healthy = filtered.filter((a) => a.status !== "expired");
    const expired = filtered.filter((a) => a.status === "expired");
    secAccounts.classList.toggle("hidden", healthy.length === 0 && expired.length > 0);
    accountsSection.className = "glass-grid";
    accountsSection.innerHTML = healthy
      .map((acc, idx) => renderGlassAccountCard(acc, snap, dupNames, healthy.length % 2 === 1 && idx === healthy.length - 1))
      .join("");
    secExpired.classList.toggle("hidden", expired.length === 0);
    expiredCount.textContent = String(expired.length);
    expiredSection.className = "glass-grid";
    expiredSection.innerHTML = expired
      .map((acc, idx) => renderGlassAccountCard(acc, snap, dupNames, expired.length % 2 === 1 && idx === expired.length - 1))
      .join("");
  } else if (th === "ios") {
    const filtered = providerFilter === "all" ? visible : visible.filter((a) => a.provider === providerFilter);
    const healthy = filtered.filter((a) => a.status !== "expired");
    const expired = filtered.filter((a) => a.status === "expired");
    secAccounts.classList.toggle("hidden", healthy.length === 0 && expired.length > 0);
    accountsSection.className = "list ios-list";
    accountsSection.innerHTML = healthy.map((acc) => renderIosAccountRow(acc, snap, dupNames)).join("");
    secExpired.classList.toggle("hidden", expired.length === 0);
    expiredCount.textContent = String(expired.length);
    expiredSection.className = "list ios-list";
    expiredSection.innerHTML = expired.map((acc) => renderIosAccountRow(acc, snap, dupNames)).join("");
  } else if (panelLayout() === "dense") {
    const filtered = providerFilter === "all" ? visible : visible.filter((a) => a.provider === providerFilter);
    const healthy = filtered.filter((a) => a.status !== "expired");
    const expired = filtered.filter((a) => a.status === "expired");
    secAccounts.classList.toggle("hidden", healthy.length === 0 && expired.length > 0);
    accountsSection.className = "list";
    accountsSection.innerHTML = healthy.map((acc) => renderDenseAccountRow(acc, snap, dupNames)).join("");
    secExpired.classList.toggle("hidden", expired.length === 0);
    expiredCount.textContent = String(expired.length);
    expiredSection.className = "list";
    expiredSection.innerHTML = expired.map((acc) => renderDenseAccountRow(acc, snap, dupNames)).join("");
  } else {
    secAccounts.classList.remove("hidden");
    secExpired.classList.add("hidden");
    accountsSection.className = "list";
    accountsSection.innerHTML = visible.map((acc) => renderAccountRow(acc, snap, dupNames)).join("");
  }
}

function localizePickReason(reason: string): string {
  return reason
    .replace(/\b5h\b/g, t("5小時"))
    .replace(/\bWk\b/g, t("每週"))
    .replace(/\bMo\b/g, t("每月"));
}

function strategyShortLabel(st: string | undefined): string {
  switch (st) {
    case "use_before_reset_weekly":
    case "use_before_reset":
      return t("週將重設");
    case "use_before_reset_5h":
      return t("5h 將重設");
    case "risk_first":
      return t("低額度");
    case "soonest_reset":
      return t("最快重設");
    case "pinned":
      return t("固定");
    default:
      return t("剩餘最多");
  }
}

function strategyHintText(st: string | undefined): string {
  switch (st) {
    case "use_before_reset_weekly":
    case "use_before_reset":
      return t("優先挑出每週額度快重設且剩餘較多的帳號，避免訂閱額度浪費");
    case "use_before_reset_5h":
      return t("優先挑出 5 小時額度快重設且還有餘裕的帳號，順手用完再重設");
    case "risk_first":
      return t("優先列出剩餘過低、即將耗盡、限流或過期的帳號，方便留意避開");
    case "soonest_reset":
      return t("依下次重設時間由近到遠排列，掌握哪個帳號最快恢復");
    case "pinned":
      return t("僅顯示下方勾選的帳號，維持固定順序");
    default:
      return t("依剩餘額度由高到低排列；30 分鐘內重設且剩餘 10% 以上者優先");
  }
}

function pickTagToneClass(strategy: string, pick: { tag?: string; useBeforeReset?: boolean }): string {
  if (pick.tag === "使用中") return "live";
  if (strategy === "risk_first" || pick.tag === "受限" || pick.tag === "過期" || pick.tag === "用盡" || pick.tag === "偏低") {
    return "risk";
  }
  if (pick.useBeforeReset || pick.tag === "週將重設" || pick.tag === "5h 將重設" || pick.tag === "將重設") return "soon";
  if (strategy === "soonest_reset" || pick.tag === "最快重設") return "reset";
  if (strategy === "pinned" || pick.tag === "固定") return "pin";
  return "good";
}

function renderPicks(snap: DashboardSnapshot) {
  const secPicks = $("sec-picks");
  const strategy = snap.settings.picksStrategy ?? "most_left";
  const isRisk = strategy === "risk_first";
  btnPicksStrategy.textContent = `${strategyShortLabel(strategy)} ▾`;
  secPicks.classList.toggle("hidden", snap.picks.length === 0 || snap.settings.showPicks === false);
  const th = panelTheme();
  if (th === "ios") {
    picksSection.className = `ios-picks-grid${snap.picks.length === 1 ? " single" : ""}`;
    picksSection.innerHTML = snap.picks
      .map((pick) => {
        const reset = pick.resetAt ? `\n${formatResetAt(pick.resetAt)}` : "";
        const reason = localizePickReason(pick.reason);
        const sub = pick.note ? pick.note : reason;
        const badge = pick.tag ? t(pick.tag) : t("首選");
        const tone = getTone(pick.effectiveRemaining, pick.accountId);
        const cardCls = isRisk ? "pick-risk" : pick.useBeforeReset ? "pick-soon" : "";
        const r = 17;
        const circ = +(2 * Math.PI * r).toFixed(2);
        const rem = Math.max(0, Math.min(100, pick.effectiveRemaining));
        const offset = +(circ * (1 - rem / 100)).toFixed(2);
        return `
        <div class="ios-pick-widget ${cardCls}" title="${escapeHtml(reason + reset)}">
          <div class="ios-pw-meta">
            <span class="ios-pw-cap ${pick.provider}">${providerBadgeLabel(pick.provider)} · ${escapeHtml(badge)}</span>
            <span class="ios-pw-name" title="${escapeHtml(pick.accountName)}">${escapeHtml(pick.accountName)}</span>
            <span class="ios-pw-sub">${escapeHtml(sub)}</span>
          </div>
          <div class="ios-ring lg">
            <svg viewBox="0 0 42 42">
              <circle class="rk" cx="21" cy="21" r="${r}" />
              <circle class="rv ${tone}" cx="21" cy="21" r="${r}" stroke-dasharray="${circ}" stroke-dashoffset="${offset}" />
            </svg>
            <span class="ios-rtxt"><span class="ios-rnum ${tone === "good" ? "" : tone}">${rem}</span></span>
          </div>
        </div>`;
      })
      .join("");
    return;
  }
  if (th === "glass" || panelLayout() === "dense") {
    picksSection.className = `picks-grid${snap.picks.length === 1 ? " single" : ""}`;
    picksSection.innerHTML = snap.picks
      .map((pick) => {
        const reset = pick.resetAt ? `\n${formatResetAt(pick.resetAt)}` : "";
        const reason = localizePickReason(pick.reason);
        const sub = pick.note ? pick.note : reason;
        const badge = pick.tag ? t(pick.tag) : t("首選");
        const cardCls = isRisk ? "pick-risk" : pick.useBeforeReset ? "pick-soon" : "";
        return `
        <div class="pick-card ${cardCls}" title="${escapeHtml(reason + reset)}">
          <div class="pick-card-top">
            <span class="pick-tag ${pick.provider}">${providerBadgeLabel(pick.provider)} · ${escapeHtml(badge)}</span>
            <span class="pick-card-pct tone-${getTone(pick.effectiveRemaining, pick.accountId)}">${t("剩 {p}%", { p: pick.effectiveRemaining })}</span>
          </div>
          <div class="pick-card-name" title="${escapeHtml(pick.accountName)}">${escapeHtml(pick.accountName)}</div>
          <div class="pick-card-sub">${escapeHtml(sub)}</div>
        </div>`;
      })
      .join("");
    return;
  }

  picksSection.className = "list";
  picksSection.innerHTML = snap.picks
    .map((pick) => {
      const reset = pick.resetAt ? `\n${formatResetAt(pick.resetAt)}` : "";
      const reason = localizePickReason(pick.reason);
      const badge = pick.tag ? t(pick.tag) : t("首選");
      const badgeTone = pickTagToneClass(strategy, pick);
      const rowCls = isRisk ? "pick-risk" : pick.useBeforeReset ? "pick-soon" : "";
      return `
      <div class="row pick-row ${rowCls}">
        ${avatarHtml(pick.accountId, pick.provider)}
        <div class="row-main">
          <div class="row-title">
            <span class="name" title="${escapeHtml(pick.accountName)}">${escapeHtml(pick.accountName)}</span>
            <span class="pick-inline-tag ${badgeTone}">${escapeHtml(badge)}</span>
          </div>
          <span class="row-sub" title="${escapeHtml(reason + reset)}">${escapeHtml(reason)}</span>
          ${pick.note ? `<span class="row-sub muted">${escapeHtml(pick.note)}</span>` : ""}
        </div>
        <span class="pct tone-${getTone(pick.effectiveRemaining, pick.accountId)}"><small class="pct-cap">${t("剩餘")}</small>${pick.effectiveRemaining}<small>%</small></span>
      </div>`;
    })
    .join("");
}

function renderDashboard(snap: DashboardSnapshot) {
  currentSnapshot = snap;
  currentSettings = snap.settings;
  syncSettingsForm(snap.settings);

  offlineNote.classList.toggle("hidden", !snap.offline);
  renderPicks(snap);
  renderAccounts(snap);
  $("mobile-summary").textContent = snap.settings.mobileEnabled ? t("已開啟") : t("未開啟");

  const timeStr = new Date(snap.lastRefreshedAt * 1000).toLocaleTimeString(locale(), {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  btnRefresh.title = `${t("立即更新")} · ${t("{time} 更新", { time: timeStr })}`;
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
  const activeTheme = normalizePetTheme(s.petTheme);
  themeButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.theme === activeTheme));
  customCard.classList.toggle("hidden", activeTheme !== "custom");

  prevSlotWorking.innerHTML = slotHtml(s.customImageWorking, "i-image", "Working");
  prevSlotSweating.innerHTML = slotHtml(s.customImageSweating, "i-image", "Sweating");
  prevSlotSleeping.innerHTML = slotHtml(s.customImageSleeping, "i-image", "Sleeping");

  setRangeIfIdle(inpPetSize, s.petSize);
  valPetSize.textContent = `${s.petSize} px`;
  setRangeIfIdle(inpWorkTh, s.workingThreshold);
  valWorkTh.textContent = `${s.workingThreshold}%`;
  setRangeIfIdle(inpSleepTh, s.sleepingThreshold);
  valSleepTh.textContent = `${s.sleepingThreshold}%`;
  valSweatRange.textContent = t("剩餘低於 {warn}% 轉為琥珀色；低於 {bad}% 轉為深琥珀色並發送通知", { warn: s.workingThreshold, bad: s.sleepingThreshold });
  const th = $("th-preview");
  th.style.setProperty("--bad", `${s.sleepingThreshold}%`);
  th.style.setProperty("--warn", `${s.workingThreshold - s.sleepingThreshold}%`);
  renderDirList(s);

  inpNotify.checked = s.notifyEnabled;
  inpAutostart.checked = s.launchAtStartup;

  setRangeIfIdle(inpPetOpacity, s.petOpacity ?? 100);
  valPetOpacity.textContent = `${s.petOpacity ?? 100}%`;
  const pOpacity = Math.max(0, Math.min(100, s.panelOpacity ?? 45));
  setRangeIfIdle(inpPanelOpacity, pOpacity);
  valPanelOpacity.textContent = `${pOpacity}%`;
  // Frozen themes only show in the menu while active (so they can be left); default's layout row stays hidden.
  const frozen = isFrozenLook(s);
  rowPanelTheme.classList.toggle("hidden", !frozen);
  rowPanelLayout.classList.toggle("hidden", true);
  noteFrozenLook.classList.toggle("hidden", !frozen);
  inpPetIdleFade.checked = !!s.petIdleFade;
  const detailMode = s.compactAccounts ? "compact" : s.showAntigravityExtra ? "all" : "standard";
  const detailBtns = Array.from(segAccDetail.querySelectorAll<HTMLButtonElement>(".seg-btn"));
  const detailIdx = Math.max(0, detailBtns.findIndex((b) => b.dataset.value === detailMode));
  detailBtns.forEach((b, i) => b.classList.toggle("active", i === detailIdx));
  segAccDetail.style.setProperty("--n", String(detailBtns.length));
  segAccDetail.style.setProperty("--i", String(detailIdx));
  accDetailHint.textContent =
    detailMode === "compact"
      ? t("精簡：每個帳號只顯示最吃緊的 1 條額度（5 小時或每週中剩餘最低者）")
      : detailMode === "all"
        ? t("全部：顯示主要額度，外加 Antigravity 次要池（Claude/GPT 共用池、Argon）")
        : t("標準：顯示每個帳號的主要額度（5 小時、每週及單模型限制）");
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
  const showPicks = s.showPicks !== false;
  picksOptions.classList.toggle("hidden", !showPicks);
  const pStrategy = normalizeStrategy(s.picksStrategy);
  const pScope = s.picksScope ?? "per_provider";
  if (document.activeElement !== selPicksStrategy) selPicksStrategy.value = pStrategy;
  rowPicksScope.classList.toggle("hidden", pStrategy === "pinned");
  lblPicksCount.textContent = pScope === "per_provider" && pStrategy !== "pinned" ? t("各平台顯示") : t("顯示數量");
  inpPicksPinActive.checked = s.picksPinActive === true;
  picksPinnedWrap.classList.toggle("hidden", pStrategy !== "pinned");
  picksHint.textContent = showPicks ? strategyHintText(pStrategy) : "";
  if (currentSnapshot && pStrategy === "pinned") {
    renderPinnedPicker(picksPinnedList, currentSnapshot.accounts, s.picksPinnedIds ?? [], "picksPinnedIds");
  }

  hudOptions.classList.toggle("hidden", activeTheme !== "hud_gauge");
  const hCount = Math.max(1, Math.min(4, s.hudCount ?? 1));
  const hStrategy = normalizeStrategy(s.hudStrategy);
  rowHudLayout.classList.toggle("hidden", hCount < 2);
  rowHudScope.classList.toggle("hidden", hCount < 2 || hStrategy === "pinned");
  if (document.activeElement !== selHudStrategy) selHudStrategy.value = hStrategy;
  inpHudPinActive.checked = s.hudPinActive !== false;
  hudPinnedWrap.classList.toggle("hidden", hStrategy !== "pinned");
  hudHint.textContent = strategyHintText(hStrategy);
  if (currentSnapshot && hStrategy === "pinned") {
    renderPinnedPicker(hudPinnedList, currentSnapshot.accounts, s.hudPinnedIds ?? [], "hudPinnedIds");
  }

  segControls.forEach((seg) => {
    const key = seg.dataset.key as keyof AppSettings;
    const allBtns = Array.from(seg.querySelectorAll<HTMLButtonElement>(".seg-btn"));
    const value = String(s[key] ?? allBtns[0].dataset.value);
    allBtns.forEach((b) => b.classList.toggle("hidden", b.dataset.frozen === "1" && b.dataset.value !== value));
    const btns = allBtns.filter((b) => !b.classList.contains("hidden"));
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
  if (drag) return;
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
  const appearance = s.appearance ?? "dark";
  if (appearance === "system") delete root.dataset.theme;
  else root.dataset.theme = appearance;
  root.style.setProperty("--ui-zoom", String((s.uiScale ?? 90) / 100));

  const uiTheme: PanelTheme = s.panelTheme === "ios" || s.panelTheme === "default" ? s.panelTheme : "glass";
  const panelOpacity = Math.max(0, Math.min(100, s.panelOpacity ?? 45));
  root.dataset.uiTheme = uiTheme;
  shell.dataset.uiTheme = uiTheme;
  shell.dataset.panelSolid = panelOpacity >= 100 ? "1" : "0";
  root.style.setProperty("--panel-alpha", String(panelOpacity / 100));

  const layout: PanelLayout = s.panelLayout === "dense" ? "dense" : "classic";
  shell.dataset.layout = layout;
  const useEl = btnLayout.querySelector("use");
  if (useEl) {
    useEl.setAttribute(
      "href",
      uiTheme === "glass"
        ? "#i-theme-bento"
        : uiTheme === "ios"
          ? "#i-theme-rings"
          : layout === "dense"
            ? "#i-layout-classic"
            : "#i-layout-dense",
    );
  }
  btnLayout.classList.remove("active");
  // Only offered as a way back from a frozen theme; glass has nothing to switch to.
  btnLayout.classList.toggle("hidden", !isFrozenLook(s));
  btnLayout.title = t("目前樣式已凍結（點此切回玻璃磚）");

  pinned = s.panelPinned === true;
  btnPin.classList.toggle("active", pinned);
  btnPin.title = pinned ? t("已釘選常駐（點此恢復自動收合）") : t("釘選為桌面常駐視窗");
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
  if (currentSnapshot) {
    const previewSnap: DashboardSnapshot = { ...currentSnapshot, settings: next };
    currentSnapshot = previewSnap;
    renderPicks(previewSnap);
    renderAccounts(previewSnap);
  }

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

btnLayout.addEventListener("click", () => {
  closeCtxMenu();
  commitSettings({ panelTheme: "glass", panelLayout: "classic" }, true);
});

inpPanelOpacity.addEventListener("input", () => {
  const v = Number(inpPanelOpacity.value);
  valPanelOpacity.textContent = `${v}%`;
  document.documentElement.style.setProperty("--panel-alpha", String(v / 100));
  shell.dataset.panelSolid = v >= 100 ? "1" : "0";
  commitSettings({ panelOpacity: v });
});

btnClose.addEventListener("click", () => {
  closeCtxMenu();
  if (!isRemote) invoke("hide_panel", { force: true }).catch(() => {});
});

btnPin.addEventListener("click", async () => {
  pinned = !pinned;
  btnPin.classList.toggle("active", pinned);
  btnPin.title = pinned ? t("已釘選常駐（點此恢復自動收合）") : t("釘選為桌面常駐視窗");
  if (currentSettings) currentSettings = { ...currentSettings, panelPinned: pinned };
  await invoke("set_panel_pinned", { pinned });
});

provFilterPills.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-pf]");
  if (!btn) return;
  providerFilter = (btn.dataset.pf as "all" | ProviderKind) ?? "all";
  if (currentSnapshot) renderAccounts(currentSnapshot);
});

btnQuickDisplay.addEventListener("click", () => {
  const next = (cfg().usageDisplay ?? "used") === "used" ? "remaining" : "used";
  commitSettings({ usageDisplay: next }, true);
});

// ---- quick account context menu & inline rename dialog
function closeCtxMenu() {
  ctxAccId = null;
  accCtxMenu.classList.add("hidden");
}

function openCtxMenu(accId: string, clientX: number, clientY: number) {
  ctxAccId = accId;
  accCtxMenu.classList.remove("hidden");
  const sr = shell.getBoundingClientRect();
  const mw = accCtxMenu.offsetWidth || 136;
  const mh = accCtxMenu.offsetHeight || 104;
  const left = Math.max(8, Math.min(sr.width - mw - 8, clientX - sr.left - mw + 24));
  const top = Math.max(44, Math.min(sr.height - mh - 8, clientY - sr.top + 6));
  accCtxMenu.style.left = `${left}px`;
  accCtxMenu.style.top = `${top}px`;
}

function openRenameModal(accId: string) {
  const acc = currentSnapshot?.accounts.find((a) => a.id === accId);
  if (!acc) return;
  renameAccId = accId;
  renameOrig.textContent = `${providerLabel(acc.provider)} · ${acc.name}`;
  inpRename.value = prefOf(accId).alias?.trim() ?? "";
  inpRename.placeholder = acc.name;
  renameModal.classList.remove("hidden");
  window.setTimeout(() => {
    inpRename.focus();
    inpRename.select();
  }, 0);
}

function closeRenameModal() {
  renameAccId = null;
  renameModal.classList.add("hidden");
}

dashQuota.addEventListener("contextmenu", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-acc-id]");
  if (!row?.dataset.accId) return;
  e.preventDefault();
  openCtxMenu(row.dataset.accId, e.clientX, e.clientY);
});

dashQuota.addEventListener("click", (e) => {
  const more = (e.target as HTMLElement).closest<HTMLElement>("[data-acc-more]");
  if (more?.dataset.accMore) {
    e.stopPropagation();
    const rect = more.getBoundingClientRect();
    openCtxMenu(more.dataset.accMore, rect.right, rect.bottom);
  }
});

accCtxMenu.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-ctx]");
  const id = ctxAccId;
  if (!btn || !id) return;
  const act = btn.dataset.ctx;
  closeCtxMenu();
  if (act === "rename") {
    openRenameModal(id);
  } else if (act === "top") {
    const allIds = orderedAccounts(currentSnapshot?.accounts ?? []).map((a) => a.id);
    const nextOrder = [id, ...allIds.filter((x) => x !== id)];
    commitSettings({ accountOrder: nextOrder }, true);
  } else if (act === "hide") {
    setPref(id, { hidden: true });
  }
});

document.addEventListener("click", (e) => {
  if (!ctxAccId) return;
  const target = e.target as HTMLElement;
  if (!accCtxMenu.contains(target) && !target.closest("[data-acc-more]")) {
    closeCtxMenu();
  }
});

dashQuota.addEventListener("scroll", () => {
  if (ctxAccId) closeCtxMenu();
}, { passive: true });

btnRenameCancel.addEventListener("click", closeRenameModal);
renameModal.addEventListener("click", (e) => {
  if (e.target === renameModal) closeRenameModal();
});
renameForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!renameAccId) return;
  const id = renameAccId;
  const alias = inpRename.value.trim() || null;
  closeRenameModal();
  setPref(id, { alias });
});

// ---- frameless desktop resize edges
if (!isRemote) {
  type ResizeDir = Parameters<ReturnType<typeof getCurrentWindow>["startResizeDragging"]>[0];
  document.querySelectorAll<HTMLElement>(".resize-edge[data-resize]").forEach((el) => {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const dir = el.dataset.resize as ResizeDir;
      void getCurrentWindow().startResizeDragging(dir).catch(() => {});
    });
  });
}

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
  btn.addEventListener("click", () => commitSettings({ petTheme: normalizePetTheme(btn.dataset.theme) }, true));
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
btnPicksStrategy.addEventListener("click", () => {
  const s = cfg();
  const hasPinned = (s.picksPinnedIds?.length ?? 0) > 0;
  const order: Array<NonNullable<AppSettings["picksStrategy"]>> = hasPinned
    ? ["most_left", "use_before_reset_weekly", "use_before_reset_5h", "risk_first", "soonest_reset", "pinned"]
    : ["most_left", "use_before_reset_weekly", "use_before_reset_5h", "risk_first", "soonest_reset"];
  const cur = normalizeStrategy(s.picksStrategy);
  const next = order[(order.indexOf(cur) + 1) % order.length];
  commitSettings({ picksStrategy: next }, true);
});
selPicksStrategy.addEventListener("change", () =>
  commitSettings({ picksStrategy: selPicksStrategy.value as AppSettings["picksStrategy"] }, true),
);
inpPicksPinActive.addEventListener("change", () =>
  commitSettings({ picksPinActive: inpPicksPinActive.checked }, true),
);
selHudStrategy.addEventListener("change", () =>
  commitSettings({ hudStrategy: selHudStrategy.value as AppSettings["hudStrategy"] }, true),
);
inpHudPinActive.addEventListener("change", () =>
  commitSettings({ hudPinActive: inpHudPinActive.checked }, true),
);

function renderPinnedPicker(
  container: HTMLElement,
  accounts: AccountQuota[],
  selectedIds: string[],
  settingKey: "picksPinnedIds" | "hudPinnedIds",
) {
  const visible = accounts.filter((a) => !prefOf(a.id).hidden);
  const selected = new Set(selectedIds);
  const sig = visible.map((a) => `${a.id}:${displayName(a)}:${selected.has(a.id) ? 1 : 0}`).join("|");
  if (container.dataset.sig === sig) return;
  container.dataset.sig = sig;
  container.innerHTML = visible
    .map((a) => {
      const on = selected.has(a.id);
      return `<button type="button" class="pin-chip${on ? " active" : ""}" data-pin-id="${escapeHtml(a.id)}"><i class="pin-chip-dot ${a.provider}"></i><span>${escapeHtml(displayName(a))}</span></button>`;
    })
    .join("");
  container.querySelectorAll<HTMLButtonElement>(".pin-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.pinId;
      if (!id) return;
      const curList = [...(cfg()[settingKey] ?? [])];
      const idx = curList.indexOf(id);
      if (idx >= 0) curList.splice(idx, 1);
      else curList.push(id);
      commitSettings({ [settingKey]: curList } as Partial<AppSettings>, true);
    });
  });
}

inpShowPet.addEventListener("change", () => commitSettings({ showPet: inpShowPet.checked }, true));

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
    renderDashboard(await invoke<DashboardSnapshot>("rescan_accounts"));
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
      const snap = await invoke<DashboardSnapshot>("rescan_accounts").catch(() => null);
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

function showHotkeyBrowserWarning(hk: string) {
  if (hotkeyHint.classList.contains("error")) return;
  if (/^Ctrl\+[A-Z]$/i.test(hk)) {
    hotkeyHint.textContent = t("提醒：{combo} 為全域快捷鍵，可能會覆蓋瀏覽器等軟體的同組合鍵", { combo: hk });
    hotkeyHint.classList.remove("error", "hidden");
  }
}

function saveHotkey(hk: string) {
  stopRecording();
  commitSettings({ hotkey: hk }, true);
  btnHotkey.innerHTML = hotkeyLabel(hk);
  showHotkeyBrowserWarning(hk);
  window.setTimeout(() => {
    void showHotkeyStatus().then(() => showHotkeyBrowserWarning(hk));
  }, 400);
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

interface DragState {
  id: string;
  row: HTMLElement;
  pointerId: number;
  startOrder: string[];
  originTop: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  zoom: number;
}

let drag: DragState | null = null;
let autoScrollRaf = 0;
let autoScrollSpeed = 0;
let settleTimer: number | undefined;
let pendingOrder: string[] | null = null;

function flushPendingOrder() {
  if (settleTimer) {
    window.clearTimeout(settleTimer);
    settleTimer = undefined;
  }
  if (pendingOrder) {
    const ids = pendingOrder;
    pendingOrder = null;
    commitSettings({ accountOrder: ids }, true);
  }
}

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
  if (settingsScroll.scrollTop !== prev) {
    updateLiveDrag(drag.lastClientX, drag.lastClientY);
  }
  autoScrollRaf = requestAnimationFrame(stepAutoScroll);
}

/** Animate sibling rows smoothly into their new positions (FLIP). */
function animateSiblingsFlip(beforeTops: Map<HTMLElement, number>, draggedRow: HTMLElement, zoom: number) {
  const rows = Array.from(accSettingsEl.querySelectorAll<HTMLElement>(".acc-set"));
  const moved: HTMLElement[] = [];
  for (const r of rows) {
    if (r === draggedRow) continue;
    const prevTop = beforeTops.get(r);
    if (prevTop == null) continue;
    const dy = (prevTop - r.getBoundingClientRect().top) / zoom;
    if (Math.abs(dy) < 0.5) continue;
    r.style.transition = "none";
    r.style.transform = `translateY(${dy}px)`;
    moved.push(r);
  }
  if (!moved.length) return;
  void accSettingsEl.offsetHeight;
  for (const r of moved) {
    r.style.transition = "transform 0.18s var(--ease)";
    r.style.transform = "";
  }
}

function updateLiveDrag(clientX: number, clientY: number) {
  if (!drag) return;
  drag.lastClientX = clientX;
  drag.lastClientY = clientY;

  const { row, zoom } = drag;
  const rows = Array.from(accSettingsEl.querySelectorAll<HTMLElement>(".acc-set"));
  if (!rows.length) return;

  // Move the dragged row's visual position with the pointer.
  const applyOffset = () => {
    const curLayoutTop = row.getBoundingClientRect().top - (parseFloat(row.dataset.dy || "0") * zoom);
    const desiredTop = drag!.originTop + (clientY - drag!.startClientY);
    const dy = (desiredTop - curLayoutTop) / zoom;
    row.dataset.dy = String(dy);
    row.style.transform = `translateY(${dy}px)`;
  };

  // Reorder live whenever the pointer crosses a sibling row's midpoint.
  const from = rows.indexOf(row);
  let targetIdx = from;
  for (let i = 0; i < rows.length; i++) {
    if (i === from) continue;
    const rect = rows[i].getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (i < from && clientY < mid) {
      targetIdx = i;
      break;
    }
    if (i > from && clientY > mid) {
      targetIdx = i;
    }
  }

  if (targetIdx !== from) {
    const beforeTops = new Map<HTMLElement, number>();
    for (const r of rows) {
      if (r !== row) beforeTops.set(r, r.getBoundingClientRect().top);
    }
    // Clear transform temporarily so layout insertion & measurement stay clean.
    row.style.transform = "";
    row.dataset.dy = "0";
    if (targetIdx < from) {
      accSettingsEl.insertBefore(row, rows[targetIdx]);
    } else {
      accSettingsEl.insertBefore(row, rows[targetIdx].nextSibling);
    }
    animateSiblingsFlip(beforeTops, row, zoom);
  }

  applyOffset();

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
  flushPendingOrder();
  const row = grip.closest<HTMLElement>(".acc-set")!;
  e.preventDefault();
  try {
    grip.setPointerCapture(e.pointerId);
  } catch {
    // ignore if synthetic pointer
  }
  const rows = Array.from(accSettingsEl.querySelectorAll<HTMLElement>(".acc-set"));
  const rect = row.getBoundingClientRect();
  const zoom = row.offsetHeight > 0 ? rect.height / row.offsetHeight : 1;
  drag = {
    id: row.dataset.id!,
    row,
    pointerId: e.pointerId,
    startOrder: rows.map((r) => r.dataset.id!),
    originTop: rect.top,
    startClientY: e.clientY,
    lastClientX: e.clientX,
    lastClientY: e.clientY,
    zoom,
  };
  row.dataset.dy = "0";
  row.style.transition = "none";
  row.classList.add("dragging");
  accSettingsEl.classList.add("sorting");
});

window.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  e.preventDefault();
  updateLiveDrag(e.clientX, e.clientY);
});

window.addEventListener(
  "touchmove",
  (e) => {
    if (drag) e.preventDefault();
  },
  { passive: false },
);

function finishDrag(commit: boolean, e?: PointerEvent) {
  if (!drag) return;
  if (e && e.pointerId !== drag.pointerId) return;
  const { row, startOrder } = drag;
  drag = null;
  stopAutoScroll();
  accSettingsEl.classList.remove("sorting");

  // Settle the dragged row smoothly into its final slot before committing innerHTML re-render.
  const ids = Array.from(accSettingsEl.querySelectorAll<HTMLElement>(".acc-set")).map((r) => r.dataset.id!);
  const changed = commit && !!currentSnapshot && ids.length === startOrder.length && ids.some((id, i) => id !== startOrder[i]);
  if (changed) pendingOrder = ids;

  row.style.transition = "transform 0.16s var(--ease), box-shadow 0.16s var(--ease)";
  row.style.transform = "";
  delete row.dataset.dy;
  settleTimer = window.setTimeout(() => {
    settleTimer = undefined;
    row.classList.remove("dragging");
    row.style.transition = "";
    accSettingsEl.querySelectorAll<HTMLElement>(".acc-set").forEach((r) => {
      if (r !== row) r.style.transition = "";
    });
    if (pendingOrder) {
      flushPendingOrder();
    } else if (!commit && currentSnapshot) {
      accSettingsSig = "";
      renderAccountSettings(currentSnapshot.accounts);
    }
  }, 165);
}

window.addEventListener("pointerup", (e) => finishDrag(true, e));
window.addEventListener("pointercancel", (e) => finishDrag(false, e));

inpAutostart.addEventListener("change", () => commitSettings({ launchAtStartup: inpAutostart.checked }, true));

$("btn-test-notify").addEventListener("click", () => {
  invoke("test_notification").catch(() => {});
});


// Track keyboard vs pointer navigation so opening the window never leaves a harsh focus ring.
window.addEventListener("keydown", (e) => {
  if (e.key === "Tab" || e.key.startsWith("Arrow")) {
    document.documentElement.classList.add("kbd-nav");
  }
}, true);
window.addEventListener("pointerdown", () => {
  document.documentElement.classList.remove("kbd-nav");
}, true);
window.addEventListener("focus", () => {
  document.documentElement.classList.remove("kbd-nav");
});

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (renameAccId) closeRenameModal();
  else if (ctxAccId) closeCtxMenu();
  else if (showingSub) closeSub();
  else if (showingSettings) setSettingsVisible(false);
  else if (activeDashTab === "analytics") setDashTab("quota");
  else if (!isRemote) invoke("hide_panel", { force: true }).catch(() => {});
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
