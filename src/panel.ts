import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { renderAvatar } from "./themeRenderer";
import type {
  AccountPref,
  AccountQuota,
  AppSettings,
  CatMood,
  DashboardSnapshot,
  PanelPosition,
  PetTheme,
  ProviderKind,
} from "./types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const shell = $("app");
const miniCanvas = $<HTMLCanvasElement>("mini-cat");
const miniCtx = miniCanvas.getContext("2d")!;
const moodBadge = $("mood-badge");
const heroScoreEl = $("hero-score");
const scoreHintEl = $("score-hint");
const ringsEl = $("rings");
const legendEl = $("legend");
const picksSection = $("picks-section");
const accountsSection = $("accounts-section");
const lastUpdatedEl = $("last-updated");

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
const inpNotifyTh = $<HTMLInputElement>("inp-notify-th");
const valNotifyTh = $("val-notify-th");
const inpRefreshSec = $<HTMLInputElement>("inp-refresh-sec");
const valRefreshSec = $("val-refresh-sec");
const inpAgExtra = $<HTMLInputElement>("inp-ag-extra");
const inpAutostart = $<HTMLInputElement>("inp-autostart");
const inpUiScale = $<HTMLInputElement>("inp-ui-scale");
const valUiScale = $("val-ui-scale");
const inpShowPicks = $<HTMLInputElement>("inp-show-picks");
const inpPetEffects = $<HTMLInputElement>("inp-pet-effects");
const segControls = Array.from(document.querySelectorAll<HTMLElement>(".segmented[data-key]"));
const inpPetOpacity = $<HTMLInputElement>("inp-pet-opacity");
const valPetOpacity = $("val-pet-opacity");
const inpPetIdleFade = $<HTMLInputElement>("inp-pet-idle-fade");
const inpPetSnap = $<HTMLInputElement>("inp-pet-snap");
const inpCompact = $<HTMLInputElement>("inp-compact");
const inpShowHistory = $<HTMLInputElement>("inp-show-history");
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
const inpClaudeInterval = $<HTMLInputElement>("inp-claude-interval");
const valClaudeInterval = $("val-claude-interval");

let currentSnapshot: DashboardSnapshot | null = null;
let currentSettings: AppSettings | null = null;
let showingSettings = false;
let pinned = false;
let miniTick = 0;
let historyById: Record<string, [number, number][]> = {};
let historyFetchedAt = 0;
let historyForSnap = -1;
let expandedAcc: string | null = null;
let accSettingsSig = "";
let recordingHotkey = false;
const HOTKEY_HINT = "點快捷鍵後按下新的組合鍵；Esc 取消、Backspace 清除。";

