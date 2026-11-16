import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { renderAvatar } from "./themeRenderer";
import type {
  AccountQuota,
  AppSettings,
  CatMood,
  DashboardSnapshot,
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

let currentSnapshot: DashboardSnapshot | null = null;
let currentSettings: AppSettings | null = null;
let showingSettings = false;
let pinned = false;
let miniTick = 0;

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
};

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
    const wins = [...acc.primaryWindows, ...(showExtra ? acc.extraWindows : [])];
    body = wins.length
      ? wins.map((w) => renderWindow(w, acc.provider)).join("")
      : `<span class="status stale">沒有用量資料</span>`;
    if (isStale) {
      note = `<span class="acc-note" title="${escapeHtml(acc.error ?? "")}">${ageLabel(acc.updatedAt)}</span>`;
    }
  }

  return `
    <div class="row acc ${isErr ? "dim" : ""}">
      <span class="p-icon ${acc.provider}">${providerGlyph(acc.provider)}</span>
      <div class="row-main">
        <div class="row-title"><span class="name" title="${escapeHtml(acc.name)}">${escapeHtml(acc.name)}</span>${plan}${note}</div>
        <div class="wins">${body}</div>
      </div>
    </div>`;
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
  renderRings(snap.accounts);

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

  const okCount = snap.accounts.filter((a) => a.status === "ok" || a.status === "stale").length;
  $("accounts-count").textContent = `${okCount}/${snap.accounts.length} 在線`;

  accountsSection.innerHTML =
    snap.accounts.length === 0
      ? `<div class="empty">尚未找到 Claude / Antigravity / ChatGPT 的登入憑證</div>`
      : snap.accounts.map((acc) => renderAccountRow(acc, snap.settings.showAntigravityExtra)).join("");

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