const fallbackSettings: AppSettings = {
  petSize: 64,
  workingThreshold: 70,
  sleepingThreshold: 20,
  scoreMode: "max_avg",
  refreshIntervalSecs: 120,
  notifyEnabled: true,
  notifyLowThreshold: 20,
  showAntigravityExtra: false,
  launchAtStartup: false,
  petX: null,
  petY: null,
  petTheme: "desk_cat",
  uiScale: 90,
  appearance: "system",
  usageDisplay: "used",
  resetFormat: "absolute",
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
  showHistory: true,
  claudeMinIntervalSecs: 90,
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

// Header avatar: animated, but only while the panel is visible
function miniFrame() {
  requestAnimationFrame(miniFrame);
  if (document.hidden) return;
  miniTick = (miniTick + 1) % 10000;
  const mood: CatMood = currentSnapshot?.mood ?? "working";
  const settings = currentSettings ?? fallbackSettings;
  const theme = settings.petTheme ?? "hud_gauge";
  const score = currentSnapshot?.overallScore ?? 100;
  renderAvatar(miniCtx, miniCanvas.width, theme, score, mood, miniTick, settings);
}
requestAnimationFrame(miniFrame);

// ------------------------------------------------------------------ helpers

const PROVIDERS: { kind: ProviderKind; label: string; color: string }[] = [
  { kind: "claude", label: "Claude", color: "var(--claude)" },
  { kind: "antigravity", label: "Antigravity", color: "var(--ag)" },
  { kind: "codex", label: "ChatGPT", color: "var(--codex)" },
];

function providerLabel(p: ProviderKind): string {
  return PROVIDERS.find((x) => x.kind === p)?.label ?? p;
}

function providerGlyph(p: ProviderKind): string {
  if (p === "claude") return "C";
  if (p === "antigravity") return "A";
  return "G";
}

function moodLabel(m: CatMood): string {
  if (m === "working") return "元氣工作中";
  if (m === "sweating") return "緊張趕工中";
  return "額度見底，趴睡中";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getTone(pct: number): "good" | "warn" | "bad" {
  const s = currentSettings ?? fallbackSettings;
  if (pct > s.workingThreshold) return "good";
  if (pct >= s.sleepingThreshold) return "warn";
  return "bad";
}

const WEEKDAYS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];

/** Claude-style reset text: "於 下午7:00 重設" / "週六上午2:00 重設", or a countdown. */
function formatResetAt(resetAt: number | null): string {
  if (!resetAt) return "";
  const diffSec = resetAt - Math.floor(Date.now() / 1000);
  if (diffSec <= 0) return "即將重設";
  const fmt = (currentSettings ?? fallbackSettings).resetFormat ?? "absolute";
  if (fmt === "relative") {
    const hours = Math.floor(diffSec / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    if (hours >= 24) return `${Math.floor(hours / 24)} 天 ${hours % 24} 小時後重設`;
    if (hours > 0) return `${hours} 小時 ${mins} 分後重設`;
    return `${Math.max(1, mins)} 分鐘後重設`;
  }
  const d = new Date(resetAt * 1000);
  const now = new Date();
  const time = d.toLocaleTimeString("zh-TW", { hour: "numeric", minute: "2-digit", hour12: true });
  if (d.toDateString() === now.toDateString()) return `於 ${time} 重設`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `明天${time} 重設`;
  if (diffSec < 6.5 * 86400) return `${WEEKDAYS[d.getDay()]}${time} 重設`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time} 重設`;
}

/** Window label → Claude-style name ("5 小時限制", "每週 · 所有模型", "每週 · Sonnet") */
function windowName(label: string, provider: ProviderKind): string {
  const [base, ...rest] = label.split(" ");
  const pool = rest.join(" ");
  // AG secondary pools come as "Argon 5h" / "3P Wk"
  if (/^(Argon|3P)$/.test(base) && rest.length) return `${base} · ${windowName(pool, provider)}`;
  const span: Record<string, string> = { "5h": "5 小時限制", Wk: "每週", "週": "每週", Mo: "每月" };
  let name =
    span[base] ??
    (/^\d+h$/.test(base) ? `${base.slice(0, -1)} 小時限制` : /^\d+d$/.test(base) ? `${base.slice(0, -1)} 天限制` : base);
  if (name === "每週" || name === "每月") {
    name += pool ? ` · ${pool}` : provider === "claude" ? " · 所有模型" : "限制";
  }
  return name;
}

function renderWindow(w: { label: string; remainingPercent: number; resetAt: number | null }, provider: ProviderKind) {
  const showUsed = ((currentSettings ?? fallbackSettings).usageDisplay ?? "used") === "used";
  const remaining = Math.max(0, Math.min(100, w.remainingPercent));
  const value = showUsed ? 100 - remaining : remaining;
  const tone = getTone(remaining);
  const reset = formatResetAt(w.resetAt);
  return `
    <div class="win">
      <div class="win-line">
        <span class="win-name">${escapeHtml(windowName(w.label, provider))}</span>
        <span class="win-meta">${reset ? `<span class="win-reset">${reset}</span>` : ""}<span class="win-val">${value}%</span></span>
      </div>
      <div class="bar"><span class="${showUsed ? `used-${tone}` : tone}" style="width:${value}%"></span></div>
    </div>`;
}

function ageLabel(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
  if (mins < 1) return "剛剛";
  if (mins < 60) return `${mins} 分鐘前`;
  return `${Math.floor(mins / 60)} 小時前`;
}

function bestByProvider(accounts: AccountQuota[]) {
  return PROVIDERS.map((p) => {
    const accs = accounts.filter((a) => a.provider === p.kind);
    const ok = accs.filter((a) => a.status === "ok" || a.status === "stale");
    const best = ok.length ? Math.max(...ok.map((a) => a.effectiveRemaining)) : null;
    return { ...p, best, count: accs.length };
  }).filter((p) => p.count > 0);
}

// ------------------------------------------------------------------ rendering

function renderRings(accounts: AccountQuota[]) {
  const data = bestByProvider(accounts);
  const width = 11;
  const gap = 2.5;
  let html = "";
  data.forEach((p, i) => {
    const r = 60 - width / 2 - 1 - i * (width + gap);
    const c = 2 * Math.PI * r;
    const pct = Math.max(0, Math.min(100, p.best ?? 0));
    const off = pct <= 0 ? c : c * (1 - pct / 100);
    html += `<circle class="track" cx="60" cy="60" r="${r}" stroke="${p.color}" stroke-width="${width}" />`;
    html += `<circle class="arc" cx="60" cy="60" r="${r}" stroke="${p.color}" stroke-width="${width}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}" />`;
  });
  ringsEl.innerHTML = html;
  legendEl.innerHTML = data
    .map(
      (p) => `
      <div class="legend-item">
        <span class="legend-name"><i style="background:${p.color}"></i>${p.label}</span>
        <span class="legend-val">${p.best ?? "—"}${p.best !== null ? "<small>%</small>" : ""}</span>
      </div>`,
    )
    .join("");
}

function renderAccountRow(acc: AccountQuota, showExtra: boolean): string {
  const isStale = acc.status === "stale";
  const isCooldown = acc.status === "cooldown";
  const isExpired = acc.status === "expired";
  const isErr = acc.status !== "ok" && !isStale && !isCooldown;
  const plan = acc.plan ? `<span class="plan">${escapeHtml(acc.plan)}</span>` : "";

  let body: string;
  let note = "";
  if (isExpired) {
    body = `<span class="status expired">授權已過期，請在 T3 重新登入</span>`;
  } else if (isErr) {
    body = `<span class="status error">${escapeHtml(acc.error ?? "讀取失敗")}</span>`;
  } else if (isCooldown) {
    body = `<span class="status cooldown">${escapeHtml(acc.error ?? "查詢受限，稍後自動重試")}</span>`;
  } else {
    let wins = [...acc.primaryWindows, ...(showExtra ? acc.extraWindows : [])];
    if (cfg().compactAccounts && wins.length > 1) {
      const pool = acc.primaryWindows.length ? acc.primaryWindows : wins;
      wins = [pool.reduce((m, w) => (w.remainingPercent < m.remainingPercent ? w : m), pool[0])];
    }
    body = wins.length
      ? wins.map((w) => renderWindow(w, acc.provider)).join("") + sparkHtml(acc.id)
      : `<span class="status stale">沒有用量資料</span>`;
    if (isStale) {
      note = `<span class="acc-note" title="${escapeHtml(acc.error ?? "")}">${ageLabel(acc.updatedAt)}</span>`;
    }
  }

  return `
    <div class="row acc ${isErr ? "dim" : ""}">
      <span class="p-icon ${acc.provider}">${providerGlyph(acc.provider)}</span>
      <div class="row-main">
        <div class="row-title"><span class="name" title="${escapeHtml(acc.name)}">${escapeHtml(displayName(acc))}</span>${plan}${note}</div>
        <div class="wins">${body}</div>
      </div>
    </div>`;
}

/** 24h sparkline of the account's effective quota (used or remaining, per setting). */
function sparkHtml(id: string): string {
  const s = cfg();
  if (s.showHistory === false) return "";
  const now = Date.now() / 1000;
  const start = now - 86400;
  const pts = (historyById[id] ?? []).filter(([t]) => t >= start);
  if (pts.length < 2) return "";
  const used = (s.usageDisplay ?? "used") === "used";
  const W = 200;
  const H = 22;
  const xy = pts.map(([t, v]) => {
    const val = used ? 100 - v : v;
    return [((t - start) / 86400) * W, H - 1 - (Math.max(0, Math.min(100, val)) / 100) * (H - 2)];
  });
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `M${xy[0][0].toFixed(1)},${H} L${line.replace(/ /g, " L")} L${xy[xy.length - 1][0].toFixed(1)},${H} Z`;
  return `
    <div class="spark-wrap" title="過去 24 小時${used ? "已使用" : "剩餘"}額度">
      <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <path class="spark-area" d="${area}" /><polyline class="spark-line" points="${line}" />
      </svg>
      <span class="spark-cap">24h</span>
    </div>`;
}

async function refreshHistory(force = false) {
  if (cfg().showHistory === false) return;
  if (!force && Date.now() - historyFetchedAt < 30_000) return;
  historyFetchedAt = Date.now();
  try {
    historyById = await invoke<Record<string, [number, number][]>>("get_history");
    if (currentSnapshot) renderAccounts(currentSnapshot);
  } catch {
    // command unavailable (preview)
  }
}

function renderAccounts(snap: DashboardSnapshot) {
  const visible = visibleAccounts(snap.accounts);
  const okCount = visible.filter((a) => a.status === "ok" || a.status === "stale").length;
  const hiddenCount = snap.accounts.length - visible.length;
  $("accounts-count").textContent =
    `${okCount}/${visible.length} 在線` + (hiddenCount ? ` · 隱藏 ${hiddenCount}` : "");

  accountsSection.innerHTML =
    snap.accounts.length === 0
      ? `<div class="empty">尚未找到 Claude / Antigravity / ChatGPT 的登入憑證</div>`
      : visible.length === 0
        ? `<div class="empty">所有帳號都已隱藏，可在設定 → 帳號中開啟</div>`
        : visible.map((acc) => renderAccountRow(acc, snap.settings.showAntigravityExtra)).join("");
}

function renderDashboard(snap: DashboardSnapshot) {
  currentSnapshot = snap;
  currentSettings = snap.settings;
  syncSettingsForm(snap.settings);

  moodBadge.textContent = moodLabel(snap.mood);
  moodBadge.className = `mood-pill ${snap.mood}`;
  heroScoreEl.textContent = String(snap.overallScore);
  const modeHint = snap.settings.scoreMode === "max_avg" ? "各家最高平均" : "全部帳號平均";
  scoreHintEl.textContent = `總體剩餘 · ${modeHint}`;
  renderRings(visibleAccounts(snap.accounts).filter((a) => !prefOf(a.id).excludeScore));

  const secPicks = $("sec-picks");
  secPicks.classList.toggle("hidden", snap.picks.length === 0 || snap.settings.showPicks === false);
  picksSection.innerHTML = snap.picks
    .map(
      (pick) => `
      <div class="row">
        <span class="p-icon ${pick.provider}">${providerGlyph(pick.provider)}</span>
        <div class="row-main">
          <div class="row-title"><span class="name" title="${escapeHtml(pick.accountName)}">${escapeHtml(pick.accountName)}</span></div>
          <span class="row-sub">${providerLabel(pick.provider)} · ${escapeHtml(pick.reason)}</span>
        </div>
        <span class="pct tone-${getTone(pick.effectiveRemaining)}"><small class="pct-cap">剩餘</small>${pick.effectiveRemaining}<small>%</small></span>
      </div>`,
    )
    .join("");

  renderAccounts(snap);
  if (snap.lastRefreshedAt !== historyForSnap) {
    historyForSnap = snap.lastRefreshedAt;
    void refreshHistory(true);
  }

  const timeStr = new Date(snap.lastRefreshedAt * 1000).toLocaleTimeString("zh-TW", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  lastUpdatedEl.textContent = `更新於 ${timeStr} · 每 ${snap.settings.refreshIntervalSecs} 秒自動刷新`;
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
  return src ? `<img src="${src}" alt="${alt}" />` : fallback;
}

function syncSettingsForm(s: AppSettings) {
  const activeTheme = s.petTheme ?? "hud_gauge";
  themeButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.theme === activeTheme));
  customCard.classList.toggle("hidden", activeTheme !== "custom");

  prevSlotWorking.innerHTML = slotHtml(s.customImageWorking, "💻", "Working");
  prevSlotSweating.innerHTML = slotHtml(s.customImageSweating, "💦", "Sweating");
  prevSlotSleeping.innerHTML = slotHtml(s.customImageSleeping, "😴", "Sleeping");

  setRangeIfIdle(inpPetSize, s.petSize);
  valPetSize.textContent = `${s.petSize} px`;
  setRangeIfIdle(inpWorkTh, s.workingThreshold);
  valWorkTh.textContent = `${s.workingThreshold}%`;
  setRangeIfIdle(inpSleepTh, s.sleepingThreshold);
  valSleepTh.textContent = `${s.sleepingThreshold}%`;
  valSweatRange.textContent = `介於 ${s.sleepingThreshold}% ~ ${s.workingThreshold}% 時，貓會冒汗趕工。`;

  inpNotify.checked = s.notifyEnabled;
  setRangeIfIdle(inpNotifyTh, s.notifyLowThreshold);
  valNotifyTh.textContent = `${s.notifyLowThreshold}%`;
  setRangeIfIdle(inpRefreshSec, s.refreshIntervalSecs);
  valRefreshSec.textContent = `${s.refreshIntervalSecs} 秒`;

  inpAgExtra.checked = s.showAntigravityExtra;
  inpAutostart.checked = s.launchAtStartup;

  setRangeIfIdle(inpPetOpacity, s.petOpacity ?? 100);
  valPetOpacity.textContent = `${s.petOpacity ?? 100}%`;
  inpPetIdleFade.checked = !!s.petIdleFade;
  inpPetSnap.checked = s.petSnapEdge !== false;
  inpCompact.checked = !!s.compactAccounts;
  inpShowHistory.checked = s.showHistory !== false;
  if (document.activeElement !== selPanelPos) selPanelPos.value = s.panelPosition ?? "pet";
  if (!recordingHotkey) btnHotkey.innerHTML = hotkeyLabel(s.hotkey ?? "");
  btnHotkeyClear.classList.toggle("hidden", !s.hotkey);
  inpNotifyReset.checked = s.notifyOnReset !== false;
  inpQuiet.checked = !!s.quietHoursEnabled;
  rowQuietTimes.classList.toggle("hidden", !s.quietHoursEnabled);
  if (document.activeElement !== inpQuietStart) inpQuietStart.value = minToTime(s.quietStartMin ?? 23 * 60);
  if (document.activeElement !== inpQuietEnd) inpQuietEnd.value = minToTime(s.quietEndMin ?? 9 * 60);
  const ci = s.claudeMinIntervalSecs ?? 90;
  setRangeIfIdle(inpClaudeInterval, ci);
  valClaudeInterval.textContent = ci % 60 ? `${Math.floor(ci / 60)} 分 ${ci % 60} 秒` : `${ci / 60} 分鐘`;
  if (currentSnapshot) renderAccountSettings(currentSnapshot.accounts);

  setRangeIfIdle(inpUiScale, s.uiScale ?? 90);
  valUiScale.textContent = `${s.uiScale ?? 90}%`;
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
  if (!hk) return `<span class="hk-off">未設定</span>`;
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
  if (p.alias?.trim()) tags.push(`原名 ${acc.name}`);
  if (p.hidden) tags.push("已隱藏");
  else if (p.excludeScore) tags.push("不計分");
  if (p.notifyThreshold != null) tags.push(`警戒 ${p.notifyThreshold}%`);
  const thOpts = [
    `<option value="">跟隨全域（${s.notifyLowThreshold}%）</option>`,
    ...[5, 10, 15, 20, 25, 30, 40, 50].map(
      (v) => `<option value="${v}" ${p.notifyThreshold === v ? "selected" : ""}>${v}%</option>`,
    ),
  ].join("");
  const body = open
    ? `
      <div class="acc-set-body">
        <div class="row"><span>顯示名稱</span><input class="text-input" data-f="alias" maxlength="40" placeholder="${escapeHtml(acc.name)}" value="${escapeHtml(p.alias ?? "")}" /></div>
        <label class="row"><span>在額度頁顯示</span><input class="switch" type="checkbox" data-f="visible" ${p.hidden ? "" : "checked"} /></label>
        <label class="row ${p.hidden ? "disabled" : ""}"><span>計入總分與心情</span><input class="switch" type="checkbox" data-f="score" ${p.excludeScore || p.hidden ? "" : "checked"} ${p.hidden ? "disabled" : ""} /></label>
        <div class="row"><span>低額度警戒線</span><select class="select" data-f="th">${thOpts}</select></div>
      </div>`
    : "";
  return `
    <div class="acc-set ${open ? "open" : ""} ${p.hidden ? "is-hidden" : ""}" data-id="${escapeHtml(acc.id)}">
      <div class="row acc-set-head" data-act="toggle">
        <span class="grip" title="拖曳排序"><svg><use href="#i-grip" /></svg></span>
        <span class="p-icon ${acc.provider}">${providerGlyph(acc.provider)}</span>
        <div class="row-main">
          <div class="row-title"><span class="name">${escapeHtml(displayName(acc))}</span>${p.hidden ? `<svg class="tag-ico"><use href="#i-eye-off" /></svg>` : ""}</div>
          <span class="row-sub">${escapeHtml(tags.join(" · "))}</span>
        </div>
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
    s.notifyLowThreshold,
  ]);
  if (sig === accSettingsSig) return;
  const active = document.activeElement as HTMLElement | null;
  if (active && accSettingsEl.contains(active) && active.classList.contains("text-input")) return; // typing
  accSettingsSig = sig;
  accSettingsEl.innerHTML = accs.length
    ? accs.map(accSettingRow).join("")
    : `<div class="empty">尚未偵測到帳號</div>`;
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
  if (show) void showHotkeyStatus();
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

btnRefresh.addEventListener("click", async () => {
  btnRefresh.classList.add("spinning");
  try {
    renderDashboard(await invoke<DashboardSnapshot>("refresh_now"));
  } finally {
    btnRefresh.classList.remove("spinning");
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
      commitSettings({ [seg.dataset.key as string]: btn.dataset.value } as Partial<AppSettings>, true);
    });
  });
});

inpUiScale.addEventListener("input", () => commitSettings({ uiScale: Number(inpUiScale.value) }));
inpShowPicks.addEventListener("change", () => commitSettings({ showPicks: inpShowPicks.checked }, true));
inpPetEffects.addEventListener("change", () => commitSettings({ petEffects: inpPetEffects.checked }, true));

inpNotify.addEventListener("change", () => commitSettings({ notifyEnabled: inpNotify.checked }, true));
inpNotifyReset.addEventListener("change", () => commitSettings({ notifyOnReset: inpNotifyReset.checked }, true));
inpQuiet.addEventListener("change", () => commitSettings({ quietHoursEnabled: inpQuiet.checked }, true));
inpQuietStart.addEventListener("change", () => commitSettings({ quietStartMin: timeToMin(inpQuietStart.value) }, true));
inpQuietEnd.addEventListener("change", () => commitSettings({ quietEndMin: timeToMin(inpQuietEnd.value) }, true));
inpClaudeInterval.addEventListener("input", () =>
  commitSettings({ claudeMinIntervalSecs: Number(inpClaudeInterval.value) }),
);
inpPetOpacity.addEventListener("input", () => commitSettings({ petOpacity: Number(inpPetOpacity.value) }));
inpPetIdleFade.addEventListener("change", () => commitSettings({ petIdleFade: inpPetIdleFade.checked }, true));
inpPetSnap.addEventListener("change", () => commitSettings({ petSnapEdge: inpPetSnap.checked }, true));
inpCompact.addEventListener("change", () => commitSettings({ compactAccounts: inpCompact.checked }, true));
inpShowHistory.addEventListener("change", () => {
  commitSettings({ showHistory: inpShowHistory.checked }, true);
  if (inpShowHistory.checked) void refreshHistory(true);
});
selPanelPos.addEventListener("change", () =>
  commitSettings({ panelPosition: selPanelPos.value as PanelPosition }, true),
);

// ---- hotkey recorder
async function showHotkeyStatus() {
  try {
    const err = await invoke<string | null>("hotkey_status");
    hotkeyHint.textContent = err ?? HOTKEY_HINT;
    hotkeyHint.classList.toggle("error", !!err);
  } catch {
    hotkeyHint.textContent = HOTKEY_HINT;
  }
}

function stopRecording() {
  recordingHotkey = false;
  btnHotkey.classList.remove("recording");
  btnHotkey.innerHTML = hotkeyLabel(cfg().hotkey ?? "");
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
  btnHotkey.textContent = "按下組合鍵…";
  hotkeyHint.textContent = HOTKEY_HINT;
  hotkeyHint.classList.remove("error");
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
      btnHotkey.textContent = "按下組合鍵…";
      return;
    }
    if (combo === "") {
      hotkeyHint.textContent = "需要搭配 Ctrl / Alt / Shift / Win（F1～F12 除外）";
      hotkeyHint.classList.add("error");
      return;
    }
    saveHotkey(combo);
  },
  true,
);

// ---- account settings: expand / edit / drag-sort
accSettingsEl.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest(".grip")) return;
  const head = t.closest<HTMLElement>("[data-act='toggle']");
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
  if (f === "alias") setPref(id, { alias: el.value.trim() || null });
  else if (f === "visible") setPref(id, { hidden: !(el as HTMLInputElement).checked });
  else if (f === "score") setPref(id, { excludeScore: !(el as HTMLInputElement).checked });
  else if (f === "th") setPref(id, { notifyThreshold: el.value ? Number(el.value) : null });
});

accSettingsEl.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t.classList.contains("text-input") && e.key === "Enter") t.blur();
});

let drag: { id: string; target: string | null; after: boolean } | null = null;

function clearDropMarks() {
  accSettingsEl
    .querySelectorAll(".drop-before, .drop-after, .dragging")
    .forEach((el) => el.classList.remove("drop-before", "drop-after", "dragging"));
}

// Coordinate-free: the row under the pointer (browser hit-test) takes the dragged
// row's slot. Avoids clientY vs. rect mismatches under the font-size `zoom`.
accSettingsEl.addEventListener("pointerdown", (e) => {
  const grip = (e.target as HTMLElement).closest<HTMLElement>(".grip");
  if (!grip || e.button !== 0) return;
  const row = grip.closest<HTMLElement>(".acc-set")!;
  e.preventDefault();
  drag = { id: row.dataset.id!, target: null, after: false };
  row.classList.add("dragging");
  accSettingsEl.classList.add("sorting");
});

accSettingsEl.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const row = (e.target as HTMLElement).closest<HTMLElement>(".acc-set");
  if (!row) return;
  const rows = Array.from(accSettingsEl.querySelectorAll<HTMLElement>(".acc-set"));
  const from = rows.findIndex((r) => r.dataset.id === drag!.id);
  const to = rows.indexOf(row);
  accSettingsEl.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
  drag.target = row.dataset.id!;
  drag.after = to > from;
  if (to !== from) row.classList.add(drag.after ? "drop-after" : "drop-before");
});

function endDrag() {
  if (!drag) return;
  const { id, target, after } = drag;
  drag = null;
  clearDropMarks();
  accSettingsEl.classList.remove("sorting");
  if (!target || target === id || !currentSnapshot) return;
  const ids = orderedAccounts(currentSnapshot.accounts).map((a) => a.id).filter((x) => x !== id);
  const at = ids.indexOf(target) + (after ? 1 : 0);
  ids.splice(at, 0, id);
  commitSettings({ accountOrder: ids }, true);
}
window.addEventListener("pointerup", endDrag);
window.addEventListener("pointercancel", () => {
  drag = null;
  clearDropMarks();
  accSettingsEl.classList.remove("sorting");
});
inpNotifyTh.addEventListener("input", () => commitSettings({ notifyLowThreshold: Number(inpNotifyTh.value) }));
inpRefreshSec.addEventListener("input", () => commitSettings({ refreshIntervalSecs: Number(inpRefreshSec.value) }));
inpAgExtra.addEventListener("change", () => commitSettings({ showAntigravityExtra: inpAgExtra.checked }, true));
inpAutostart.addEventListener("change", () => commitSettings({ launchAtStartup: inpAutostart.checked }, true));

document.querySelectorAll<HTMLButtonElement>("[data-preview]").forEach((btn) => {
  btn.addEventListener("click", () => {
    invoke("preview_mood", { mood: btn.dataset.preview as CatMood }).catch(() => {});
  });
});

$("btn-test-notify").addEventListener("click", () => {
  invoke("test_notification").catch(() => {});
});

$("btn-quit").addEventListener("click", () => {
  invoke("quit_app").catch(() => {});
});

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (showingSettings) setSettingsVisible(false);
  else invoke("hide_panel").catch(() => {});
});

async function init() {
  await listen<DashboardSnapshot>("snapshot-updated", (event) => renderDashboard(event.payload));

  const existing = await invoke<DashboardSnapshot | null>("get_snapshot");
  if (existing) {
    renderDashboard(existing);
  } else {
    currentSettings = await invoke<AppSettings>("get_settings");
    syncSettingsForm(currentSettings);
  }
}

init().catch(() => {});
